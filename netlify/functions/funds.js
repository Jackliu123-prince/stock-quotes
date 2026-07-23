// Netlify Function：/api/funds 代理（LOF 基金行情 + 单位净值 + 估值 + 溢价率/套利）
//
// 数据源优先级（按“易获取程度”分流，降低被东财 WAF 拦截/限速的概率）：
//   1) 基金场内价格（买一/卖一/现价/涨跌%）：优先【新浪 hq.sinajs.cn】（GBK），腾讯 qt.gtimg.cn 兜底。
//      东财 push2delay 对基金行情不返回买一/卖一（f162/f167 恒为 0），故价格一律不走东财。
//   2) 指数涨跌：标准 A 股指数（sh/sz 前缀，如沪深300/中证500/国证系列）优先【腾讯】；
//      中证主题(930xxx)及特殊指数（2.H30540、124.HSSCNE、fut_ag 等）腾讯无行情，走【东财 push2delay】
//      镜像域（字段与 push2 一致、沙箱/生产均可返回，secid 由 searchapi 反查得到）。
//      指数涨跌每次请求实时拉取并带 8s 短缓存（≤8s 新鲜、低频不触发东财 WAF）。
//   3) 单位净值：读 nav-data.js 快照（东方财富 lsjz 预先抓取，每日仅变一次，交易时段恒定）；
//      并以非阻塞后台任务每隔数小时静默刷新内存快照。新增基金走“尽力而为”实时兜底。
//
// 估值算法（v2）：估值(estNav) = 单位净值(dwjz) × (1 + 指数涨跌幅(%) / 100 × 仓位系数）
//   仓位系数 POSITION = 0.92（基金预估仓位）。有完整指数映射且单位净值有效时计算，否则回落 "--"。
//
// 关键：所有上游请求带硬超时（AbortController）。单函数 Netlify 免费档 10s 上限，故本接口
// 仅处理单批（前端已按每批 10 只分块并发请求），指数与净值各走独立并发，保证超时前返回。

import iconv from 'iconv-lite';
import { NAV_SNAPSHOT } from './nav-data.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 上游硬超时（毫秒）。净值/指数每路留足余量，避免 10s 函数超时拖垮整体。
const UPSTREAM_TIMEOUT = 3500;

function fetchWithTimeout(url, options = {}, ms = UPSTREAM_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// 基金代码 -> 指数 secid（用于拉取真实指数涨跌幅）。
// 权威源：桌面《基金与指数对应表0721.xlsm》——含基金代码、基金名称、跟踪指数名称、指数代码、带前缀指数代码。
// 该表同时给出指数代码/带前缀代码，从根本上避免“同名指数不同代码”导致的错配。
// 换算规则（与 toEmSecid 对齐）：sh/sz 前缀 → 腾讯行情(易取)；zz/H 前缀 → 东财 push2delay(CSI 定制，市场码 2.)；
//   hsscne → 124.hsscne(港股通)；fut_ag → 白银期货(无指数名)。
// 每只的 secid 均已用东方财富 push2delay 核实：返回的指数名与表中“跟踪指数名称”一致方采用。
// 极少数标普/定制指数(如 501029 标普红利机会、167301 保险主题历史值)东财不返回数据 → 估值显示 "--"。
// 新增基金：在表中确认带前缀指数代码后，按上述规则追加 基金代码: 'secid' 即可。
const FUND_INDEX_SECID = {
  "160119": "sh000905",
  "160135": "sz399807",
  "160218": "sz399393",
  "160219": "sz399394",
  "160221": "sz399395",
  "160222": "sz399396",
  "160223": "sz399006",
  "160225": "sz399417",
  "160615": "sh000300",
  "160616": "sh000905",
  "160620": "sh000805",
  "160625": "sz399966",
  "160626": "sh000993",
  "160628": "sz399965",
  "160629": "sz399971",
  "160630": "sz399973",
  "160631": "sz399986",
  "160632": "sz399987",
  "160633": "sz399975",
  "160635": "sh000933",
  "160637": "sz399006",
  "160638": "sz399991",
  "160639": "sz399807",
  "160643": "2.930875",
  "160706": "sh000300",
  "160716": "sh000925",
  "160806": "sh000906",
  "160807": "sh000300",
  "161017": "sh000905",
  "161024": "sz399967",
  "161025": "sz399970",
  "161026": "sz399974",
  "161027": "sz399975",
  "161028": "sz399976",
  "161029": "sz399986",
  "161030": "sz399804",
  "161031": "sz399803",
  "161032": "sz399998",
  "161033": "2.930721",
  "161035": "2.930791",
  "161036": "2.930790",
  "161037": "2.930820",
  "161039": "sh000852",
  "161118": "sz399005",
  "161121": "sz399986",
  "161122": "sz399993",
  "161123": "sz399992",
  "161217": "sh000961",
  "161226": "fut_ag",
  "161227": "sz399330",
  "161607": "sz399313",
  "161631": "2.930713",
  "161715": "sh000979",
  "161720": "sz399975",
  "161724": "sz399990",
  "161725": "sz399997",
  "161726": "sz399441",
  "161811": "sh000300",
  "161812": "sz399330",
  "161816": "sh000971",
  "162216": "sh000905",
  "162307": "sh000903",
  "162412": "sz399989",
  "162509": "sh000903",
  "162711": "sh000905",
  "163109": "sz399001",
  "163111": "sz399005",
  "163113": "sz399707",
  "163114": "sh000827",
  "163115": "sz399967",
  "163116": "sz399811",
  "163118": "sh000808",
  "163407": "sh000300",
  "163821": "sh000984",
  "164508": "sh000903",
  "165309": "sh000300",
  "165511": "sh000905",
  "165515": "sh000300",
  "165519": "sh000841",
  "165520": "sh000823",
  "165521": "sh000974",
  "165522": "sh000998",
  "165525": "sz399995",
  "167301": "sz399809",
  "168203": "sz399440",
  "168204": "sz399998",
  "168701": "sz399699",
  "501005": "2.930719",
  "501007": "2.930720",
  "501008": "2.930720",
  "501009": "2.930743",
  "501010": "2.930743",
  "501011": "2.930641",
  "501012": "2.930641",
  "501016": "sz399707",
  "501019": "sz399368",
  "501029": "2.818001",
  "501030": "sz399806",
  "501031": "sz399806",
  "501036": "sh000905",
  "501037": "sh000905",
  "501043": "sh000300",
  "501045": "sh000300",
  "501047": "sz399975",
  "501048": "sz399975",
  "501050": "2.950090",
  "501057": "2.930997",
  "501058": "2.930997",
  "501059": "sh000824",
  "501089": "2.H30094",
  "501090": "2.931068",
  "501311": "124.hsscne",
  "502000": "sh000905",
  "502003": "sz399967",
  "502006": "sz399974",
  "502010": "sz399975",
  "502013": "2.930620",
  "502023": "sz399440",
  "502048": "sh000016",
  "502053": "sz399975",
  "502056": "sz399989",
};

// 指数 secid -> 展示用的完整指数名（覆盖东财 push2delay 返回的广告式简称，如“800非银”）
const INDEX_NAME_OVERRIDE = {
  "2.H30094": "中证消费红利",
  "2.818001": "标普中国A股红利机会指数",
  "0.399809": "中证方正富邦保险主题指数",
  "124.hsscne": "恒生港股通新经济指数",
  "2.950090": "上证50AH优选指数",
  "2.931068": "中证消费龙头指数",
};

// ============ 缓存 ============
const cache = new Map();
const TTL = { tencent: 3000, index: 8000 };
function getCached(key, ttl) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < ttl) return c.data;
  return null;
}
function setCached(key, data) { cache.set(key, { ts: Date.now(), data }); }

// ============ 腾讯基金/股票行情（GBK） —— 兜底源 ============
// 返回标准化对象：{ name, price, bid, ask, prevClose, date, time, changePct }
// 字段（~ 分隔）：p[1]=名称, p[3]=现价, p[4]=昨收, p[9]=买一, p[11]=卖一, p[30]=日期, p[31]=时间, p[32]=涨跌%
async function fetchTencent(symbols) {
  if (!symbols.length) return {};
  const key = 'tencent:' + symbols.join(',');
  const hit = getCached(key, TTL.tencent);
  if (hit) return hit;
  const url = 'https://qt.gtimg.cn/q=' + symbols.join(',');
  const res = await fetchWithTimeout(url, { headers: { Referer: 'https://finance.qq.com/', 'User-Agent': UA } });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = iconv.decode(buf, 'gbk');
  const out = {};
  const re = /v_(\w+)="([^"]*)";/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[2].split('~');
    if (p.length < 33) continue;
    const price = parseFloat(p[3]);
    const bid = parseFloat(p[9]);
    const ask = parseFloat(p[11]);
    const prevClose = parseFloat(p[4]) || 0;
    const changePct = p[32] !== undefined && !isNaN(parseFloat(p[32]))
      ? parseFloat(p[32]) : (prevClose ? (price - prevClose) / prevClose * 100 : 0);
    if (isNaN(price) || isNaN(bid) || isNaN(ask)) continue;
    out[m[1]] = { name: p[1], name2: p[1], price, bid, ask, prevClose, date: p[30] || '', time: p[31] || '', changePct };
  }
  setCached(key, out);
  return out;
}

// ============ 新浪基金/股票行情（GBK） —— 基金价格主源 ============
// 返回标准化对象（同 fetchTencent 形状）。字段（, 分隔，基金含五档盘口）：
//   p[0]=名称, p[2]=昨收, p[3]=现价, p[6]=买一(竞买价), p[7]=卖一(竞卖价)
//   说明：新浪基金 p[7]（竞卖价）通常等于现价、并非严格五档卖一价；精确卖一优先由腾讯 p[11] 提供，
//        新浪 p[7] 仅作兜底（至少满足 卖一≈现价 ≥ 买一，不会低于买一）。故不再使用 p[13]（实为买三价）。
async function fetchSina(symbols) {
  if (!symbols.length) return {};
  const key = 'sina:' + symbols.join(',');
  const hit = getCached(key, TTL.tencent);
  if (hit) return hit;
  const url = 'https://hq.sinajs.cn/list=' + symbols.join(',');
  const res = await fetchWithTimeout(url, { headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': UA } });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = iconv.decode(buf, 'gbk');
  const out = {};
  const re = /hq_str_(\w+)="([^"]*)";/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[2].split(',');
    if (p.length < 14) continue;
    const price = parseFloat(p[3]);
    const bid = parseFloat(p[6]);     // 买一（竞买价）
    const ask = parseFloat(p[7]);     // 卖一（竞卖价/现价近似；精确卖一优先走腾讯 p[11]）
    const prevClose = parseFloat(p[2]) || 0;
    if (isNaN(price) || isNaN(bid) || isNaN(ask)) continue;
    const changePct = prevClose ? (price - prevClose) / prevClose * 100 : 0;
    out[m[1]] = { name: p[0], price, bid, ask, prevClose, date: p[30] || '', time: p[31] || '', changePct };
  }
  setCached(key, out);
  return out;
}

// ============ 单位净值（快照 + 后台静默刷新） ============
// 单位净值每日仅收盘后更新一次，交易时段内恒定。若每次刷新都向东财 lsjz 爆发请求，
// 极易触发限流，导致随机若干基金取不到净值（且被 30s 负缓存放大）。故改为：
//   - 启动时读 nav-data.js 快照（覆盖全部默认基金，永远有净值，瞬间返回）；
//   - 非阻塞后台任务每隔数小时静默把东财最新净值合并进内存快照（兼顾新鲜度）；
//   - 快照未覆盖的新增基金走“尽力而为”的实时获取兜底（失败回落 --，不污染快照）。
async function fetchFundNavLsjz(code) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=2`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Referer: 'https://fundf10.eastmoney.com/' } });
  const j = await res.json();
  const list = j && j.Data && j.Data.LSJZList;
  if (!list || !list.length || !list[0].DWJZ) return null;
  const row = list[0];
  const prev = list[1];
  return {
    dwjz: row.DWJZ, jzrq: row.FSRQ || null,
    prevDwjz: prev && prev.DWJZ ? prev.DWJZ : null,
    prevJzrq: prev && prev.FSRQ ? prev.FSRQ : null
  };
}
function fetchFundNavLive(code) {
  return fetchFundNavLsjz(code).catch(() => null);
}
let navSnapshot = Object.assign({}, NAV_SNAPSHOT);
let lastNavRefresh = 0;
function refreshNavInBackground() {
  const now = Date.now();
  if (now - lastNavRefresh < 3 * 3600 * 1000) return;
  lastNavRefresh = now;
  (async () => {
    const codes = Object.keys(navSnapshot);
    let i = 0;
    async function worker() {
      while (i < codes.length) {
        const code = codes[i++];
        const r = await fetchFundNavLive(code).catch(() => null);
        if (r) navSnapshot[code] = r;
        await new Promise(res => setTimeout(res, 80));
      }
    }
    try { await Promise.all(Array.from({ length: Math.min(4, codes.length) }, worker)); }
    catch (e) {}
  })();
}
async function getNav(code) {
  if (navSnapshot[code]) return navSnapshot[code];
  const r = await fetchFundNavLive(code).catch(() => null); // 新增基金：尽力实时兜底
  if (r) navSnapshot[code] = r;
  return r;
}

// ============ 指数涨跌幅（东方财富 push2delay 镜像，字段与 push2 一致） ============
// secid -> { name, changePct }。changePct = f170/100（f170 为涨跌幅×100）。
// 将腾讯风格前缀(sh/sz/hk)转换为东财 push2delay 所需的数字前缀(1./0./124.)
// 原 FUND_INDEX_SECID 中大量条目使用 sh/sz 前缀（腾讯风格），但东财 push2delay 只认
// 1.XXXXXX / 0.XXXXXX 这种数字市场码，直接传 sh000905 会返回空。故在此统一转换。
function toEmSecid(secid) {
  if (!secid) return secid;
  // 中证主题指数(930xxx)在东财属于 CSI 市场，前缀为 2.（非 sh 对应的 1.）
  const m = /^(sh|sz)(\d{6})$/.exec(secid);
  if (m) {
    const code = m[2];
    if (code.startsWith('930')) return '2.' + code;   // 中证主题指数：CSI 市场
    if (m[1] === 'sh') return '1.' + code;            // 上证/沪深300/中证500等
    if (m[1] === 'sz') return '0.' + code;            // 深证/国证/399xxx 系列
  }
  if (secid.startsWith('hk')) return '124.' + secid.slice(2);
  return secid; // 已是东财格式：1.x / 0.x / 2.x / 124.x / fut_ag
}
async function fetchEastmoneyIndex(secid) {
  const emSecid = toEmSecid(secid);
  const key = 'idx:' + emSecid;
  const hit = getCached(key, TTL.index);
  if (hit) return hit;
  // 失败重试一次（规避东财批量/偶发抖动），仍失败则不缓存、返回 null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(emSecid)}&fields=f12,f13,f14,f43,f58,f169,f170`;
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } });
      const j = await res.json();
      const d = j && j.data;
      if (d && d.f170 !== undefined) {
        const out = { name: INDEX_NAME_OVERRIDE[secid] || d.f58 || null, changePct: parseFloat(d.f170) / 100 };
        setCached(key, out);
        return out;
      }
    } catch (e) { /* 重试 */ }
    await new Promise(r => setTimeout(r, 120));
  }
  return null;
}

// A 股标准指数 secid -> 腾讯代码（兜底用）。支持东财数字前缀(1./0.)与腾讯前缀(sh/sz/hk)互转；
// 2.x / 124.x / fut_ag 等非 A 股标准特殊指数腾讯无对应行情，返回 null（不适用兜底）。
function secidToTencent(secid) {
  if (!secid) return null;
  if (secid.startsWith('sh') || secid.startsWith('sz') || secid.startsWith('hk')) return secid;
  const m = /^(\d+)\.(\w+)$/.exec(secid);
  if (!m) return null;
  if (m[1] === '1') return 'sh' + m[2];
  if (m[1] === '0') return 'sz' + m[2];
  return null; // 2.x / 124.x / fut_ag 等特殊指数无腾讯兜底
}
async function fetchTencentIndex(codes) {
  if (!codes.length) return {};
  const key = 'tidx:' + codes.join(',');
  const hit = getCached(key, TTL.index);
  if (hit) return hit;
  let text = '';
  // 失败重试一次（规避腾讯批量响应偶发截断/丢符号）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = 'https://qt.gtimg.cn/q=' + codes.join(',');
      const res = await fetchWithTimeout(url, { headers: { Referer: 'https://finance.qq.com/', 'User-Agent': UA } });
      const buf = Buffer.from(await res.arrayBuffer());
      text = iconv.decode(buf, 'gbk');
      if (text.includes('=')) break;
    } catch (e) { /* 重试 */ }
    await new Promise(r => setTimeout(r, 120));
  }
  const out = {};
  const re = /v_(\w+)="([^"]*)";/g; let m;
  while ((m = re.exec(text))) {
    const p = m[2].split('~');
    const price = parseFloat(p[3]); const prev = parseFloat(p[4]) || 0;
    const chg = p[32] !== undefined && !isNaN(parseFloat(p[32]))
      ? parseFloat(p[32]) : (prev ? (price - prev) / prev * 100 : null);
    out[m[1]] = { name: p[1] || null, changePct: chg };
  }
  setCached(key, out);
  return out;
}

// 判断某 secid 是否属于“难获取”指数（必须走东财 push2delay）：
//   - 中证主题指数(代码以 930 开头，如 sh930790 / 2.930875)
//   - 已是东财数字格式(1.x / 0.x / 2.x / 124.x)，多为中证细分，腾讯无对应符号
//   - 白银期货 fut_ag、方正富邦保险 2.H30540、港股通新经济 124.HSSCNE 等特殊指数
// 其余 sh/sz 标准 A 股指数（沪深300/中证500/国证399系列等）易于获取，优先腾讯。
function isHardIndex(secid) {
  if (!secid) return false;
  if (secid === 'fut_ag') return true;
  if (/^\d+\.[A-Za-z0-9]/.test(secid)) return true;   // 东财数字格式：1.x / 0.x / 2.x(含 2.Hxxxx 定制) / 124.x
  const m = /^(sh|sz)(\d{6})$/.exec(secid);
  if (m && m[2].startsWith('930')) return true;     // 中证主题指数（腾讯无行情）
  return false;
}

// 指数涨跌% 走“每次请求实时拉取 + 8s 短缓存”：
//   - 每次刷新都现网拉取（易取走腾讯、难取走东财 push2delay），保证数据永远 ≤8s 新鲜、不会卡成陈旧值；
//   - 两个 fetcher 内部已用 getCached(TTL.index=8s) 缓存，8 秒内重复请求不重复打东财/腾讯；
//   - 难取指数(东财)并发受限(≤5)避免冷启动突发被限流；整体调用量极低，不会触发东财 WAF。
async function mapWithConc(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
async function fetchAllIndexChanges(secids) {
  const uniq = [...new Set(secids.filter(Boolean))];
  const result = new Map();
  const hard = uniq.filter(isHardIndex);
  const easy = uniq.filter(s => !isHardIndex(s));

  // 易获取指数：腾讯（一次调用拿全部，内部 8s 缓存）
  const tCodes = easy.map(secidToTencent).filter(Boolean);
  if (tCodes.length) {
    const tIdx = await fetchTencentIndex(tCodes).catch(() => ({}));
    for (const s of easy) {
      const tc = secidToTencent(s);
      if (tc && tIdx[tc]) result.set(s, tIdx[tc]);
    }
  }
  // 难获取指数：东财 push2delay（并发受限 ≤5 + 内部 8s 缓存，避免冷启动突发被限流）
  const hardResults = await mapWithConc(hard, 5, async (s) => {
    const r = await fetchEastmoneyIndex(s).catch(() => {}) || null;
    return r ? { s, r } : null;
  });
  for (const hr of hardResults) if (hr) result.set(hr.s, hr.r);

  // 兜底：对首次批量未取到的指数，短暂停顿后【逐只单独】重试（规避批量响应偶发截断/丢符号）
  const missing = uniq.filter(s => !result.get(s));
  if (missing.length) {
    await new Promise(r => setTimeout(r, 180));
    await Promise.all(missing.map(async (s) => {
      if (isHardIndex(s)) {
        const r = await fetchEastmoneyIndex(s).catch(() => null);
        if (r) result.set(s, r);
      } else {
        const tc = secidToTencent(s);
        if (tc) {
          const r = await fetchTencentIndex([tc]).catch(() => ({}));
          if (r[tc]) result.set(s, r[tc]);
        }
      }
    }));
  }
  return result;
}

// ============ 盘口报价择优 ============
// 选盘口报价：优先腾讯（字段规范，p[9]=买一、p[11]=卖一 为真实五档价）；
// 硬性要求 卖一(ask) ≥ 买一(bid)（盘口基本约束，否则视为字段错位/收盘失真而失效）；
// 两源均不满足时退而求其次（取有值的一方，避免整行缺失），仍都缺则返回 null（前端回落“行情获取失败”）。
function pickQuote(sq, tq) {
  const ok = q => q && q.bid > 0 && q.ask > 0 && q.ask >= q.bid - 1e-9;
  if (ok(tq)) return tq;
  if (ok(sq)) return sq;
  if (sq && sq.bid > 0 && sq.ask > 0) return sq;
  if (tq && tq.bid > 0 && tq.ask > 0) return tq;
  return null;
}

// ============ 业务：基金数据 ============
// 基金预估仓位系数：指数涨跌按此比例折算到基金净值（0.92 = 92% 预估仓位）
const POSITION = 0.92;

async function getFundData(symbols) {
  if (!symbols.length) return [];
  // 基金价格主源 = 新浪；腾讯作兜底（两者均为易获取源，东财对基金不返回买一/卖一）
  const [sina, tencent] = await Promise.all([fetchSina(symbols), fetchTencent(symbols)]);
  const quotes = {};
  for (const s of symbols) {
    quotes[s] = pickQuote(sina[s], tencent[s]);
  }
  // 兜底重试：个别标的在批量响应中被偶发截断/限速时，短暂停顿后【逐只】单独向两侧各取一次（规避大批量响应截断）
  const missing = symbols.filter(s => !quotes[s]);
  if (missing.length) {
    await new Promise(r => setTimeout(r, 200));
    await Promise.all(missing.map(async s => {
      const [sq, tq] = await Promise.all([fetchSina([s]), fetchTencent([s])]);
      const q = pickQuote(sq[s], tq[s]);
      if (q) quotes[s] = q;
    }));
  }
  const funds = symbols.map(s => ({ symbol: s, code: s.replace(/^(sh|sz|hk)/, '') }));
  const navMap = new Map();
  await Promise.all(funds.map(async f => { navMap.set(f.code, await getNav(f.code)); }));

  // 指数涨跌%：每次请求实时拉取（易取走腾讯、难取走东财 push2delay），fetcher 内部 8s 缓存保证既新鲜又不频发请求
  const needSecids = [...new Set(funds.map(f => FUND_INDEX_SECID[f.code]).filter(Boolean))];
  const idxMap = await fetchAllIndexChanges(needSecids);

  return symbols.map((symbol) => {
    const code = symbol.replace(/^(sh|sz|hk)/, '');
    const q = quotes[symbol];
    if (!q || !q.name || isNaN(q.price) || q.price <= 0) {
      return { code, symbol, name: code, error: true };
    }
    const name = q.name;
    const price = q.price;
    const prevClose = q.prevClose || 0;
    const chgPct = (q.changePct !== undefined && !isNaN(q.changePct))
      ? q.changePct : (prevClose ? (price - prevClose) / prevClose * 100 : 0);
    const bid = q.bid;
    const ask = q.ask;
    const date = q.date || '';
    const time = q.time || '';

    const est = navMap.get(code);
    let dwjz = null, navDate = null, prevDwjz = null;
    if (est) {
      dwjz = parseFloat(est.dwjz);
      navDate = est.jzrq || null;
      prevDwjz = est.prevDwjz ? parseFloat(est.prevDwjz) : null;
    }

    // 指数涨跌幅
    let indexChangePct = null, indexNm = null;
    const secid = FUND_INDEX_SECID[code];
    if (secid) {
      const idx = idxMap.get(secid);
      if (idx) { indexChangePct = idx.changePct; indexNm = idx.name; }
    }

    // 估值（v2）= 单位净值 × (1 + 指数涨跌幅(%) / 100 × 仓位系数)
    let estNav = null;
    if (dwjz && dwjz > 0 && indexChangePct !== null && !isNaN(indexChangePct)) {
      estNav = dwjz * (1 + (indexChangePct / 100) * POSITION);
    }

    // 溢价率以估值为基准（估值缺失则退回单位净值）
    const liveVal = (estNav && estNav > 0) ? estNav : (dwjz || 0);
    const hasLive = liveVal > 0;
    const premiumNow = hasLive ? (price - liveVal) / liveVal * 100 : null;
    const bidPremium = hasLive ? (bid - liveVal) / liveVal * 100 : null;
    const askDiscount = hasLive ? (ask - liveVal) / liveVal * 100 : null;

    return {
      code, symbol, name,
      price, changePct: chgPct, bid, ask,
      dwjz, gsz: null, gztime: null, navDate, prevDwjz,
      estNav,
      premiumNow, bidPremium, askDiscount,
      indexNm, indexChangePct, indexProxy: false,
      date, time
    };
  });
}

// ============ 工具 ============
function normalizeSymbol(input) {
  input = (input || '').trim().toLowerCase();
  if (!input) return null;
  if (/^(sh|sz|hk)\d/.test(input)) return input;
  if (/^\d{6}$/.test(input)) return (/^([56])/.test(input) ? 'sh' : 'sz') + input;
  return null;
}

// ============ Netlify Function 入口 ============
export async function handler(event, context) {
  try {
    const params = event.queryStringParameters || {};
    const raw = (params.symbols || '').split(',');
    const symbols = [...new Set(raw.map(normalizeSymbol).filter(Boolean))];
    refreshNavInBackground();      // 非阻塞：每隔数小时静默刷新内存净值快照（净值每日仅变一次，保留快照）
    const data = await getFundData(symbols);
    return {
      statusCode: 200,
      status: 'ok',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ updated: Date.now(), data })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: String((e && e.message) || e) })
    };
  }
}

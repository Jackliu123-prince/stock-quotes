// Netlify Function：/api/funds 代理（LOF 基金行情 + 单位净值 + 估值 + 溢价率/套利）
// 行情源：腾讯财经 qt.gtimg.cn（GBK，iconv-lite 解码）—— 基金场内价格（买一/卖一/现价）
// 净值源：东方财富 api.fund.eastmoney.com/f10/lsjz（权威单位净值 dwjz，含前一交易日）
// 指数涨跌源：东方财富 push2delay.eastmoney.com（镜像域，字段与 push2 一致、沙箱/生产均可返回）
//            特殊指数（白银期货 fut_ag、港股通新经济 124.HSSCNE、AH优选 2.H50001、方正富邦保险 2.H30540）
//            也走 push2delay（secid 由 searchapi 反查得到）。A 股标准指数另加腾讯兜底。
//
// 估值新算法：估值(estNav) = 单位净值(dwjz) × (1 + 指数涨跌幅%)，不再依赖东方财富实时估算接口
// （fundgz 实时估值已无法直接获取）。有完整指数映射且单位净值有效时计算，否则回落 "--"。
//
// 关键：所有上游请求带硬超时（AbortController）。单函数 Netlify 免费档 10s 上限，故本接口
// 仅处理单批（前端已按每批 10 只分块并发请求），指数与净值各走独立并发，保证超时前返回。

import iconv from 'iconv-lite';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 上游硬超时（毫秒）。净值/指数每路留足余量，避免 10s 函数超时拖垮整体。
const UPSTREAM_TIMEOUT = 3500;

function fetchWithTimeout(url, options = {}, ms = UPSTREAM_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// 基金代码 -> 东方财富指数 secid（用于拉取真实指数涨跌幅）。
// 由 Excel（指数LOF代码.xlsx）导出基金→跟踪指数名，再用腾讯行情 + 东财 SH 列表逐一定位 secid 校验得到。
// 仅指数型 LOF 有单一跟踪指数；部分无法通过权威源定位代码的指数（如国证医药卫生、中证A股资源等）
// 留空，相关基金估值列显示 "--"（宁可缺失也不给错值）。
// 新增指数型 LOF 时：在此追加 基金代码: '东财secid' 即可（sh 指数→1.XXXXXX，sz 指数→0.XXXXXX）。
const FUND_INDEX_SECID = {
  "160119": "sh000905",
  "160135": "sz399807",
  "160218": "sz399393",
  "160221": "sz399395",
  "160222": "sz399396",
  "160223": "sz399006",
  "160225": "sz399417",
  "160615": "sh000300",
  "160616": "sh000905",
  "160626": "sh000993",
  "160628": "sz399965",
  "160629": "sz399971",
  "160630": "sz399973",
  "160631": "sz399986",
  "160632": "sz399987",
  "160633": "sz399975",
  "160635": "sh000808",
  "160637": "sz399006",
  "160638": "sz399991",
  "160639": "sz399807",
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
  "161033": "sz399432",
  "161035": "sh000808",
  "161036": "sh930790",
  "161037": "sh930820",
  "161039": "sh000852",
  "161118": "sz399005",
  "161121": "sz399986",
  "161122": "sz399993",
  "161123": "sz399992",
  "161226": "fut_ag",
  "161227": "sz399330",
  "161607": "sz399313",
  "161631": "sh930713",
  "161715": "sz399979",
  "161720": "sz399975",
  "161724": "sz399998",
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
  "164508": "sh000903",
  "165309": "sh000300",
  "165511": "sh000905",
  "165515": "sh000300",
  "165521": "sh000931",
  "165522": "sh000998",
  "165525": "sz399995",
  "167301": "2.H30540",
  "168203": "sz399440",
  "168204": "sz399998",
  "168701": "sz399699",
  "501005": "sh930719",
  "501007": "sh930720",
  "501008": "sh930720",
  "501009": "sh930743",
  "501010": "sh930743",
  "501011": "sh930641",
  "501012": "sh930641",
  "501016": "sz399707",
  "501019": "sz399368",
  "501030": "sz399806",
  "501031": "sz399806",
  "501036": "sh000905",
  "501037": "sh000905",
  "501043": "sh000300",
  "501045": "sh000300",
  "501047": "sz399975",
  "501048": "sz399975",
  "501050": "sh000170",
  "501057": "sz399976",
  "501058": "sz399976",
  "501059": "sh000824",
  "501089": "sh000932",
  "501090": "sh000932",
  "501311": "124.HSSCNE",
  "502000": "sh000905",
  "502003": "sz399967",
  "502006": "sz399974",
  "502010": "sz399975",
  "502013": "sz399991",
  "502023": "sz399440",
  "502048": "sh000016",
  "502053": "sz399975",
  "502056": "sz399989",
  // —— 补回的中证主题指数（zz 前缀）——
  "165519": "1.000841", // 中证800制药与生物科技
  "160625": "0.399966", // 中证800证券保险
  "160643": "2.930875", // 中证空天一体军工
  "165520": "1.000823", // 中证800有色金属
  "161217": "1.000961", // 中证上游资源产业
  "160620": "1.000805"  // 中证A股资源产业
};

// 指数 secid -> 展示用的完整指数名（覆盖东财 push2delay 返回的广告式简称，如“800非银”）
const INDEX_NAME_OVERRIDE = {
  "1.000841": "中证800制药与生物科技",
  "0.399966": "中证800证券保险",
  "2.930875": "中证空天一体军工",
  "1.000823": "中证800有色金属",
  "1.000961": "中证上游资源产业",
  "1.000805": "中证A股资源产业"
};

// ============ 缓存 ============
const cache = new Map();
const TTL = { tencent: 3000, fundNav: 30000, index: 8000 };
function getCached(key, ttl) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < ttl) return c.data;
  return null;
}
function setCached(key, data) { cache.set(key, { ts: Date.now(), data }); }

// ============ 腾讯基金/股票行情（GBK） ============
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
  while ((m = re.exec(text))) out[m[1]] = m[2].split('~');
  setCached(key, out);
  return out;
}

// ============ 东方财富 单位净值 ============
async function fetchFundNavLsjz(code) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=2`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Referer: 'https://fundf10.eastmoney.com/' } });
  const j = await res.json();
  const list = j && j.Data && j.Data.LSJZList;
  if (!list || !list.length || !list[0].DWJZ) return null;
  const row = list[0];
  const prev = list[1];
  return {
    dwjz: row.DWJZ, jzrq: row.FSRQ,
    prevDwjz: prev && prev.DWJZ ? prev.DWJZ : null,
    prevJzrq: prev && prev.FSRQ ? prev.FSRQ : null
  };
}
async function fetchFundNav(code) {
  const key = 'nav:' + code;
  const cached = getCached(key, TTL.fundNav);
  if (cached) return cached.__neg ? null : cached;
  const nav = await fetchFundNavLsjz(code).catch(() => null);
  if (!nav) { setCached(key, { __neg: true }); return null; }
  setCached(key, nav);
  return nav;
}
async function fetchAllNav(funds, limit = 10) {
  const map = new Map();
  let i = 0;
  async function worker() {
    while (i < funds.length) {
      const f = funds[i++];
      map.set(f.code, await fetchFundNav(f.code).catch(() => null));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, funds.length) }, worker));
  return map;
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
  const url = `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(emSecid)}&fields=f12,f13,f14,f43,f58,f169,f170`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } });
  const j = await res.json();
  const d = j && j.data;
  if (!d || d.f170 === undefined) { setCached(key, null); return null; }
  const out = { name: INDEX_NAME_OVERRIDE[secid] || d.f58 || null, changePct: parseFloat(d.f170) / 100 };
  setCached(key, out);
  return out;
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
  const url = 'https://qt.gtimg.cn/q=' + codes.join(',');
  const res = await fetchWithTimeout(url, { headers: { Referer: 'https://finance.qq.com/', 'User-Agent': UA } });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = iconv.decode(buf, 'gbk');
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

// 并发受限批量获取指数涨跌幅。优先东财 push2delay；失败的 A 股标准 secid 用腾讯兜底。
async function fetchAllIndexChanges(secids, limit = 6) {
  const uniq = [...new Set(secids.filter(Boolean))];
  const result = new Map();
  // 第一轮：东财 push2delay。两请求间加微小延迟，降低被限速概率（腾讯兜底作保底）。
  let i = 0;
  async function worker() {
    while (i < uniq.length) {
      const s = uniq[i++];
      const r = await fetchEastmoneyIndex(s).catch(() => null);
      if (r) result.set(s, r);
      await new Promise(res => setTimeout(res, 120));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, uniq.length) }, worker));

  // 第二轮：未命中的 A 股标准 secid 用腾讯兜底
  const missing = uniq.filter(s => !result.has(s));
  const tCodes = missing.map(secidToTencent).filter(Boolean);
  if (tCodes.length) {
    const tIdx = await fetchTencentIndex(tCodes).catch(() => ({}));
    for (const s of missing) {
      const tc = secidToTencent(s);
      if (tc && tIdx[tc]) result.set(s, tIdx[tc]);
    }
  }
  return result;
}

// ============ 业务：基金数据 ============
async function getFundData(symbols) {
  if (!symbols.length) return [];
  const quotes = await fetchTencent(symbols);
  const funds = symbols.map(s => ({ symbol: s, code: s.replace(/^(sh|sz|hk)/, '') }));
  const estMap = await fetchAllNav(funds);

  // 收集本批需要的指数 secid，批量拉涨跌幅（东财优先 + 腾讯兜底）
  const needSecids = [...new Set(funds.map(f => FUND_INDEX_SECID[f.code]).filter(Boolean))];
  const idxMap = await fetchAllIndexChanges(needSecids);

  return symbols.map((symbol) => {
    const code = symbol.replace(/^(sh|sz|hk)/, '');
    const q = quotes[symbol];
    if (!q || !q[1] || !q[3] || isNaN(parseFloat(q[3]))) {
      return { code, symbol, name: code, error: true };
    }
    const name = q[1];
    const price = parseFloat(q[3]);
    const prevClose = parseFloat(q[4]) || 0;
    const chgPct = q[32] !== undefined && !isNaN(parseFloat(q[32]))
      ? parseFloat(q[32]) : (prevClose ? (price - prevClose) / prevClose * 100 : 0);
    const bid = parseFloat(q[9]) || 0;
    const ask = parseFloat(q[11]) || 0;
    const date = q[30] || '';
    const time = q[31] || '';

    const est = estMap.get(code);
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

    // 估值（新算法）= 单位净值 × (1 + 指数涨跌幅%)；指数或净值缺失则回落 null
    let estNav = null;
    if (dwjz && dwjz > 0 && indexChangePct !== null && !isNaN(indexChangePct)) {
      estNav = dwjz * (1 + indexChangePct / 100);
    }

    // 溢价率以估值为基准（估值缺失则退回单位净值）
    const liveVal = (estNav && estNav > 0) ? estNav : (dwjz || 0);
    const premiumNow = liveVal ? (price - liveVal) / liveVal * 100 : null;
    const bidPremium = liveVal ? (bid - liveVal) / liveVal * 100 : null;
    const askDiscount = liveVal ? (ask - liveVal) / liveVal * 100 : null;

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

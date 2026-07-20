// Netlify Function：/api/funds 代理（LOF 基金行情 + 净值/估值 + 溢价率/套利）
// 由 netlify.toml 的 redirect 把 /api/funds 映射到 /.netlify/functions/funds
// 行情源：腾讯财经 qt.gtimg.cn（GBK，需用 iconv-lite 解码）
// 净值源：东方财富 fundgz（实时估值）+ api.fund.eastmoney.com/f10/lsjz（权威最新净值，含前一交易日用于指数近似）
// 自选页与 LOF 基金页共用本接口（两者数据形态一致，LOF 页多一列跟踪指数）。
//
// 关键：所有上游请求都带硬超时（AbortController）。东方财富部分接口从 Netlify 服务器环境
// 可能拖慢/挂起，一旦挂起会在免费档 10s 函数超时内把整个请求拖垮 → 500。加超时后挂起即快速
// 失败并降级（净值/溢价置空），保证函数始终能在超时前返回价格数据。

import iconv from 'iconv-lite';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 上游硬超时（毫秒）。Netlify 免费档函数超时为 10s，这里给每路请求留足余量。
const UPSTREAM_TIMEOUT = 3500;

// 带超时的 fetch（挂起即 abort，转为 rejected，由调用方 .catch 降级）
function fetchWithTimeout(url, options = {}, ms = UPSTREAM_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// 已知 LOF 基金 → 跟踪指数（腾讯指数代码）。用于拉取“真实指数涨跌幅”。
// 仅指数型 LOF 有单一跟踪指数；主动管理型无对应指数，相关列显示 "--"。
// 新增指数型 LOF 时，在此追加 基金代码: 指数腾讯代码 即可（如 沪深300 sh000300 / 创业板指 sz399006）。
const FUND_INDEX_CODE = {
  '501036': 'sh000905',
  '162711': 'sh000905',
  '160807': 'sh000300',
  '163111': 'sz399005',
  '162307': 'sh000903',
  '501019': 'sz399368',
  '160626': 'sh000993',
  '161812': 'sz399330',
  '160616': 'sh000905',
  '161017': 'sh000905',
  '161033': 'sz399432',
  '501043': 'sh000300',
  '160119': 'sh000905',
  '160223': 'sz399006',
  '163118': 'sh000808',
  '161039': 'sh000852',
  '160225': 'sz399417',
  '501045': 'sh000300',
  '160630': 'sz399973',
  '163407': 'sh000300',
  '165511': 'sh000905',
  '502048': 'sh000016',
  '161024': 'sz399967',
  '163109': 'sz399001',
  '165515': 'sh000300',
  '160706': 'sh000300',
  '161123': 'sz399992',
  '502023': 'sz399440',
  '161028': 'sz399976',
  '161227': 'sz399330',
  '160638': 'sz399991',
  '501037': 'sh000905',
  '161026': 'sz399974',
  '501016': 'sz399707',
  '165525': 'sz399995',
  '160637': 'sz399006',
  '165522': 'sh000998',
  '502003': 'sz399967',
  '163115': 'sz399967',
  '161816': 'sh000971',
  '161118': 'sz399005',
  '160633': 'sz399975',
  '502056': 'sz399989',
  '160629': 'sz399971',
  '161715': 'sz399979',
  '168203': 'sz399440',
  '161025': 'sz399970',
  '502000': 'sh000905',
  '161726': 'sz399441',
  '165309': 'sh000300',
  '161720': 'sz399975',
  '162216': 'sh000905',
  '164508': 'sh000903',
  '163113': 'sz399707',
  '160221': 'sz399395',
  '160615': 'sh000300',
  '162412': 'sz399989',
  '502006': 'sz399974',
  '161122': 'sz399993',
  '502010': 'sz399975',
  '161027': 'sz399975',
  '160631': 'sz399986',
  '162509': 'sh000903',
  '160628': 'sz399965',
  '501047': 'sz399975',
  '161724': 'sz399998',
  '502053': 'sz399975',
  '501048': 'sz399975',
  '161121': 'sz399986',
  '161725': 'sz399997',
  '501059': 'sh000824',
  '160632': 'sz399987',
  '161032': 'sz399998',
  '160716': 'sh000925',
  '160218': 'sz399393',
  '168204': 'sz399998',
  '161029': 'sz399986',
  '502013': 'sz399991',
  '160222': 'sz399396',
  '163116': 'sz399811',
  '160806': 'sh000906',
  '161811': 'sh000300',
};

// ============ 缓存（减少上游调用与延迟） ============
const cache = new Map();
const TTL = { tencent: 3000, fundNav: 30000 };
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

// ============ 东方财富 净值/估值 ============
async function fetchFundGzRaw(code) {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' } });
  const text = await res.text();
  const json = text.replace(/^jsonpgz\(/, '').replace(/\);?$/, '');
  const data = JSON.parse(json);
  if (!data || !data.dwjz) throw new Error('no dwjz');
  return { dwjz: data.dwjz, jzrq: data.jzrq || null, gsz: data.gsz || null, gztime: data.gztime || null };
}
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
    prevJzrq: prev && prev.FSRQ ? prev.FSRQ : null,
    gsz: null, gztime: null
  };
}

async function fetchFundNav(code) {
  const key = 'nav:' + code;
  const cached = getCached(key, TTL.fundNav);
  if (cached) return cached.__neg ? null : cached;
  // 两源任一失败都降级为 null，不阻塞主流程
  const [gz, ls] = await Promise.all([
    fetchFundGzRaw(code).catch(() => null),
    fetchFundNavLsjz(code).catch(() => null)
  ]);
  const gzDate = gz && gz.jzrq ? parseInt(String(gz.jzrq).replace(/-/g, '')) : 0;
  const lsDate = ls && ls.jzrq ? parseInt(String(ls.jzrq).replace(/-/g, '')) : 0;
  let best = null;
  if (lsDate >= gzDate && ls) best = { dwjz: ls.dwjz, jzrq: ls.jzrq };
  else if (gz) best = { dwjz: gz.dwjz, jzrq: gz.jzrq };
  if (!best) {
    setCached(key, { __neg: true }); // 负缓存 30s，避免反复打挂掉的源
    return null;
  }
  const result = {
    dwjz: best.dwjz,
    jzrq: best.jzrq,
    prevDwjz: ls && ls.prevDwjz ? ls.prevDwjz : null,
    prevJzrq: ls && ls.prevJzrq ? ls.prevJzrq : null,
    gsz: gz && gz.gsz ? gz.gsz : null,
    gztime: gz && gz.gztime ? gz.gztime : null
  };
  setCached(key, result);
  return result;
}

// 并发受限批量抓取净值（降低被东财限流概率）
async function fetchAllEstimates(funds, limit = 10) {
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

// ============ 业务：基金数据 ============
async function getFundData(symbols) {
  if (!symbols.length) return [];
  const quotes = await fetchTencent(symbols);
  const funds = symbols.map(s => ({ symbol: s, code: s.replace(/^(sh|sz|hk)/, '') }));
  const estMap = await fetchAllEstimates(funds);

  // 跟踪指数真实行情：收集本批基金需要的指数代码，一次性向腾讯拉取（同域、合并请求）
  const needIdx = [...new Set(symbols.map(s => FUND_INDEX_CODE[s.replace(/^(sh|sz|hk)/, '')]).filter(Boolean))];
  const idxQuotes = needIdx.length ? await fetchTencent(needIdx) : {};

  return symbols.map((symbol) => {
    const code = symbol.replace(/^(sh|sz|hk)/, '');
    const q = quotes[symbol];
    // 只要名称与现价字段有效即视为有效行情（放宽长度判定，避免误判）
    if (!q || !q[1] || !q[3] || isNaN(parseFloat(q[3]))) {
      return { code, symbol, name: code, error: true };
    }
    const name = q[1];
    const price = parseFloat(q[3]);
    const prevClose = parseFloat(q[4]) || 0;
    const changePct = q[32] !== undefined && !isNaN(parseFloat(q[32]))
      ? parseFloat(q[32])
      : (prevClose ? (price - prevClose) / prevClose * 100 : 0);
    const bid = parseFloat(q[9]) || 0;   // 买一价
    const ask = parseFloat(q[11]) || 0;  // 卖一价
    const date = q[30] || '';
    const time = q[31] || '';

    const est = estMap.get(code);
    let dwjz = null, gsz = null, gztime = null, navDate = null, prevDwjz = null;
    if (est) {
      dwjz = parseFloat(est.dwjz);
      gsz = est.gsz ? parseFloat(est.gsz) : null;
      gztime = est.gztime || null;
      navDate = est.jzrq || null;
      prevDwjz = est.prevDwjz ? parseFloat(est.prevDwjz) : null;
    }

    const liveVal = (gsz && gsz > 0) ? gsz : (dwjz || 0);
    const premiumNow = liveVal ? (price - liveVal) / liveVal * 100 : null;
    const bidPremium = liveVal ? (bid - liveVal) / liveVal * 100 : null;
    const askDiscount = liveVal ? (ask - liveVal) / liveVal * 100 : null;

    // 跟踪指数涨跌幅：真实指数行情（腾讯）。无映射（主动管理型）则为 null → 页面显示 "--"
    let indexChangePct = null, indexNm = null, indexProxy = false;
    const ic = FUND_INDEX_CODE[code];
    if (ic) {
      const iq = idxQuotes[ic];
      if (iq && iq[1]) {
        indexNm = iq[1];
        const ip = parseFloat(iq[3]);
        const ipc = parseFloat(iq[4]) || 0;
        if (!isNaN(ip) && ipc > 0) {
          indexChangePct = (iq[32] !== undefined && !isNaN(parseFloat(iq[32])))
            ? parseFloat(iq[32])
            : (ip - ipc) / ipc * 100;
        }
      }
    }

    return {
      code, symbol, name,
      price, changePct, bid, ask,
      dwjz, gsz, gztime, navDate,
      premiumNow, bidPremium, askDiscount,
      indexNm, indexChangePct, indexProxy,
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

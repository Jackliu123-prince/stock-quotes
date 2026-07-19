// Render 上线包 · 纯 Node 原生 HTTP 服务（零依赖）
// 同时承担两件事：
//   1) 静态托管前端（index.html / style.css / app.js）
//   2) 提供 /api/stocks?symbols=sh600519,sz000858 代理接口
//      （腾讯财经实时行情 GBK 解码 + 东方财富分红送配）
//
// Render 免费层会“空闲 15 分钟后休眠、下次访问冷启动 30~60 秒”，
// 本服务无需数据库、启动即用，冷启动极快。
//
// 部署：Render 会自动执行 `npm install`（本包无依赖，秒过）然后 `npm start`。
// 端口：读取 process.env.PORT（Render 注入），本地默认 3000。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const gbk = new TextDecoder('gbk');

// ============ 行情代理逻辑（移植自 Cloudflare _worker.js） ============

const cache = new Map(); // key -> { ts, data }
const TTL = { tencent: 3000, dividend: 6 * 3600 * 1000 };
function getCached(key, ttl) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < ttl) return c.data;
  return null;
}
function setCached(key, data) { cache.set(key, { ts: Date.now(), data }); }

async function fetchTencent(symbols) {
  if (!symbols.length) return {};
  const key = 'tencent:' + symbols.join(',');
  const hit = getCached(key, TTL.tencent);
  if (hit) return hit;
  const url = 'https://qt.gtimg.cn/q=' + symbols.join(',');
  const res = await fetch(url, { headers: { Referer: 'https://finance.qq.com/', 'User-Agent': UA } });
  const buf = await res.arrayBuffer();
  const text = gbk.decode(buf);
  const out = {};
  const re = /v_(\w+)="([^"]*)";/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].split('~');
  setCached(key, out);
  return out;
}

function toSecuCode(symbol) {
  const m = /^(sh|sz|hk)(\d{6})$/i.exec(symbol || '');
  if (!m) return null;
  const suf = { sh: 'SH', sz: 'SZ', hk: 'HK' };
  return m[2] + '.' + suf[m[1].toLowerCase()];
}

async function withRetry(fn, retries, baseDelay) {
  let lastErr;
  for (let a = 0; a <= retries; a++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (a < retries) await new Promise(r => setTimeout(r, baseDelay * (a + 1))); }
  }
  throw lastErr;
}

async function fetchDividendRaw(secu) {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECUCODE%3D%22${secu}%22)&sortColumns=REPORT_DATE&sortTypes=-1&pageSize=40&source=WEB&client=WEB`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/yjfp/' } });
  const j = await res.json();
  const list = j && j.result && j.result.data;
  if (!list || !list.length) return null;
  const usable = list.filter(r => r.PRETAX_BONUS_RMB != null);
  if (!usable.length) return null;
  const byYear = {};
  usable.forEach(r => {
    const y = (r.REPORT_DATE || '').slice(0, 4);
    if (!y) return;
    (byYear[y] = byYear[y] || []).push(r);
  });
  const years = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));
  for (const y of years) {
    const rows = byYear[y];
    const annual = rows.find(r => /-12-31/.test(r.REPORT_DATE || ''));
    if (!annual) continue;
    const totalPretax = rows.reduce((s, r) => s + parseFloat(r.PRETAX_BONUS_RMB), 0);
    if (!(totalPretax > 0)) continue;
    const eps = annual.BASIC_EPS != null ? parseFloat(annual.BASIC_EPS) : null;
    if (!(eps > 0)) continue;
    const isProposal = annual.ASSIGN_PROGRESS && /预案|预披露/.test(annual.ASSIGN_PROGRESS);
    return { year: y, dividendPerShare: totalPretax / 10, eps, distCount: rows.length, proposed: !!isProposal };
  }
  return null;
}

async function fetchDividend(symbol) {
  const secu = toSecuCode(symbol);
  if (!secu) return null;
  const key = 'div:' + symbol;
  const cached = getCached(key, TTL.dividend);
  if (cached) return cached.__neg ? null : cached;
  try {
    const d = await withRetry(() => fetchDividendRaw(secu), 2, 200);
    if (!d) { setCached(key, { __neg: true }); return null; }
    setCached(key, d);
    return d;
  } catch (e) {
    setCached(key, { __neg: true });
    return null;
  }
}

async function getStockData(symbols) {
  if (!symbols.length) return [];
  const quotes = await fetchTencent(symbols);

  const divMap = new Map();
  let di = 0;
  async function divWorker() {
    while (di < symbols.length) {
      const sym = symbols[di++];
      divMap.set(sym, await fetchDividend(sym).catch(() => null));
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, symbols.length) }, divWorker));

  return symbols.map((symbol) => {
    const code = symbol.replace(/^(sh|sz|hk)/, '');
    const q = quotes[symbol];
    if (!q || q.length < 47 || !q[1]) {
      return { code, symbol, name: code, error: true };
    }
    const name = q[1];
    const price = parseFloat(q[3]);
    const changePct = parseFloat(q[32]);
    const amountWan = parseFloat(q[37]) || 0;
    const amountYi = amountWan / 10000;
    const peTTM = q[39] ? parseFloat(q[39]) : null;
    const pb = q[46] ? parseFloat(q[46]) : null;
    const mktCapYi = q[45] ? parseFloat(q[45]) : null;
    const roe = (pb && peTTM) ? pb / peTTM * 100 : null;

    const div = divMap.get(symbol);
    let payoutRatio = null, dividendYield = null, estReturn = null, divYear = null, divProposed = false;
    if (div && div.dividendPerShare != null && div.eps && div.eps > 0 && price > 0) {
      divYear = div.year;
      divProposed = !!div.proposed;
      payoutRatio = div.dividendPerShare / div.eps * 100;
      dividendYield = div.dividendPerShare / price * 100;
      if (roe != null) estReturn = (1 - payoutRatio / 100) * roe + dividendYield;
    }
    return {
      code, symbol, name,
      price, changePct,
      amountWan, amountYi, peTTM, pb, roe, mktCapYi,
      payoutRatio, dividendYield, estReturn, divYear, divProposed,
      time: q[30] || '--'
    };
  });
}

function normalizeSymbol(input) {
  input = (input || '').trim().toLowerCase();
  if (!input) return null;
  if (/^(sh|sz|hk)\d/.test(input)) return input;
  if (/^\d{6}$/.test(input)) return (/^([56])/.test(input) ? 'sh' : 'sz') + input;
  return null;
}

// ============ 静态文件服务 ============

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // 防目录穿越
  const filePath = path.join(__dirname, path.normalize(rel));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendJSON(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/stocks') {
    try {
      const raw = (u.searchParams.get('symbols') || '').split(',');
      const symbols = [...new Set(raw.map(normalizeSymbol).filter(Boolean))];
      const data = await getStockData(symbols);
      sendJSON(res, { updated: Date.now(), data });
    } catch (e) {
      sendJSON(res, { error: String((e && e.message) || e) }, 500);
    }
    return;
  }

  // 健康检查（Render 用，也可自定义）
  if (u.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, u.pathname);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`股票行情服务已启动: http://localhost:${PORT}`);
});

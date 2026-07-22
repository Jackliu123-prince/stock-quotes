// 一次性生成净值快照：为全部默认 LOF / 指数基金抓取单位净值，写入 netlify/functions/nav-data.js
// 用法：node gen_nav.mjs
import fs from 'fs';
import path from 'path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function readFileSafe(p) { return fs.readFileSync(p, 'utf8'); }

// 从 funds.js 提取 FUND_INDEX_SECID 的 key（基金代码）
function extractFundCodesFromFunds() {
  const txt = readFileSafe(path.join(process.cwd(), 'netlify/functions/funds.js'));
  const m = txt.match(/const FUND_INDEX_SECID = \{([\s\S]*?)\n\};/);
  if (!m) return [];
  const keys = [];
  const re = /"(\d{6})"\s*:/g; let x;
  while ((x = re.exec(m[1]))) keys.push(x[1]);
  return keys;
}
// 从 app.js 提取 DEFAULTS.lof 列表
function extractLofCodes() {
  const txt = readFileSafe(path.join(process.cwd(), 'app.js'));
  const m = txt.match(/lof:\s*\[([\s\S]*?)\],/);
  if (!m) return [];
  const codes = [];
  const re = /'(sh|sz|hk)(\d{6})'/g; let x;
  while ((x = re.exec(m[1]))) codes.push(x[2]);
  return codes;
}

function fetchWithTimeout(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://fundf10.eastmoney.com/' }, signal: ctrl.signal }).finally(() => clearTimeout(t));
}
async function getNav(code) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=2`;
  const res = await fetchWithTimeout(url);
  const j = await res.json();
  const list = j && j.Data && j.Data.LSJZList;
  if (!list || !list.length || !list[0].DWJZ) return null;
  const row = list[0], prev = list[1];
  return {
    dwjz: row.DWJZ,
    jzrq: row.FSRQ || null,
    prevDwjz: prev && prev.DWJZ ? prev.DWJZ : null,
    prevJzrq: prev && prev.FSRQ ? prev.FSRQ : null
  };
}
async function getNavRetry(code, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await getNav(code);
      if (r) return r;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 250 * (i + 1)));
  }
  return null;
}

async function main() {
  const codes = [...new Set([...extractFundCodesFromFunds(), ...extractLofCodes()])].sort();
  console.log(`待抓取基金数: ${codes.length}`);
  const out = {};
  let done = 0, ok = 0, fail = 0;
  const CONC = 6;
  let idx = 0;
  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      const r = await getNavRetry(code);
      done++;
      if (r) { out[code] = r; ok++; }
      else { fail++; console.error(`  ✗ ${code} 净值获取失败`); }
      if (done % 20 === 0) console.log(`  进度 ${done}/${codes.length} 成功${ok} 失败${fail}`);
      await new Promise(r => setTimeout(r, 120));
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`完成：成功 ${ok} / 失败 ${fail} / 共 ${codes.length}`);

  // 写 nav-data.js（ESM 导出，便于函数打包内联）
  const json = JSON.stringify(out, null, 0);
  const content = `// 自动生成：LOF / 指数基金单位净值快照（来源：东方财富 lsjz）。\n// 单位净值每日仅收盘后更新一次，交易时段内恒定，故可作快照避免每次刷新打东财被限流。\n// 函数启动时读此快照（永远有净值），并以非阻塞后台任务每隔数小时静默刷新内存副本。\nexport const NAV_SNAPSHOT = ${json};\n`;
  fs.writeFileSync(path.join(process.cwd(), 'netlify/functions/nav-data.js'), content, 'utf8');
  console.log(`已写入 netlify/functions/nav-data.js（${(json.length / 1024).toFixed(1)} KB，${ok} 条）`);
}
main().catch(e => { console.error(e); process.exit(1); });

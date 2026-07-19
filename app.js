'use strict';

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function fmt(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return Number(n).toFixed(d);
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function clsFor(n) {
  if (n === null || n === undefined || isNaN(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

// ---------- 股票列表（浏览器本地存储） ----------
const LS_KEY = 'stockList.v1';
// 首次访问的默认股票（可在页面里自由增删，之后以本地存储为准）
const DEFAULT_STOCKS = [
  'sh600519', 'sz000858', 'sh601318', 'sh000001', 'sz399001',
  'sh600887', 'sz002966', 'sz000333', 'sz000651', 'sh601995',
  'sz000568', 'sz300760', 'sz000999', 'sh600285', 'sh600926',
  'sh600036', 'sz002557', 'sz002867', 'sz002507', 'sh600436'
];

function normalizeSymbol(input) {
  input = (input || '').trim().toLowerCase();
  if (!input) return null;
  if (/^(sh|sz|hk)\d/.test(input)) return input;
  if (/^\d{6}$/.test(input)) {
    // 5/6 开头为沪市，其余为深市
    return (/^([56])/.test(input) ? 'sh' : 'sz') + input;
  }
  return null;
}

function loadStocks() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) { /* ignore */ }
  saveStocks(DEFAULT_STOCKS.slice());
  return DEFAULT_STOCKS.slice();
}
function saveStocks(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

let stockList = loadStocks();

// ---------- market status (Beijing time) ----------
function marketStatus(now = new Date()) {
  const beijing = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + 8 * 3600000);
  const day = beijing.getDay();
  const h = beijing.getHours(), m = beijing.getMinutes();
  const t = h * 60 + m;
  const isWeekday = day >= 1 && day <= 5;
  const morning = t >= 9 * 60 + 15 && t <= 11 * 60 + 30;
  const afternoon = t >= 13 * 60 && t <= 15 * 60;
  if (isWeekday && (morning || afternoon)) return { open: true, text: '交易中' };
  return { open: false, text: '休市' };
}

// ---------- sorting ----------
let sortState = { stock: { key: 'changePct', dir: 'desc' } };

function attachSort(tableId, onSort) {
  $$(`#${tableId} th.sortable`).forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const cur = sortState.stock;
      if (cur.key === key) cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
      else { cur.key = key; cur.dir = 'asc'; }
      $$(`#${tableId} th`).forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(cur.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      onSort();
    });
  });
}

function applySort(rows) {
  const { key, dir } = sortState.stock;
  const mul = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    if (va === null || va === undefined) va = -Infinity;
    if (vb === null || vb === undefined) vb = -Infinity;
    if (typeof va === 'string') return va.localeCompare(vb) * mul;
    return (va - vb) * mul;
  });
}

// ---------- render stocks ----------
function renderStocks(data) {
  const body = $('#stockBody');
  if (!data.length) { body.innerHTML = '<tr><td colspan="14" class="empty">暂无股票，请在上方添加</td></tr>'; return; }
  const sorted = applySort(data);
  body.innerHTML = sorted.map(r => {
    if (r.error) {
      return `<tr><td class="code">${r.code}</td><td>${r.name}</td><td colspan="11" class="muted">行情获取失败</td>
        <td class="num"><button class="btn danger sm" data-del-stock="${r.symbol}">移除</button></td></tr>`;
    }
    const cc = clsFor(r.changePct);
    const pb = (r.pb !== null && !isNaN(r.pb)) ? fmt(r.pb, 2) : '--';
    const pe = (r.peTTM !== null && !isNaN(r.peTTM)) ? fmt(r.peTTM, 2) : '--';
    const roe = (r.roe !== null && !isNaN(r.roe)) ? fmt(r.roe, 2) + '%' : '--';
    const payout = (r.payoutRatio !== null && !isNaN(r.payoutRatio)) ? fmt(r.payoutRatio, 2) + '%' : '--';
    const dyield = (r.dividendYield !== null && !isNaN(r.dividendYield)) ? fmt(r.dividendYield, 2) + '%' : '--';
    const est = (r.estReturn !== null && !isNaN(r.estReturn)) ? fmt(r.estReturn, 2) + '%' : '--';
    const estSub = (r.estReturn !== null && !isNaN(r.estReturn) && r.divYear) ? `<div class="sub">${r.divYear}年度${r.divProposed ? '·预案' : ''}</div>` : '';
    const cap = (r.mktCapYi !== null && !isNaN(r.mktCapYi)) ? fmt(r.mktCapYi, 2) : '--';
    return `<tr>
      <td class="code">${r.code}</td>
      <td class="name">${r.name}</td>
      <td class="num ${cc}">${fmt(r.price)}</td>
      <td class="num ${cc}">${fmtPct(r.changePct)}</td>
      <td class="num">${fmt(r.amountYi, 4)}</td>
      <td class="num">${pb}</td>
      <td class="num">${pe}</td>
      <td class="num">${roe}</td>
      <td class="num">${payout}</td>
      <td class="num">${dyield}</td>
      <td class="num">${est}${estSub}</td>
      <td class="num">${cap}</td>
      <td class="num muted">${r.time || '--'}</td>
      <td class="num"><button class="btn danger sm" data-del-stock="${r.symbol}">移除</button></td>
    </tr>`;
  }).join('');
  $$('[data-del-stock]').forEach(b => b.addEventListener('click', () => removeStock(b.dataset.delStock)));
}

// ---------- data fetch ----------
function stamp(msg) {
  $('#lastUpdate').textContent = msg || ('更新于 ' + new Date().toLocaleTimeString('zh-CN'));
}

async function refreshStocks() {
  if (!stockList.length) { renderStocks([]); stamp(); return; }
  try {
    const url = '/api/stocks?symbols=' + encodeURIComponent(stockList.join(','));
    const res = await fetch(url);
    const j = await res.json();
    renderStocks(j.data || []);
    stamp();
  } catch (e) { stamp('更新失败: ' + e.message); }
}

// ---------- add / remove（本地存储） ----------
function addStock() {
  const raw = $('#stockInput').value;
  const symbol = normalizeSymbol(raw);
  if (!symbol) { alert('无效代码，请输入如 600519 或 sh600519'); return; }
  if (stockList.includes(symbol)) { alert('该股票已在列表中'); return; }
  stockList.push(symbol);
  saveStocks(stockList);
  $('#stockInput').value = '';
  refreshStocks();
}
function removeStock(symbol) {
  stockList = stockList.filter(s => s !== symbol);
  saveStocks(stockList);
  refreshStocks();
}

// ---------- wire up ----------
$('#stockAdd').addEventListener('click', addStock);
$('#stockInput').addEventListener('keydown', e => { if (e.key === 'Enter') addStock(); });
$('#refreshBtn').addEventListener('click', refreshStocks);
attachSort('stockTable', refreshStocks);

// market status
(function updateStatus() {
  const s = marketStatus();
  const el = $('#marketStatus');
  el.textContent = s.text;
  el.className = 'badge ' + (s.open ? 'open' : 'closed');
})();

// auto refresh
let timer = null;
function startAuto() { stopAuto(); timer = setInterval(refreshStocks, 10000); }
function stopAuto() { if (timer) clearInterval(timer); }
$('#autoToggle').addEventListener('change', e => e.target.checked ? startAuto() : stopAuto());

// init sort header markers
(function initSortMarks() {
  $$('#stockTable th').forEach(th => { if (th.dataset.key === sortState.stock.key) th.classList.add('sort-' + sortState.stock.dir); });
})();

refreshStocks();
startAuto();

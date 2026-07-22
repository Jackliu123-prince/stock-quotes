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
function fmtDate(d) {
  if (!d) return '';
  return String(d).slice(5); // 2026-07-17 -> 07-17
}
function clsFor(n) {
  if (n === null || n === undefined || isNaN(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}
function normalizeSymbol(input) {
  input = (input || '').trim().toLowerCase();
  if (!input) return null;
  if (/^(sh|sz|hk)\d/.test(input)) return input;
  if (/^\d{6}$/.test(input)) return (/^([56])/.test(input) ? 'sh' : 'sz') + input;
  return null;
}

// ---------- localStorage 列表（每页独立） ----------
const LS = { self: 'selfList.v1', lof: 'lofList.v1', stock: 'stockList.v1' };
const DEFAULTS = {
  self: ['sz161725', 'sz163406', 'sz161005', 'sz162605', 'sz163402'],
  lof:  [
    'sz161226',
    'sh501036',
    'sz162711',
    'sh501030',
    'sz160807',
    'sz163111',
    'sz162307',
    'sh501019',
    'sz160626',
    'sz161812',
    'sz160616',
    'sz161017',
    'sz161033',
    'sh501043',
    'sh501010',
    'sz160119',
    'sz167301',
    'sz160223',
    'sz163118',
    'sz161039',
    'sz160225',
    'sh501045',
    'sz160630',
    'sz163407',
    'sh501031',
    'sz165511',
    'sh502048',
    'sh501029',
    'sz161037',
    'sz161024',
    'sz163109',
    'sz165515',
    'sz160706',
    'sz161123',
    'sh502023',
    'sz161028',
    'sz161227',
    'sz160638',
    'sh501037',
    'sz161026',
    'sh501012',
    'sh501016',
    'sh501011',
    'sz161631',
    'sh501058',
    'sz165525',
    'sz160637',
    'sz165522',
    'sz161036',
    'sh502003',
    'sz163115',
    'sh501009',
    'sh501007',
    'sz161816',
    'sh501057',
    'sz161035',
    'sz161118',
    'sz165521',
    'sz160633',
    'sh502056',
    'sz168701',
    'sz160629',
    'sz165519',
    'sz161715',
    'sz160643',
    'sz168203',
    'sz161025',
    'sh502000',
    'sz161726',
    'sz165309',
    'sz161031',
    'sz161720',
    'sz160625',
    'sz160620',
    'sz162216',
    'sz164508',
    'sh501008',
    'sz163113',
    'sz160221',
    'sz160615',
    'sh501005',
    'sz162412',
    'sh502006',
    'sz161122',
    'sz161030',
    'sh501089',
    'sz165520',
    'sz160635',
    'sz160219',
    'sh502010',
    'sz163821',
    'sz161027',
    'sz160631',
    'sz161217',
    'sh501090',
    'sz162509',
    'sz160639',
    'sz160628',
    'sh501047',
    'sz161724',
    'sh502053',
    'sh501050',
    'sh501048',
    'sz161121',
    'sz161725',
    'sh501059',
    'sh501311',
    'sz160632',
    'sz161032',
    'sz160716',
    'sz160218',
    'sz163114',
    'sz168204',
    'sz161029',
    'sz160135',
    'sh502013',
    'sz160222',
    'sz161607',
    'sz163116',
    'sz160806',
    'sz161811'
  ],
  stock: ['sh600519', 'sz000858', 'sh601318', 'sh600036', 'sh600887', 'sz000333', 'sz000651', 'sz300750', 'sz000568', 'sz300760']
};
function loadList(key) {
  try {
    const raw = localStorage.getItem(LS[key]);
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a; }
  } catch (e) {}
  const d = DEFAULTS[key].slice();
  localStorage.setItem(LS[key], JSON.stringify(d));
  return d;
}
function saveList(key, list) { try { localStorage.setItem(LS[key], JSON.stringify(list)); } catch (e) {} }

const lists = {
  self: loadList('self'),
  lof: loadList('lof'),
  stock: loadList('stock')
};
const dataStore = { self: [], lof: [], stock: [] };

// ---------- 交易时段判断（北京时间） ----------
// 用户要求：周一至周五 9:00-16:00 自动刷新；其余时段仅手动刷新。
function isTradingNow(now = new Date()) {
  const beijing = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + 8 * 3600000);
  const day = beijing.getDay();
  const t = beijing.getHours() * 60 + beijing.getMinutes();
  const isWeekday = day >= 1 && day <= 5;
  return isWeekday && t >= 9 * 60 && t <= 16 * 60;
}

// ---------- sorting ----------
const sortState = {
  self:  { key: 'premiumNow', dir: 'desc' },
  lof:   { key: 'premiumNow', dir: 'desc' },
  stock: { key: 'changePct', dir: 'desc' }
};
function attachSort(tableId) {
  $$(`#${tableId} th.sortable`).forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const cur = sortState[tableId];
      if (cur.key === key) cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
      else { cur.key = key; cur.dir = 'asc'; }
      $$(`#${tableId} th`).forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(cur.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderTab(tableId.replace('Table', ''));
    });
  });
}
function applySort(rows, tableId) {
  const { key, dir } = sortState[tableId];
  const mul = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    if (va === null || va === undefined) va = -Infinity;
    if (vb === null || vb === undefined) vb = -Infinity;
    if (typeof va === 'string') return va.localeCompare(vb) * mul;
    return (va - vb) * mul;
  });
}

// ---------- premium cell ----------
function premCell(val, withSignal) {
  if (val === null || val === undefined || isNaN(val)) return '<span class="prem-cell">--</span>';
  const c = val > 0 ? 'prem-up' : (val < 0 ? 'prem-down' : '');
  const sig = (withSignal && Math.abs(val) >= 1) ? ' signal' : '';
  return `<span class="prem-cell ${c}${sig}">${fmtPct(val)}</span>`;
}

// ---------- render 自选 ----------
function renderSelf(data) {
  const body = $('#selfBody');
  if (!data.length) { body.innerHTML = '<tr><td colspan="12" class="empty">自选为空，请在上方“加入自选”添加基金</td></tr>'; return; }
  body.innerHTML = applySort(data, 'self').map(r => {
    if (r.error) return `<tr><td class="code">${r.code}</td><td>${r.name}</td><td colspan="9" class="muted">行情获取失败</td><td class="num"><button class="btn danger sm" data-del="self" data-sym="${r.symbol}">移除</button></td></tr>`;
    const cc = clsFor(r.changePct);
    const navD = fmtDate(r.navDate);
    return `<tr>
      <td class="code">${r.code}</td>
      <td class="name">${r.name}</td>
      <td class="num ${cc}">${fmt(r.price, 3)}</td>
      <td class="num ${cc}">${fmtPct(r.changePct)}</td>
      <td class="num">${fmt(r.bid, 3)}</td>
      <td class="num">${fmt(r.ask, 3)}</td>
      <td class="num">${fmt(r.dwjz, 4)}${navD ? `<div class="sub">${navD}</div>` : ''}</td>
      <td class="num">${r.estNav !== null && !isNaN(r.estNav) ? fmt(r.estNav, 3) : '--'}</td>
      <td class="num">${premCell(r.premiumNow, true)}</td>
      <td class="num">${premCell(r.bidPremium, true)}</td>
      <td class="num">${premCell(r.askDiscount, true)}</td>
      <td class="num"><button class="btn danger sm" data-del="self" data-sym="${r.symbol}">移除</button></td>
    </tr>`;
  }).join('');
  bindDel();
}

// ---------- render LOF 基金 ----------
function renderLof(data) {
  const body = $('#lofBody');
  if (!data.length) { body.innerHTML = '<tr><td colspan="14" class="empty">暂无基金，请在上方添加</td></tr>'; return; }
  body.innerHTML = applySort(data, 'lof').map(r => {
    if (r.error) return `<tr><td class="code">${r.code}</td><td>${r.name}</td><td colspan="11" class="muted">行情获取失败</td><td class="num"><button class="btn danger sm" data-del="lof" data-sym="${r.symbol}">移除</button></td></tr>`;
    const cc = clsFor(r.changePct);
    const navD = fmtDate(r.navDate);
    const idx = r.indexNm ? `<span class="idx-nm">${r.indexNm}</span>` : '<span class="muted">--</span>';
    const idxChg = (r.indexChangePct !== null && !isNaN(r.indexChangePct))
      ? `<span class="${clsFor(r.indexChangePct)}">${fmtPct(r.indexChangePct)}</span>`
      : '<span class="muted">--</span>';
    return `<tr>
      <td class="code">${r.code}</td>
      <td class="name">${r.name}</td>
      <td class="num ${cc}">${fmt(r.price, 3)}</td>
      <td class="num ${cc}">${fmtPct(r.changePct)}</td>
      <td class="num">${fmt(r.bid, 3)}</td>
      <td class="num">${fmt(r.ask, 3)}</td>
      <td class="num">${fmt(r.dwjz, 4)}${navD ? `<div class="sub">${navD}</div>` : ''}</td>
      <td class="num">${r.estNav !== null && !isNaN(r.estNav) ? fmt(r.estNav, 3) : '--'}</td>
      <td class="num">${premCell(r.premiumNow, true)}</td>
      <td class="num">${premCell(r.bidPremium, true)}</td>
      <td class="num">${premCell(r.askDiscount, true)}</td>
      <td class="idx">${idx}</td>
      <td class="num">${idxChg}</td>
      <td class="num"><button class="btn danger sm" data-del="lof" data-sym="${r.symbol}">移除</button></td>
    </tr>`;
  }).join('');
  bindDel();
}

// ---------- render 股票 ----------
function renderStocks(data) {
  const body = $('#stockBody');
  if (!data.length) { body.innerHTML = '<tr><td colspan="14" class="empty">暂无股票，请在上方添加</td></tr>'; return; }
  body.innerHTML = applySort(data, 'stock').map(r => {
    if (r.error) return `<tr><td class="code">${r.code}</td><td>${r.name}</td><td colspan="11" class="muted">行情获取失败</td><td class="num"><button class="btn danger sm" data-del="stock" data-sym="${r.symbol}">移除</button></td></tr>`;
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
      <td class="num"><button class="btn danger sm" data-del="stock" data-sym="${r.symbol}">移除</button></td>
    </tr>`;
  }).join('');
  bindDel();
}

function renderTab(tab) {
  if (tab === 'self') renderSelf(dataStore.self);
  else if (tab === 'lof') renderLof(dataStore.lof);
  else renderStocks(dataStore.stock);
}

// ---------- data fetch ----------
function stamp(msg) { $('#lastUpdate').textContent = msg || ('更新于 ' + new Date().toLocaleTimeString('zh-CN')); }

async function fetchTab(tab) {
  try {
    const syms = lists[tab];
    if (!syms.length) { dataStore[tab] = []; renderTab(tab); stamp(); return; }
    const path = tab === 'stock' ? '/api/stocks' : '/api/funds';
    // 分块并发：单函数调用只处理一小批，避免基金过多时东财净值调用超过 Netlify 10s 上限
    const CHUNK = 10;
    const chunks = [];
    for (let i = 0; i < syms.length; i += CHUNK) chunks.push(syms.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(async c => {
      const res = await fetch(path + '?symbols=' + encodeURIComponent(c.join(',')));
      const j = await res.json();
      return j.data || [];
    }));
    const merged = [], seen = new Set();
    for (const arr of results) for (const r of arr) {
      if (r && !seen.has(r.symbol)) { seen.add(r.symbol); merged.push(r); }
    }
    dataStore[tab] = merged;
    renderTab(tab);
    stamp();
  } catch (e) { stamp('更新失败: ' + e.message); }
}

// ---------- 增删（本地存储） ----------
function bindDel() {
  $$('[data-del]').forEach(b => b.addEventListener('click', () => {
    const tab = b.dataset.del, sym = b.dataset.sym;
    lists[tab] = lists[tab].filter(s => s !== sym);
    saveList(tab, lists[tab]);
    fetchTab(tab);
  }));
}
function addToList(tab, inputId) {
  const raw = $('#' + inputId).value;
  const symbol = normalizeSymbol(raw);
  if (!symbol) { alert('无效代码，请输入如 161725 / sz161725（基金）或 600519 / sh600519（股票）'); return; }
  if (lists[tab].includes(symbol)) { alert('该代码已在列表中'); return; }
  lists[tab].push(symbol);
  saveList(tab, lists[tab]);
  $('#' + inputId).value = '';
  fetchTab(tab);
}
// 恢复默认列表：用内置 DEFAULTS 覆盖本页 localStorage（用于把 netlify 页对齐到统一清单）
function resetList(tab) {
  if (!confirm('确定用内置默认列表覆盖本页当前的列表吗？')) return;
  lists[tab] = DEFAULTS[tab].slice();
  saveList(tab, lists[tab]);
  fetchTab(tab);
}

// ---------- 标签切换 ----------
function currentTab() { return $('.tab.active').dataset.tab; }
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('#' + tab.dataset.tab).classList.add('active');
    fetchTab(currentTab()); // 切换即加载该页（用户主动操作，非交易时段也允许）
  });
});

// ---------- 自动刷新（交易时段 10 分钟，仅当前标签页，后台暂停） ----------
const REFRESH_MS = 10 * 60 * 1000;
let timer = null;
function tick() {
  if (!isTradingNow()) return;                 // 非交易时段不自动刷新
  if (document.visibilityState !== 'visible') return; // 后台标签页暂停
  if (!$('#autoToggle').checked) return;        // 用户关闭自动
  fetchTab(currentTab());
}
function updateStatus() {
  const trading = isTradingNow();
  const auto = $('#autoToggle').checked;
  const badge = $('#marketStatus');
  badge.textContent = trading ? '交易中' : '休市';
  badge.className = 'badge ' + (trading ? 'open' : 'closed');
  let mode = trading ? (auto ? '交易中 · 每10分钟自动刷新' : '交易中 · 自动已暂停') : '休市 · 仅手动刷新';
  $('#refreshMode').textContent = mode;
}
function startAuto() { stopAuto(); timer = setInterval(tick, REFRESH_MS); }
function stopAuto() { if (timer) clearInterval(timer); }

// ---------- wire up ----------
$('#selfAdd').addEventListener('click', () => addToList('self', 'selfInput'));
$('#selfInput').addEventListener('keydown', e => { if (e.key === 'Enter') addToList('self', 'selfInput'); });
$('#lofAdd').addEventListener('click', () => addToList('lof', 'lofInput'));
$('#lofInput').addEventListener('keydown', e => { if (e.key === 'Enter') addToList('lof', 'lofInput'); });
$('#stockAdd').addEventListener('click', () => addToList('stock', 'stockInput'));
$('#stockInput').addEventListener('keydown', e => { if (e.key === 'Enter') addToList('stock', 'stockInput'); });
$('#selfReset').addEventListener('click', () => resetList('self'));
$('#lofReset').addEventListener('click', () => resetList('lof'));
$('#stockReset').addEventListener('click', () => resetList('stock'));
$('#refreshBtn').addEventListener('click', () => fetchTab(currentTab()));
$('#autoToggle').addEventListener('change', updateStatus);
attachSort('selfTable'); attachSort('lofTable'); attachSort('stockTable');

// 标签页重新可见且处于交易时段 → 立即刷新当前页
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { updateStatus(); if (isTradingNow() && $('#autoToggle').checked) fetchTab(currentTab()); } });
// 每分钟刷新一次状态文案（交易开始/结束的边界提示）
setInterval(updateStatus, 60000);

// ---------- init ----------
updateStatus();
fetchTab(currentTab()); // 首次加载即拉取当前页
startAuto();

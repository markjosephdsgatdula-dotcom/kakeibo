'use strict';

/* ---------- helpers ---------- */
const KEY = 'kakeibo.v1';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const ymKey = (y, m) => `${y}-${pad(m + 1)}`; // m is 0-based
const sum = (arr, f = x => x) => arr.reduce((a, x) => a + f(x), 0);
const TYPE_LABEL = { expense: 'Expense', income: 'Income', transfer: 'Transfer' };
const TRANSFER_COLOR = '#8e7cc3';

/* ---------- data ---------- */
function defaults() {
  const cat = (type, name, icon, color, genres = []) => ({ id: uid(), type, name, icon, color, genres });
  return {
    version: 1,
    settings: { currency: 'PHP', theme: 'auto', weekStart: 0 },
    accounts: [
      { id: uid(), name: 'Cash', icon: '👛', opening: 0 },
      { id: uid(), name: 'Bank', icon: '🏦', opening: 0 },
      { id: uid(), name: 'Credit card', icon: '💳', opening: 0 },
    ],
    categories: [
      cat('expense', 'Food', '🍜', '#f59e0b', ['Groceries', 'Dining out', 'Cafe', 'Snacks', 'Delivery']),
      cat('expense', 'Daily goods', '🧴', '#14b8a6', ['Toiletries', 'Household', 'Laundry']),
      cat('expense', 'Transport', '🚌', '#3b82f6', ['Commute', 'Taxi / ride-hailing', 'Fuel', 'Parking & tolls']),
      cat('expense', 'Housing', '🏠', '#8b5cf6', ['Rent', 'Mortgage', 'Repairs']),
      cat('expense', 'Utilities', '💡', '#eab308', ['Electricity', 'Water', 'Gas']),
      cat('expense', 'Phone & internet', '📱', '#06b6d4', ['Mobile', 'Internet', 'Subscriptions']),
      cat('expense', 'Health', '💊', '#ef4444', ['Medicine', 'Clinic', 'Fitness']),
      cat('expense', 'Clothing & beauty', '👕', '#ec4899', ['Clothes', 'Shoes', 'Haircut', 'Cosmetics']),
      cat('expense', 'Entertainment', '🎬', '#a855f7', ['Movies', 'Games', 'Hobbies', 'Travel']),
      cat('expense', 'Education', '📚', '#6366f1', ['Tuition', 'Books', 'Courses']),
      cat('expense', 'Social', '🎁', '#f97316', ['Gifts', 'Parties', 'Donations']),
      cat('expense', 'Other', '🧾', '#64748b', ['Fees', 'Taxes', 'Misc']),
      cat('income', 'Salary', '💼', '#2f80ed'),
      cat('income', 'Bonus', '🎉', '#22c55e'),
      cat('income', 'Side income', '💸', '#10b981', ['Freelance', 'Selling']),
      cat('income', 'Interest', '📈', '#0ea5e9'),
      cat('income', 'Other', '💰', '#64748b'),
    ],
    transactions: [],
    budget: { total: 0, cats: {} },
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.transactions)) {
      const d = defaults();
      return { ...d, ...raw, settings: { ...d.settings, ...raw.settings }, budget: { ...d.budget, ...raw.budget } };
    }
  } catch (e) { console.warn('Could not read saved data', e); }
  return defaults();
}

let db = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('⚠️ Could not save — storage may be full'); }
}

const catById = id => db.categories.find(c => c.id === id);
const accById = id => db.accounts.find(a => a.id === id);
const accName = id => accById(id)?.name ?? '—';
const monthTx = (y, m) => db.transactions.filter(t => t.date.startsWith(ymKey(y, m)));
const byNewest = (a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0);

function totals(list) {
  let inc = 0, exp = 0;
  for (const t of list) { if (t.type === 'income') inc += t.amount; else if (t.type === 'expense') exp += t.amount; }
  return { inc, exp, net: inc - exp };
}

function accBalance(id) {
  let bal = accById(id)?.opening || 0;
  for (const t of db.transactions) {
    if (t.type === 'income' && t.accountId === id) bal += t.amount;
    if (t.type === 'expense' && t.accountId === id) bal -= t.amount;
    if (t.type === 'transfer') {
      if (t.accountId === id) bal -= t.amount;
      if (t.toAccountId === id) bal += t.amount;
    }
  }
  return bal;
}

/* ---------- formatting ---------- */
let nf, cf;
function money(n) {
  nf ||= new Intl.NumberFormat(undefined, { style: 'currency', currency: db.settings.currency });
  return nf.format(n);
}
const compact = n => (cf ||= new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })).format(n);
function currencySymbol() {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: db.settings.currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find(p => p.type === 'currency').value;
  } catch { return db.settings.currency; }
}
function roundMoney(n) {
  money(0);
  const f = nf.resolvedOptions().maximumFractionDigits;
  return Math.round(n * 10 ** f) / 10 ** f;
}
const dayLabel = s => parseD(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const monthLabel = () => new Date(ui.y, ui.m, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

/* ---------- UI state ---------- */
const now = new Date();
const ui = { tab: 'home', sub: null, y: now.getFullYear(), m: now.getMonth(), sel: today(), rtype: 'expense', ctype: 'expense', q: '' };
let draft = null;
let installPrompt = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}
function openSheet(html) { $('#sheet').innerHTML = html; $('#overlay').hidden = false; }
function closeSheet() { $('#overlay').hidden = true; $('#sheet').innerHTML = ''; draft = null; }
const empty = (title, icon, hint = '') => `<div class="empty"><span class="big">${icon}</span><b>${esc(title)}</b><div>${esc(hint)}</div></div>`;

/* ---------- shared pieces ---------- */
function txRow(t) {
  let icon, color, title, sub;
  if (t.type === 'transfer') {
    icon = '🔁'; color = TRANSFER_COLOR;
    title = `${accName(t.accountId)} → ${accName(t.toAccountId)}`;
    sub = t.note || 'Transfer';
  } else {
    const c = catById(t.categoryId);
    icon = c?.icon || '❔'; color = c?.color || '#94a3b8';
    title = t.place || t.genre || c?.name || 'Uncategorized';
    sub = [c?.name, t.genre, accName(t.accountId), t.note].filter(Boolean).join(' · ');
  }
  const cls = t.type === 'expense' ? 'neg' : t.type === 'income' ? 'pos' : 'muted';
  const sign = t.type === 'expense' ? '−' : t.type === 'income' ? '+' : '';
  return `<button class="row" data-act="editTx" data-id="${t.id}">
    <span class="ico" style="background:${color}26">${icon}</span>
    <span class="main"><span class="t">${esc(title)}</span><span class="sub">${esc(sub)}</span></span>
    <span class="amt ${cls}">${sign}${money(t.amount)}</span></button>`;
}

function txGroups(list) {
  const groups = new Map();
  for (const t of [...list].sort(byNewest)) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }
  let html = '';
  for (const [date, items] of groups) {
    const { exp, inc } = totals(items);
    const parts = [exp ? `<span class="neg">−${money(exp)}</span>` : '', inc ? `<span class="pos">+${money(inc)}</span>` : ''].filter(Boolean).join(' ');
    html += `<div class="day-head"><span>${dayLabel(date)}</span><span>${parts}</span></div><div class="list">${items.map(txRow).join('')}</div>`;
  }
  return html;
}

const bar = (used, limit) => {
  const pct = limit > 0 ? Math.min(100, used / limit * 100) : 0;
  return `<div class="bar ${used > limit ? 'over' : ''}"><i style="width:${pct}%"></i></div>`;
};

/* ---------- views ---------- */
function viewHome() {
  const list = monthTx(ui.y, ui.m);
  const { inc, exp, net } = totals(list);
  let html = `<div class="card summary">
    <div><small>Income</small><b class="pos">${money(inc)}</b></div>
    <div><small>Expense</small><b class="neg">${money(exp)}</b></div>
    <div><small>Balance</small><b>${money(net)}</b></div></div>`;
  const B = db.budget.total;
  if (B > 0) {
    const left = B - exp;
    html += `<div class="card"><div class="budget-line"><span>Monthly budget</span>
      <span class="${left < 0 ? 'neg' : ''}">${left < 0 ? 'Over by ' + money(-left) : money(left) + ' left'}</span></div>
      ${bar(exp, B)}<div class="budget-line muted" style="margin-top:4px;font-size:12px"><span>Spent ${money(exp)}</span><span>of ${money(B)}</span></div></div>`;
  }
  html += `<input class="search" type="search" placeholder="Search this month…" value="${esc(ui.q)}" data-input="q">`;
  return html + `<div id="txlist">${homeList(list)}</div>`;
}

function homeList(list = monthTx(ui.y, ui.m)) {
  const q = ui.q.trim().toLowerCase();
  const shown = q ? list.filter(t => {
    const c = catById(t.categoryId);
    return [t.place, t.note, t.genre, c?.name, accName(t.accountId), String(t.amount)].join(' ').toLowerCase().includes(q);
  }) : list;
  if (!shown.length) return q ? empty('No matches', '🔍') : empty('No entries this month', '🧾', 'Tap ＋ to record an expense.');
  return txGroups(shown);
}

function viewCalendar() {
  const ws = Number(db.settings.weekStart) || 0;
  const offset = (new Date(ui.y, ui.m, 1).getDay() - ws + 7) % 7;
  const days = new Date(ui.y, ui.m + 1, 0).getDate();
  const cells = Math.ceil((offset + days) / 7) * 7;
  const map = {};
  for (const t of db.transactions) {
    if (t.type === 'transfer') continue;
    const d = (map[t.date] ||= { inc: 0, exp: 0 });
    if (t.type === 'income') d.inc += t.amount; else d.exp += t.amount;
  }
  const td = today();
  let html = '<div class="cal" style="margin-top:12px">';
  for (let i = 0; i < 7; i++) {
    html += `<div class="dow">${new Date(2023, 0, 1 + ((ws + i) % 7)).toLocaleDateString(undefined, { weekday: 'narrow' })}</div>`;
  }
  for (let i = 0; i < cells; i++) {
    const d = new Date(ui.y, ui.m, 1 - offset + i);
    const key = ymd(d), v = map[key];
    const cls = ['cell', d.getMonth() !== ui.m && 'out', key === td && 'today', key === ui.sel && 'sel'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-act="pickDay" data-d="${key}"><span class="d">${d.getDate()}</span>
      ${v?.exp ? `<small class="neg">${compact(v.exp)}</small>` : ''}${v?.inc ? `<small class="pos">${compact(v.inc)}</small>` : ''}</button>`;
  }
  html += '</div>';
  const list = db.transactions.filter(t => t.date === ui.sel);
  html += `<div class="section-title"><span>${dayLabel(ui.sel)}</span><a href="#" data-act="newTx" data-date="${ui.sel}" style="color:var(--accent)">＋ Add</a></div>`;
  html += list.length ? `<div class="list">${list.sort(byNewest).map(txRow).join('')}</div>` : empty('Nothing recorded', '🗓️');
  return html;
}

function viewReport() {
  const type = ui.rtype;
  const all = monthTx(ui.y, ui.m);
  const list = all.filter(t => t.type === type);
  const total = sum(list, t => t.amount);
  const by = new Map();
  for (const t of list) by.set(t.categoryId, (by.get(t.categoryId) || 0) + t.amount);
  const rows = [...by].map(([id, amt]) => ({ c: catById(id), id, amt })).sort((a, b) => b.amt - a.amt);

  let html = `<div class="seg" style="margin-top:12px">
    <button data-act="rtype" data-type="expense" class="${type === 'expense' ? 'on' : ''}">Expense</button>
    <button data-act="rtype" data-type="income" class="${type === 'income' ? 'on' : ''}">Income</button></div>`;

  if (!total) {
    html += empty(`No ${type} this month`, '📊');
  } else {
    let acc = 0;
    const arcs = rows.map(r => {
      const pct = r.amt / total * 100;
      const s = `<circle r="15.915" cx="21" cy="21" fill="none" stroke="${r.c?.color || '#94a3b8'}" stroke-width="6"
        stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${-acc}"/>`;
      acc += pct;
      return s;
    }).join('');
    html += `<div class="card"><div class="donut-wrap"><svg viewBox="0 0 42 42">
      <circle r="15.915" cx="21" cy="21" fill="none" stroke="var(--chip)" stroke-width="6"/>${arcs}</svg>
      <div class="donut-center"><small class="muted">Total ${type}</small><b>${money(total)}</b></div></div>`;
    if (type === 'expense') {
      const days = ui.y === now.getFullYear() && ui.m === now.getMonth() ? now.getDate() : new Date(ui.y, ui.m + 1, 0).getDate();
      html += `<div class="budget-line muted" style="font-size:13px"><span>${list.length} entries</span><span>Daily avg ${money(total / days)}</span></div>`;
    }
    html += '</div><div class="list">';
    for (const r of rows) {
      const budget = type === 'expense' ? Number(db.budget.cats[r.id]) || 0 : 0;
      html += `<button class="row" data-act="catDetail" data-id="${r.id ?? ''}">
        <span class="ico" style="background:${r.c?.color || '#94a3b8'}26">${r.c?.icon || '❔'}</span>
        <span class="main"><span class="t">${esc(r.c?.name || 'Uncategorized')}</span>
          <span class="sub">${(r.amt / total * 100).toFixed(1)}%${budget ? ` · budget ${money(budget)}` : ''}</span>
          ${budget ? bar(r.amt, budget) : ''}</span>
        <span class="amt">${money(r.amt)}</span></button>`;
    }
    html += '</div>';
  }

  // 6-month trend
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(ui.y, ui.m - i, 1);
    months.push({ d, ...totals(monthTx(d.getFullYear(), d.getMonth())) });
  }
  const max = Math.max(1, ...months.map(x => Math.max(x.inc, x.exp)));
  const W = 320, H = 150, base = 128, colW = W / 6, bw = 14;
  let bars = '';
  months.forEach((x, i) => {
    const cx = i * colW + colW / 2;
    const hi = x.inc / max * 110, he = x.exp / max * 110;
    bars += `<rect x="${cx - bw - 1}" y="${base - hi}" width="${bw}" height="${hi}" rx="3" fill="var(--income)"/>
      <rect x="${cx + 1}" y="${base - he}" width="${bw}" height="${he}" rx="3" fill="var(--expense)"/>
      <text x="${cx}" y="${H - 6}" text-anchor="middle">${x.d.toLocaleDateString(undefined, { month: 'short' })}</text>`;
  });
  html += `<div class="section-title"><span>Last 6 months</span></div>
    <div class="card bars"><svg viewBox="0 0 ${W} ${H}"><line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--line)"/>${bars}</svg>
    <div class="legend"><span><i class="dot" style="background:var(--income)"></i> Income</span><span><i class="dot" style="background:var(--expense)"></i> Expense</span></div></div>`;
  return html;
}

const SUBS = { accounts: ['🏦', 'Accounts'], budget: ['🎯', 'Budget'], categories: ['🏷️', 'Categories'], data: ['💾', 'Backup & data'], settings: ['⚙️', 'Settings'] };

function viewMore() {
  if (ui.sub) return SUBVIEWS[ui.sub]();
  let html = '<div class="list" style="margin-top:12px">';
  for (const [k, [icon, name]] of Object.entries(SUBS)) {
    html += `<button class="row" data-act="sub" data-sub="${k}"><span class="ico" style="background:var(--chip)">${icon}</span><span class="main"><span class="t">${name}</span></span><span class="muted">›</span></button>`;
  }
  html += '</div>';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (installPrompt) html += '<button class="btn" data-act="install">📲 Install app</button>';
  else if (!standalone && /iphone|ipad/i.test(navigator.userAgent)) html += '<div class="card muted">To install: tap the Share button, then <b>Add to Home Screen</b>.</div>';
  html += `<div class="card muted" style="font-size:13px">Kakeibo stores everything on this device and works offline. Use <b>Backup &amp; data</b> to export regularly.</div>`;
  return html;
}

const SUBVIEWS = {
  accounts() {
    const total = sum(db.accounts, a => accBalance(a.id));
    let html = `<div class="card summary" style="grid-template-columns:1fr"><div><small>Net worth</small><b class="${total < 0 ? 'neg' : ''}" style="font-size:22px">${money(total)}</b></div></div><div class="list">`;
    for (const a of db.accounts) {
      const b = accBalance(a.id);
      html += `<button class="row" data-act="editAcc" data-id="${a.id}"><span class="ico" style="background:var(--chip)">${esc(a.icon)}</span>
        <span class="main"><span class="t">${esc(a.name)}</span></span><span class="amt ${b < 0 ? 'neg' : ''}">${money(b)}</span></button>`;
    }
    return html + '</div><button class="btn secondary" data-act="editAcc">＋ Add account</button>';
  },

  budget() {
    const spent = new Map();
    const list = monthTx(ui.y, ui.m).filter(t => t.type === 'expense');
    for (const t of list) spent.set(t.categoryId, (spent.get(t.categoryId) || 0) + t.amount);
    const totalSpent = sum(list, t => t.amount);
    let html = `<div class="card"><div class="budget-line"><b>Monthly total</b>
      <input class="budget-input" type="number" min="0" inputmode="decimal" placeholder="None" value="${db.budget.total || ''}" data-change="budgetTotal"></div>
      ${db.budget.total ? bar(totalSpent, db.budget.total) + `<div class="budget-line muted" style="font-size:12px;margin-top:4px"><span>${monthLabel()}: ${money(totalSpent)}</span><span>${money(db.budget.total)}</span></div>` : ''}</div>
      <div class="section-title"><span>By category</span></div><div class="list">`;
    for (const c of db.categories.filter(c => c.type === 'expense')) {
      const b = Number(db.budget.cats[c.id]) || 0, s = spent.get(c.id) || 0;
      html += `<div class="row"><span class="ico" style="background:${c.color}26">${c.icon}</span>
        <span class="main"><span class="t">${esc(c.name)}</span><span class="sub">Spent ${money(s)}</span>${b ? bar(s, b) : ''}</span>
        <input class="budget-input" type="number" min="0" inputmode="decimal" placeholder="—" value="${b || ''}" data-change="budgetCat" data-id="${c.id}"></div>`;
    }
    return html + '</div>';
  },

  categories() {
    const t = ui.ctype;
    let html = `<div class="seg" style="margin-top:12px">
      <button data-act="ctype" data-type="expense" class="${t === 'expense' ? 'on' : ''}">Expense</button>
      <button data-act="ctype" data-type="income" class="${t === 'income' ? 'on' : ''}">Income</button></div><div class="list" style="margin-top:12px">`;
    const cats = db.categories.filter(c => c.type === t);
    cats.forEach((c, i) => {
      html += `<div class="row"><span class="ico" style="background:${c.color}26">${c.icon}</span>
        <button class="main" style="border:0;background:none;text-align:left;padding:0" data-act="editCat" data-id="${c.id}">
          <span class="t">${esc(c.name)}</span><span class="sub">${esc(c.genres.join(', ') || 'No genres')}</span></button>
        <button class="icon-btn ghost" data-act="moveCat" data-id="${c.id}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="icon-btn ghost" data-act="moveCat" data-id="${c.id}" data-d="1" ${i === cats.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></div>`;
    });
    return html + '</div><button class="btn secondary" data-act="editCat">＋ Add category</button>';
  },

  data() {
    const n = db.transactions.length;
    return `<div class="card muted">${n} entries · ${(new Blob([JSON.stringify(db)]).size / 1024).toFixed(1)} KB stored on this device</div>
      <button class="btn" data-act="exportJson">⬇️ Export backup (JSON)</button>
      <button class="btn secondary" data-act="importJson">⬆️ Restore from backup</button>
      <button class="btn secondary" data-act="exportCsv">📄 Export CSV (spreadsheet)</button>
      <button class="btn secondary" data-act="sample">🧪 Add sample data</button>
      <button class="btn danger" data-act="reset">Erase all data</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden data-change="importFile">`;
  },

  settings() {
    const cur = ['PHP', 'USD', 'JPY', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'HKD', 'KRW', 'CNY', 'INR', 'IDR', 'MYR', 'THB', 'VND', 'AED', 'SAR', 'NZD', 'CHF'];
    const s = db.settings;
    return `<div class="form">
      <div class="field"><label>Currency</label><select data-change="currency">${cur.map(c => `<option ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Theme</label><select data-change="theme">${['auto', 'light', 'dark'].map(t => `<option value="${t}" ${t === s.theme ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>
      <div class="field"><label>Week starts</label><select data-change="weekStart"><option value="0" ${+s.weekStart === 0 ? 'selected' : ''}>Sunday</option><option value="1" ${+s.weekStart === 1 ? 'selected' : ''}>Monday</option></select></div>
    </div>`;
  },
};

/* ---------- render ---------- */
function render() {
  const top = $('#topbar');
  if (ui.tab === 'more') {
    top.innerHTML = ui.sub
      ? `<button class="icon-btn ghost" data-act="back" aria-label="Back">‹</button><h1>${SUBS[ui.sub][1]}</h1><span style="width:36px"></span>`
      : '<h1>More</h1>';
  } else {
    top.innerHTML = `<button class="icon-btn" data-act="month" data-d="-1" aria-label="Previous month">‹</button>
      <h1 data-act="thisMonth">${monthLabel()}</h1>
      <button class="icon-btn" data-act="month" data-d="1" aria-label="Next month">›</button>`;
  }
  const views = { home: viewHome, calendar: viewCalendar, report: viewReport, more: viewMore };
  $('#view').innerHTML = views[ui.tab]();
  document.querySelectorAll('#tabbar [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
}

function applyTheme() {
  const t = db.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function setMonth(y, m) {
  const d = new Date(y, m, 1);
  ui.y = d.getFullYear(); ui.m = d.getMonth();
  ui.sel = ymKey(ui.y, ui.m) === today().slice(0, 7) ? today() : ymd(d);
}

/* ---------- transaction sheet ---------- */
function newDraft(date) {
  const first = db.categories.find(c => c.type === 'expense');
  return {
    id: null, type: 'expense', date: date || defaultDate(), amount: '',
    categoryId: first?.id, genre: '', accountId: db.accounts[0]?.id, toAccountId: db.accounts[1]?.id, place: '', note: '',
  };
}
// New entries default to today, or the 1st of the viewed month if browsing another month.
const defaultDate = () => ymKey(ui.y, ui.m) === today().slice(0, 7) ? today() : `${ymKey(ui.y, ui.m)}-01`;

function readTxForm() {
  if (!draft) return;
  for (const k of ['amount', 'date', 'place', 'note', 'accountId', 'toAccountId']) {
    const el = $('#f-' + k);
    if (el) draft[k] = el.value;
  }
}

function renderTxSheet() {
  const d = draft;
  const cats = db.categories.filter(c => c.type === d.type);
  const cat = catById(d.categoryId);
  const accOpts = sel => db.accounts.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.icon)} ${esc(a.name)}</option>`).join('');
  const places = [...new Set(db.transactions.filter(t => t.place && t.type === d.type).sort(byNewest).map(t => t.place))].slice(0, 40);

  openSheet(`<div class="t-${d.type}">
    <div class="sheet-head"><button data-act="close">Cancel</button><h2>${d.id ? 'Edit entry' : 'New entry'}</h2><button data-act="saveTx">Save</button></div>
    <div class="seg">${['expense', 'income', 'transfer'].map(t => `<button data-act="txType" data-type="${t}" class="${d.type === t ? 'on' : ''}">${TYPE_LABEL[t]}</button>`).join('')}</div>
    <div class="amount-input"><span>${esc(currencySymbol())}</span>
      <input id="f-amount" inputmode="decimal" placeholder="0" value="${esc(d.amount)}" autocomplete="off" aria-label="Amount"></div>
    ${d.type !== 'transfer' ? `<div class="cats">${cats.map(c => `<button type="button" data-act="txCat" data-id="${c.id}" class="${c.id === d.categoryId ? 'on' : ''}"><i>${c.icon}</i>${esc(c.name)}</button>`).join('')}</div>
      ${cat?.genres.length ? `<div class="chips">${cat.genres.map(g => `<button type="button" data-act="txGenre" data-g="${esc(g)}" class="${g === d.genre ? 'on' : ''}">${esc(g)}</button>`).join('')}</div>` : ''}` : ''}
    <div class="form">
      <div class="field"><label>Date</label><input id="f-date" type="date" value="${d.date}" required></div>
      ${d.type === 'transfer'
        ? `<div class="field"><label>From</label><select id="f-accountId">${accOpts(d.accountId)}</select></div>
           <div class="field"><label>To</label><select id="f-toAccountId">${accOpts(d.toAccountId)}</select></div>`
        : `<div class="field"><label>${d.type === 'income' ? 'Into' : 'Paid with'}</label><select id="f-accountId">${accOpts(d.accountId)}</select></div>
           <div class="field"><label>${d.type === 'income' ? 'From' : 'Place'}</label><input id="f-place" list="places" value="${esc(d.place)}" placeholder="${d.type === 'income' ? 'Employer, client…' : 'Store, restaurant…'}" autocomplete="off"></div>
           <datalist id="places">${places.map(p => `<option value="${esc(p)}">`).join('')}</datalist>`}
      <div class="field"><label>Memo</label><input id="f-note" value="${esc(d.note)}" placeholder="Optional"></div>
    </div>
    <button class="btn" data-act="saveTx">Save</button>
    ${d.id ? '<button class="btn secondary" data-act="dupTx">Duplicate as new</button><button class="btn danger" data-act="delTx">Delete</button>'
           : '<button class="btn secondary" data-act="saveTx" data-again="1">Save &amp; add another</button>'}
  </div>`);
}

// Accepts plain numbers or simple arithmetic like "120+35.5" (calculator-style entry).
function parseAmount(s) {
  s = String(s).replace(/,/g, '').trim();
  if (!s || !/^[\d+\-*/.() ]+$/.test(s)) return NaN;
  try { return Number(Function(`"use strict";return (${s})`)()); } catch { return NaN; }
}

function saveTx(again) {
  readTxForm();
  const d = draft;
  const amount = roundMoney(parseAmount(d.amount));
  if (!(amount > 0) || !isFinite(amount)) { toast('Enter an amount'); $('#f-amount')?.focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) { toast('Pick a date'); return; }
  if (d.type === 'transfer' && d.accountId === d.toAccountId) { toast('Choose two different accounts'); return; }
  const tx = { id: d.id || uid(), type: d.type, date: d.date, amount, accountId: d.accountId, note: d.note.trim(), created: d.created || Date.now() };
  if (d.type === 'transfer') tx.toAccountId = d.toAccountId;
  else Object.assign(tx, { categoryId: d.categoryId, genre: d.genre, place: d.place.trim() });

  const i = db.transactions.findIndex(t => t.id === tx.id);
  if (i >= 0) db.transactions[i] = tx; else db.transactions.push(tx);
  save();
  const [y, m] = tx.date.split('-').map(Number);
  if (y !== ui.y || m - 1 !== ui.m) { ui.y = y; ui.m = m - 1; }
  ui.sel = tx.date;
  render();
  toast(i >= 0 ? 'Updated' : 'Saved');
  if (again) {
    draft = { ...newDraft(tx.date), type: d.type, categoryId: d.categoryId, accountId: d.accountId, toAccountId: d.toAccountId };
    renderTxSheet();
    $('#f-amount').focus();
  } else closeSheet();
}

/* ---------- account / category sheets ---------- */
function accountSheet(a) {
  a ||= { id: null, name: '', icon: '💳', opening: 0 };
  openSheet(`<div class="sheet-head"><button data-act="close">Cancel</button><h2>${a.id ? 'Edit account' : 'New account'}</h2><button data-act="saveAcc" data-id="${a.id || ''}">Save</button></div>
    <div class="form">
      <div class="field"><label>Name</label><input id="a-name" value="${esc(a.name)}" placeholder="e.g. GCash, Savings"></div>
      <div class="field"><label>Icon</label><input id="a-icon" value="${esc(a.icon)}" maxlength="4"></div>
      <div class="field"><label>Opening balance</label><input id="a-opening" type="number" inputmode="decimal" step="any" value="${a.opening || 0}"></div>
    </div>
    <div class="muted" style="font-size:13px;padding:0 4px">Use a negative opening balance for debts like credit cards.</div>
    <button class="btn" data-act="saveAcc" data-id="${a.id || ''}">Save</button>
    ${a.id ? `<button class="btn danger" data-act="delAcc" data-id="${a.id}">Delete account</button>` : ''}`);
}

function categorySheet(c) {
  c ||= { id: null, type: ui.ctype, name: '', icon: '🏷️', color: '#10b981', genres: [] };
  openSheet(`<div class="sheet-head"><button data-act="close">Cancel</button><h2>${c.id ? 'Edit category' : 'New category'}</h2><button data-act="saveCat" data-id="${c.id || ''}">Save</button></div>
    <div class="form">
      <div class="field"><label>Name</label><input id="c-name" value="${esc(c.name)}"></div>
      <div class="field"><label>Icon</label><input id="c-icon" value="${esc(c.icon)}" maxlength="4"></div>
      <div class="field"><label>Color</label><input id="c-color" type="color" value="${esc(c.color)}"></div>
      <div class="field"><label>Genres</label><textarea id="c-genres" placeholder="One per line">${esc(c.genres.join('\n'))}</textarea></div>
    </div>
    <button class="btn" data-act="saveCat" data-id="${c.id || ''}">Save</button>
    ${c.id ? `<button class="btn danger" data-act="delCat" data-id="${c.id}">Delete category</button>` : ''}`);
}

/* ---------- import / export ---------- */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCsv() {
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['Date', 'Type', 'Category', 'Genre', 'Account', 'To account', 'Amount', 'Place', 'Memo']];
  for (const t of [...db.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([t.date, t.type, catById(t.categoryId)?.name ?? '', t.genre ?? '', accName(t.accountId),
      t.type === 'transfer' ? accName(t.toAccountId) : '', t.amount, t.place ?? '', t.note ?? '']);
  }
  return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
}

function addSample() {
  const exp = db.categories.filter(c => c.type === 'expense');
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const places = ['7-Eleven', 'SM Supermarket', 'Jollibee', 'Starbucks', 'Mercury Drug', 'Shopee', 'Grab', 'Puregold', 'Lazada', 'Market'];
  const salary = db.categories.find(c => c.type === 'income');
  for (let mo = 0; mo < 3; mo++) {
    const base = new Date(now.getFullYear(), now.getMonth() - mo, 1);
    const days = mo === 0 ? now.getDate() : new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    if (salary) db.transactions.push({ id: uid(), type: 'income', date: ymd(base), amount: 35000, categoryId: salary.id, genre: '', accountId: db.accounts[1]?.id, place: 'Employer', note: '', created: Date.now() });
    for (let i = 0; i < days * 1.5; i++) {
      const c = pick(exp);
      db.transactions.push({
        id: uid(), type: 'expense', date: ymd(new Date(base.getFullYear(), base.getMonth(), 1 + Math.floor(Math.random() * days))),
        amount: roundMoney(50 + Math.random() * 900), categoryId: c.id, genre: c.genres.length ? pick(c.genres) : '',
        accountId: pick(db.accounts).id, place: pick(places), note: '', created: Date.now(),
      });
    }
  }
  save(); toast('Sample data added');
}

/* ---------- events ---------- */
const actions = {
  tab: el => { ui.tab = el.dataset.tab; ui.sub = null; render(); scrollTo(0, 0); },
  month: el => { setMonth(ui.y, ui.m + Number(el.dataset.d)); render(); },
  thisMonth: () => { setMonth(now.getFullYear(), now.getMonth()); render(); },
  pickDay: el => {
    ui.sel = el.dataset.d;
    const [y, m] = ui.sel.split('-').map(Number);
    if (y !== ui.y || m - 1 !== ui.m) { ui.y = y; ui.m = m - 1; }
    render();
  },
  newTx: el => { draft = newDraft(el.dataset.date); renderTxSheet(); $('#f-amount').focus(); },
  editTx: el => {
    const t = db.transactions.find(x => x.id === el.dataset.id);
    if (!t) return;
    draft = { genre: '', place: '', note: '', categoryId: null, toAccountId: db.accounts[1]?.id, ...t, amount: String(t.amount) };
    renderTxSheet();
  },
  txType: el => {
    readTxForm();
    draft.type = el.dataset.type;
    if (draft.type !== 'transfer' && catById(draft.categoryId)?.type !== draft.type) {
      draft.categoryId = db.categories.find(c => c.type === draft.type)?.id; draft.genre = '';
    }
    if (draft.type === 'transfer' && draft.toAccountId === draft.accountId) {
      draft.toAccountId = db.accounts.find(a => a.id !== draft.accountId)?.id;
    }
    renderTxSheet();
  },
  txCat: el => { readTxForm(); if (draft.categoryId !== el.dataset.id) draft.genre = ''; draft.categoryId = el.dataset.id; renderTxSheet(); },
  txGenre: el => { readTxForm(); draft.genre = draft.genre === el.dataset.g ? '' : el.dataset.g; renderTxSheet(); },
  saveTx: el => saveTx(el.dataset.again),
  dupTx: () => { readTxForm(); draft = { ...draft, id: null, created: null, date: today() }; renderTxSheet(); toast('Copied — edit and save'); },
  delTx: () => {
    if (!confirm('Delete this entry?')) return;
    db.transactions = db.transactions.filter(t => t.id !== draft.id);
    save(); closeSheet(); render(); toast('Deleted');
  },
  close: closeSheet,
  rtype: el => { ui.rtype = el.dataset.type; render(); },
  ctype: el => { ui.ctype = el.dataset.type; render(); },
  catDetail: el => {
    const id = el.dataset.id || undefined;
    const list = monthTx(ui.y, ui.m).filter(t => t.type === ui.rtype && t.categoryId === id);
    const c = catById(id);
    openSheet(`<div class="sheet-head"><button data-act="close">Close</button><h2>${c?.icon || ''} ${esc(c?.name || 'Uncategorized')}</h2><span style="min-width:60px"></span></div>
      <div class="muted" style="text-align:center">${monthLabel()} · ${money(sum(list, t => t.amount))}</div>${txGroups(list)}`);
  },
  sub: el => { ui.sub = el.dataset.sub; render(); scrollTo(0, 0); },
  back: () => { ui.sub = null; render(); },
  install: async () => { installPrompt?.prompt(); await installPrompt?.userChoice; installPrompt = null; render(); },

  editAcc: el => accountSheet(accById(el.dataset.id)),
  saveAcc: el => {
    const name = $('#a-name').value.trim();
    if (!name) { toast('Name required'); return; }
    const a = { id: el.dataset.id || uid(), name, icon: $('#a-icon').value.trim() || '💳', opening: roundMoney(Number($('#a-opening').value) || 0) };
    const i = db.accounts.findIndex(x => x.id === a.id);
    if (i >= 0) db.accounts[i] = a; else db.accounts.push(a);
    save(); closeSheet(); render();
  },
  delAcc: el => {
    const id = el.dataset.id;
    const used = db.transactions.filter(t => t.accountId === id || t.toAccountId === id).length;
    if (db.accounts.length <= 1) { toast('Keep at least one account'); return; }
    if (!confirm(used ? `${used} entries use this account. They will be kept but show "—" as account. Delete?` : 'Delete this account?')) return;
    db.accounts = db.accounts.filter(a => a.id !== id);
    save(); closeSheet(); render();
  },

  editCat: el => categorySheet(catById(el.dataset.id)),
  saveCat: el => {
    const name = $('#c-name').value.trim();
    if (!name) { toast('Name required'); return; }
    const old = catById(el.dataset.id);
    const c = {
      id: old?.id || uid(), type: old?.type || ui.ctype, name, icon: $('#c-icon').value.trim() || '🏷️', color: $('#c-color').value,
      genres: $('#c-genres').value.split(/[\n,]/).map(s => s.trim()).filter(Boolean),
    };
    if (old) Object.assign(old, c); else db.categories.push(c);
    save(); closeSheet(); render();
  },
  delCat: el => {
    const id = el.dataset.id;
    const used = db.transactions.filter(t => t.categoryId === id).length;
    if (!confirm(used ? `${used} entries use this category. They will show as "Uncategorized". Delete?` : 'Delete this category?')) return;
    db.categories = db.categories.filter(c => c.id !== id);
    delete db.budget.cats[id];
    save(); closeSheet(); render();
  },
  moveCat: el => {
    const c = catById(el.dataset.id);
    const same = db.categories.filter(x => x.type === c.type);
    const j = same.indexOf(c) + Number(el.dataset.d);
    if (j < 0 || j >= same.length) return;
    const a = db.categories.indexOf(c), b = db.categories.indexOf(same[j]);
    [db.categories[a], db.categories[b]] = [db.categories[b], db.categories[a]];
    save(); render();
  },

  exportJson: () => download(`kakeibo-backup-${today()}.json`, JSON.stringify(db, null, 2), 'application/json'),
  exportCsv: () => download(`kakeibo-${today()}.csv`, toCsv(), 'text/csv'),
  importJson: () => $('#importFile').click(),
  sample: () => { addSample(); render(); },
  reset: () => {
    if (!confirm('Erase ALL entries, accounts and categories on this device?')) return;
    if (!confirm('This cannot be undone. Export a backup first if unsure. Erase now?')) return;
    db = defaults(); nf = null; save(); applyTheme(); render(); toast('All data erased');
  },
};

const changes = {
  budgetTotal: el => { db.budget.total = Math.max(0, Number(el.value) || 0); save(); render(); },
  budgetCat: el => {
    const v = Math.max(0, Number(el.value) || 0);
    if (v) db.budget.cats[el.dataset.id] = v; else delete db.budget.cats[el.dataset.id];
    save(); render();
  },
  currency: el => { db.settings.currency = el.value; nf = null; save(); toast('Currency updated'); },
  theme: el => { db.settings.theme = el.value; save(); applyTheme(); },
  weekStart: el => { db.settings.weekStart = Number(el.value); save(); },
  importFile: async el => {
    const file = el.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.transactions) || !Array.isArray(data.categories) || !Array.isArray(data.accounts)) throw new Error('bad file');
      if (!confirm(`Replace current data with backup (${data.transactions.length} entries)?`)) return;
      const d = defaults();
      db = { ...d, ...data, settings: { ...d.settings, ...data.settings }, budget: { ...d.budget, ...data.budget } };
      nf = null; save(); applyTheme(); render(); toast('Backup restored');
    } catch { toast('That file is not a valid backup'); }
    el.value = '';
  },
};

document.addEventListener('click', e => {
  if (e.target === $('#overlay')) { closeSheet(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  e.preventDefault();
  actions[el.dataset.act]?.(el, e);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el) changes[el.dataset.change]?.(el);
});
document.addEventListener('input', e => {
  if (e.target.dataset.input === 'q') { ui.q = e.target.value; $('#txlist').innerHTML = homeList(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#overlay').hidden) closeSheet();
  if (e.key === 'Enter' && e.target.id === 'f-amount') { e.preventDefault(); saveTx(); }
});

/* ---------- PWA ---------- */
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (ui.tab === 'more' && !ui.sub) render(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
}
navigator.storage?.persist?.();

applyTheme();
render();
// Home-screen shortcut ("Add expense") opens straight into the entry sheet.
if (new URLSearchParams(location.search).has('add')) {
  history.replaceState(null, '', location.pathname);
  actions.newTx({ dataset: {} });
}

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

// Units per 1 USD. Offline fallback only — refreshed from the internet when online.
const DEFAULT_RATES = {
  USD: 1, PHP: 62.8, JPY: 158.3, EUR: 0.86, GBP: 0.75, AUD: 1.53, CAD: 1.39, SGD: 1.3, HKD: 7.78, KRW: 1420,
  CNY: 7.12, INR: 88.5, IDR: 16500, MYR: 4.22, THB: 32.5, VND: 26300, AED: 3.67, SAR: 3.75, NZD: 1.74, CHF: 0.8,
};
const ALL_CURRENCIES = Object.keys(DEFAULT_RATES);

/* ---------- data ---------- */
function defaults() {
  let order = 0;
  const cat = (type, name, icon, color, genres = []) => ({ id: uid(), type, name, icon, color, genres, order: order++ });
  return {
    version: 3,
    settings: { currency: 'PHP', currencies: ['PHP', 'JPY', 'USD'], theme: 'auto', weekStart: 0, autoRates: true },
    accounts: [
      { id: uid(), name: 'Cash', icon: '👛', currency: 'PHP', opening: 0 },
      { id: uid(), name: 'Bank', icon: '🏦', currency: 'PHP', opening: 0 },
      { id: uid(), name: 'Credit card', icon: '💳', currency: 'PHP', opening: 0 },
      { id: uid(), name: 'Yen wallet', icon: '💴', currency: 'JPY', opening: 0 },
      { id: uid(), name: 'Dollar account', icon: '💵', currency: 'USD', opening: 0 },
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
    budget: { total: 0, cats: {}, currency: 'PHP' },
    recurring: [], // rules for repeating entries (rent, subscriptions…) — see recurring.js
    fx: { rates: { ...DEFAULT_RATES }, updated: 0, source: 'built-in estimate' },
    deleted: {}, // id -> time deleted, so deletions sync between devices
  };
}

// Fills in fields added in later versions so old saves and backups keep working.
function migrate(raw) {
  const d = defaults();
  const data = {
    ...d, ...raw,
    settings: { ...d.settings, ...raw.settings },
    budget: { ...d.budget, ...raw.budget },
    fx: { ...d.fx, ...raw.fx, rates: { ...DEFAULT_RATES, ...raw.fx?.rates } },
  };
  const s = data.settings;
  if (!Array.isArray(raw.settings?.currencies)) s.currencies = [s.currency];
  if (!s.currencies.includes(s.currency)) s.currencies.unshift(s.currency);
  if (!raw.budget?.currency) data.budget.currency = s.currency;
  for (const a of data.accounts) a.currency ||= s.currency;
  for (const t of data.transactions) {
    t.currency ||= data.accounts.find(a => a.id === t.accountId)?.currency || s.currency;
    // Entries from before rate-locking: freeze at current rates now; lockHistoricalRates() refines to the entry's date.
    t.fx ||= { rates: Object.fromEntries([...new Set([...s.currencies, 'USD'])].map(c => [c, data.fx.rates[c] || DEFAULT_RATES[c]])), date: '' };
  }
  data.categories.forEach((c, i) => { c.order ??= i; });
  data.categories.sort((a, b) => a.order - b.order);
  data.deleted = { ...raw.deleted };
  data.recurring = Array.isArray(raw.recurring) ? raw.recurring : [];
  data.version = d.version;
  return data;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.transactions)) return migrate(raw);
  } catch (e) { console.warn('Could not read saved data', e); }
  return defaults();
}

let db = load();

// Change tracking for sync: compares every record with how it looked at the last save, stamps
// `updated` on anything that changed and records deletions. No call site has to remember to do it.
let baseline = null;
function snapshotDb(stamp) {
  const now = Date.now(), snap = new Map();
  let changed = false;
  const visit = (key, obj) => {
    const { updated, ...rest } = obj;
    const json = JSON.stringify(rest);
    snap.set(key, json);
    if (stamp && baseline?.get(key) !== json) { obj.updated = now; changed = true; }
  };
  visit('settings', db.settings); visit('budget', db.budget); visit('fx', db.fx);
  for (const coll of ['accounts', 'categories', 'transactions', 'recurring']) for (const r of db[coll]) visit(`${coll}:${r.id}`, r);
  if (stamp && baseline) {
    for (const key of baseline.keys()) {
      const id = key.split(':')[1];
      if (id && !snap.has(key)) { db.deleted[id] = now; changed = true; }
    }
  }
  baseline = snap;
  return changed;
}
snapshotDb(false);

function writeLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); return true; }
  catch (e) { toast('⚠️ Could not save — storage may be full'); return false; }
}
function save() {
  const changed = snapshotDb(true);
  if (writeLocal() && changed && typeof onLocalChange === 'function') onLocalChange();
}
// Used when data arrives from sync: store it without treating it as a local edit.
function replaceDb(next) {
  db = next;
  snapshotDb(false);
  writeLocal();
}

const catById = id => db.categories.find(c => c.id === id);
const accById = id => db.accounts.find(a => a.id === id);
const accName = id => accById(id)?.name ?? '—';
const monthTx = (y, m) => db.transactions.filter(t => t.date.startsWith(ymKey(y, m)));
const byNewest = (a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0);

/* ---------- currency ---------- */
const disp = () => db.settings.currency; // currency all totals are shown in
const txCur = t => t.currency || accById(t.accountId)?.currency || disp();
const rate = c => db.fx.rates[c] || DEFAULT_RATES[c]; // current units per 1 USD
// Converts at current rates — used for account values, budgets and previews.
function conv(n, from, to = disp()) {
  if (from === to) return n;
  const a = rate(from), b = rate(to);
  return a && b ? n / a * b : n;
}
// Converts an entry at the rates locked in when it was recorded (falls back to current for currencies added later).
function txConv(t, to = disp(), n = t.amount) {
  const from = txCur(t);
  if (from === to) return n;
  const r = t.fx?.rates || {};
  const a = r[from] || rate(from), b = r[to] || rate(to);
  return a && b ? n / a * b : n;
}
const val = t => txConv(t); // entry amount in the display currency
const snapshot = () => Object.fromEntries([...new Set([...db.settings.currencies, 'USD'])].map(c => [c, rate(c)]));
// Price of 1 unit of `cur` in the display currency, per a draft's locked rates (or today's).
const draftRate = d => { const r = d.fx?.rates || {}; return (r[disp()] || rate(disp())) / (r[d.currency] || rate(d.currency)); };

const fmts = new Map();
function fmt(cur) {
  if (!fmts.has(cur)) fmts.set(cur, new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }));
  return fmts.get(cur);
}
const money = (n, cur = disp()) => fmt(cur).format(n);
function roundMoney(n, cur = disp()) {
  const f = fmt(cur).resolvedOptions().maximumFractionDigits;
  return Math.round(n * 10 ** f) / 10 ** f;
}
function currencySymbol(cur = disp()) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find(p => p.type === 'currency').value;
  } catch { return cur; }
}
const compact = n => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

async function refreshRates(manual) {
  const sources = [
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/USD', j => j.result === 'success' && j.rates],
    ['frankfurter.dev', 'https://api.frankfurter.dev/v1/latest?base=USD', j => j.rates && { USD: 1, ...j.rates }],
  ];
  for (const [source, url, pick] of sources) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const rates = res.ok && pick(await res.json());
      if (rates && db.settings.currencies.every(c => rates[c] || db.fx.rates[c])) {
        db.fx = { rates: { ...db.fx.rates, ...rates }, updated: Date.now(), source };
        save(); render();
        if (manual) toast('Exchange rates updated');
        return;
      }
    } catch { /* try next source */ }
  }
  if (manual) toast('Could not update rates — are you offline?');
}

// Replaces entry-time rates with the actual rate on each past entry's date (ECB data via frankfurter.dev,
// using the last business day on or before the date). Manually set rates are never touched.
let lockingRates = false;
async function lockHistoricalRates() {
  const td = today();
  const pending = db.transactions.filter(t => t.date < td && t.fx?.date !== t.date && !t.fx?.manual);
  if (!pending.length || !navigator.onLine || lockingRates) return;
  lockingRates = true;
  try {
    const start = pending.reduce((m, t) => t.date < m ? t.date : m, td);
    const syms = db.settings.currencies.filter(c => c !== 'USD').join(',');
    const res = await fetch(`https://api.frankfurter.dev/v1/${start}..${td}?base=USD&symbols=${syms}`, { cache: 'no-store' });
    if (!res.ok) return;
    const series = (await res.json()).rates || {};
    const days = Object.keys(series).sort();
    for (const t of pending) {
      let day = null;
      for (const k of days) { if (k <= t.date) day = k; else break; }
      if (!day) continue;
      t.fx = { rates: { ...t.fx?.rates, USD: 1, ...series[day] }, date: t.date, source: `ECB ${day}` };
    }
    save(); render();
  } catch { /* offline or API down — entries keep their entry-time rates and retry next launch */ }
  finally { lockingRates = false; }
}

/* ---------- totals ---------- */
function totals(list) {
  let inc = 0, exp = 0;
  for (const t of list) { if (t.type === 'income') inc += val(t); else if (t.type === 'expense') exp += val(t); }
  return { inc, exp, net: inc - exp };
}

// Balance in the account's own currency.
function accBalance(id) {
  const a = accById(id);
  if (!a) return 0;
  let bal = a.opening || 0;
  for (const t of db.transactions) {
    if (t.accountId === id) {
      const amt = txConv(t, a.currency);
      bal += t.type === 'income' ? amt : -amt;
    }
    if (t.type === 'transfer' && t.toAccountId === id) {
      bal += t.toAmount != null ? conv(t.toAmount, t.toCurrency || a.currency, a.currency) : txConv(t, a.currency);
    }
  }
  return bal;
}

/* ---------- formatting ---------- */
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
    sub = [t.toAmount != null && `received ${money(t.toAmount, t.toCurrency)}`, t.note].filter(Boolean).join(' · ') || 'Transfer';
  } else {
    const c = catById(t.categoryId);
    icon = c?.icon || '❔'; color = c?.color || '#94a3b8';
    title = t.place || t.genre || c?.name || 'Uncategorized';
    sub = [c?.name, t.genre, accName(t.accountId), t.note].filter(Boolean).join(' · ');
  }
  if (t.recurringId) sub = `🔁 ${sub}`;
  const cur = txCur(t);
  const cls = t.type === 'expense' ? 'neg' : t.type === 'income' ? 'pos' : 'muted';
  const sign = t.type === 'expense' ? '−' : t.type === 'income' ? '+' : '';
  const approx = cur !== disp() ? `<small>≈ ${money(val(t))}</small>` : '';
  return `<button class="row" data-act="editTx" data-id="${t.id}">
    <span class="ico" style="background:${color}26">${icon}</span>
    <span class="main"><span class="t">${esc(title)}</span><span class="sub">${esc(sub)}</span></span>
    <span class="amt ${cls}">${sign}${money(t.amount, cur)}${approx}</span></button>`;
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
const budgetIn = v => conv(Number(v) || 0, db.budget.currency); // budget amount in display currency
const leftLabel = (spent, limit, cur = disp()) => spent > limit
  ? `<span class="neg">Over by ${money(spent - limit, cur)}</span>`
  : `${money(limit - spent, cur)} left`;

// Budget card for Home: overall budget plus every category that has one, most-used first.
function budgetCard(list) {
  const exp = totals(list).exp;
  const B = budgetIn(db.budget.total);
  const spent = new Map();
  for (const t of list) if (t.type === 'expense') spent.set(t.categoryId, (spent.get(t.categoryId) || 0) + val(t));
  const cats = db.categories
    .filter(c => c.type === 'expense' && Number(db.budget.cats[c.id]) > 0)
    .map(c => ({ c, limit: budgetIn(db.budget.cats[c.id]), spent: spent.get(c.id) || 0 }))
    .sort((a, b) => b.spent / b.limit - a.spent / a.limit);
  if (!(B > 0) && !cats.length) return '';
  let html = '<div class="card">';
  if (B > 0) {
    html += `<div class="budget-line"><b>Monthly budget</b><span>${leftLabel(exp, B)}</span></div>
      ${bar(exp, B)}<div class="budget-line muted" style="margin-top:4px;font-size:12px"><span>Spent ${money(exp)}</span><span>of ${money(B)}</span></div>`;
  }
  if (cats.length) {
    html += `<div class="budget-cats" ${B > 0 ? '' : 'style="border-top:0;margin-top:0;padding-top:0"'}>`;
    for (const { c, limit, spent: s } of cats) {
      html += `<button class="budget-cat" data-act="catDetail" data-id="${c.id}" data-type="expense">
        <div class="budget-line"><span>${c.icon} ${esc(c.name)}</span><span>${leftLabel(s, limit)}</span></div>
        ${bar(s, limit)}<div class="budget-line muted" style="font-size:11px;margin-top:2px"><span>${money(s)}</span><span>of ${money(limit)}</span></div></button>`;
    }
    html += '</div>';
  }
  return html + '</div>';
}

/* ---------- views ---------- */
function viewHome() {
  const list = monthTx(ui.y, ui.m);
  const { inc, exp, net } = totals(list);
  let html = typeof summaryBanner === 'function' ? summaryBanner() : '';
  html += `<div class="card summary">
    <div><small>Income</small><b class="pos">${money(inc)}</b></div>
    <div><small>Expense</small><b class="neg">${money(exp)}</b></div>
    <div><small>Balance</small><b>${money(net)}</b></div></div>`;
  html += budgetCard(list);
  if (typeof upcomingCard === 'function') html += upcomingCard();
  html += `<input class="search" type="search" placeholder="Search this month…" value="${esc(ui.q)}" data-input="q">`;
  return html + `<div id="txlist">${homeList(list)}</div>`;
}

function homeList(list = monthTx(ui.y, ui.m)) {
  const q = ui.q.trim().toLowerCase();
  const shown = q ? list.filter(t => {
    const c = catById(t.categoryId);
    return [t.place, t.note, t.genre, c?.name, accName(t.accountId), txCur(t), String(t.amount)].join(' ').toLowerCase().includes(q);
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
    if (t.type === 'income') d.inc += val(t); else d.exp += val(t);
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
  const total = sum(list, val);
  const by = new Map();
  for (const t of list) by.set(t.categoryId, (by.get(t.categoryId) || 0) + val(t));
  const rows = [...by].map(([id, amt]) => ({ c: catById(id), id, amt })).sort((a, b) => b.amt - a.amt);

  let html = `<div class="seg" style="margin-top:12px">
    <button data-act="rtype" data-type="expense" class="${type === 'expense' ? 'on' : ''}">Expense</button>
    <button data-act="rtype" data-type="income" class="${type === 'income' ? 'on' : ''}">Income</button></div>`;
  if (typeof openSummary === 'function' && all.length) {
    html += `<button class="btn secondary" data-act="openSummary" data-month="${ymKey(ui.y, ui.m)}">📋 ${esc(monthLabel())} summary</button>`;
  }

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
      const budget = type === 'expense' ? budgetIn(db.budget.cats[r.id]) : 0;
      html += `<button class="row" data-act="catDetail" data-id="${r.id ?? ''}">
        <span class="ico" style="background:${r.c?.color || '#94a3b8'}26">${r.c?.icon || '❔'}</span>
        <span class="main"><span class="t">${esc(r.c?.name || 'Uncategorized')}</span>
          <span class="sub">${(r.amt / total * 100).toFixed(1)}%${budget ? ` · ${leftLabel(r.amt, budget)} of ${money(budget)}` : ''}</span>
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
  html += `<div class="section-title"><span>Last 6 months</span><span>${disp()}</span></div>
    <div class="card bars"><svg viewBox="0 0 ${W} ${H}"><line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--line)"/>${bars}</svg>
    <div class="legend"><span><i class="dot" style="background:var(--income)"></i> Income</span><span><i class="dot" style="background:var(--expense)"></i> Expense</span></div></div>`;
  return html;
}

const SUBS = { sync: ['🔄', 'Sync devices'], accounts: ['🏦', 'Accounts'], recurring: ['🔁', 'Recurring'], budget: ['🎯', 'Budget'], categories: ['🏷️', 'Categories'], currencies: ['💱', 'Currencies & rates'], data: ['💾', 'Backup & data'], settings: ['⚙️', 'Settings'] };

function viewMore() {
  if (ui.sub) return SUBVIEWS[ui.sub]();
  let html = '<div class="list" style="margin-top:12px">';
  for (const [k, [icon, name]] of Object.entries(SUBS)) {
    const sub = k === 'sync' && typeof syncSummary === 'function' ? `<span class="sub">${esc(syncSummary())}</span>` : '';
    html += `<button class="row" data-act="sub" data-sub="${k}"><span class="ico" style="background:var(--chip)">${icon}</span><span class="main"><span class="t">${name}</span>${sub}</span><span class="muted">›</span></button>`;
  }
  html += '</div>';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (installPrompt) html += '<button class="btn" data-act="install">📲 Install app</button>';
  else if (!standalone && /iphone|ipad/i.test(navigator.userAgent)) html += '<div class="card muted">To install: tap the Share button, then <b>Add to Home Screen</b>.</div>';
  html += `<div class="card muted" style="font-size:13px">Kakeibo stores everything on this device and works offline. Use <b>Backup &amp; data</b> to export regularly.</div>`;
  return html;
}

const curOptions = (sel, list = db.settings.currencies) =>
  [...new Set([...list, sel])].map(c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${currencySymbol(c)} ${c}</option>`).join('');

const SUBVIEWS = {
  accounts() {
    const total = sum(db.accounts, a => conv(accBalance(a.id), a.currency));
    let html = `<div class="card summary" style="grid-template-columns:1fr"><div><small>Net worth (${disp()})</small><b class="${total < 0 ? 'neg' : ''}" style="font-size:22px">${money(total)}</b></div></div><div class="list">`;
    for (const a of db.accounts) {
      const b = accBalance(a.id);
      const approx = a.currency !== disp() ? `<small>≈ ${money(conv(b, a.currency))}</small>` : '';
      html += `<button class="row" data-act="editAcc" data-id="${a.id}"><span class="ico" style="background:var(--chip)">${esc(a.icon)}</span>
        <span class="main"><span class="t">${esc(a.name)}</span><span class="sub">${a.currency}</span></span>
        <span class="amt ${b < 0 ? 'neg' : ''}">${money(b, a.currency)}${approx}</span></button>`;
    }
    return html + '</div><button class="btn secondary" data-act="editAcc">＋ Add account</button>';
  },

  budget() {
    const bc = db.budget.currency;
    const spent = new Map();
    const list = monthTx(ui.y, ui.m).filter(t => t.type === 'expense');
    for (const t of list) spent.set(t.categoryId, (spent.get(t.categoryId) || 0) + txConv(t, bc));
    const totalSpent = sum([...spent.values()]);
    let html = `<div class="form"><div class="field"><label>Budget in</label><select data-change="budgetCurrency">${curOptions(bc)}</select></div></div>
      <div class="card"><div class="budget-line"><b>Monthly total</b>
      <input class="budget-input" type="number" min="0" inputmode="decimal" placeholder="None" value="${db.budget.total || ''}" data-change="budgetTotal"></div>
      ${db.budget.total ? bar(totalSpent, db.budget.total) + `<div class="budget-line muted" style="font-size:12px;margin-top:4px"><span>${monthLabel()}: spent ${money(totalSpent, bc)}</span><span>${leftLabel(totalSpent, db.budget.total, bc)}</span></div>` : ''}</div>
      <div class="section-title"><span>By category</span><span>${bc}</span></div><div class="list">`;
    for (const c of db.categories.filter(c => c.type === 'expense')) {
      const b = Number(db.budget.cats[c.id]) || 0, s = spent.get(c.id) || 0;
      html += `<div class="row"><span class="ico" style="background:${c.color}26">${c.icon}</span>
        <span class="main"><span class="t">${esc(c.name)}</span><span class="sub">${b ? `${leftLabel(s, b, bc)} · spent ${money(s, bc)}` : `Spent ${money(s, bc)}`}</span>${b ? bar(s, b) : ''}</span>
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

  currencies() {
    const s = db.settings, d = disp();
    const updated = db.fx.updated ? new Date(db.fx.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never (using built-in estimates)';
    let html = `<div class="form"><div class="field"><label>Show totals in</label><select data-change="currency">${curOptions(d)}</select></div></div>
      <div class="muted" style="font-size:13px;padding:0 4px">You can also tap the currency button at the top of Home, Calendar and Report to switch.</div>
      <div class="section-title"><span>My currencies</span></div>
      <div class="chips">${ALL_CURRENCIES.map(c => `<button data-act="toggleCur" data-c="${c}" class="${s.currencies.includes(c) ? 'on' : ''}">${currencySymbol(c)} ${c}</button>`).join('')}</div>
      <div class="section-title"><span>Exchange rates</span><span>in ${d}</span></div><div class="form">`;
    for (const c of s.currencies.filter(c => c !== d)) {
      const r = conv(1, c, d);
      html += `<div class="field"><label>1 ${c} =</label><input type="number" inputmode="decimal" step="any" min="0" value="${Number(r.toPrecision(6))}" data-change="rate" data-c="${c}"><span class="muted">${d}</span></div>`;
    }
    html += `</div>
      <div class="muted" style="font-size:13px;padding:0 4px">Updated ${esc(updated)}${db.fx.updated ? ` · ${esc(db.fx.source)}` : ''}.
        These rates apply to account balances, net worth and budgets. Each entry keeps the rate from its own date (open an entry to see or change it).</div>
      <div class="form"><div class="field"><label for="autoRates" style="flex:1;width:auto">Auto-update rates when online</label><input id="autoRates" type="checkbox" style="flex:none;width:22px;height:22px" ${s.autoRates ? 'checked' : ''} data-change="autoRates"></div></div>
      <button class="btn secondary" data-act="refreshRates">↻ Update rates now</button>`;
    return html;
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
    const s = db.settings;
    return `<div class="form">
      <div class="field"><label>Currency</label><button class="row" style="padding:10px 0;border:0" data-act="sub" data-sub="currencies"><span class="main"><span class="t">${currencySymbol(s.currency)} ${s.currency}</span></span><span class="muted">›</span></button></div>
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
    const curBtn = db.settings.currencies.length > 1
      ? `<button class="cur-chip" data-act="cycleCur" aria-label="Change display currency">${esc(currencySymbol())} ${disp()}</button>` : '';
    top.innerHTML = `<button class="icon-btn" data-act="month" data-d="-1" aria-label="Previous month">‹</button>
      <h1 data-act="thisMonth">${monthLabel()}</h1>
      <button class="icon-btn" data-act="month" data-d="1" aria-label="Next month">›</button>${curBtn}${typeof syncBadge === 'function' ? syncBadge() : ''}`;
  }
  const views = { home: viewHome, calendar: viewCalendar, report: viewReport, more: viewMore };
  $('#view').innerHTML = views[ui.tab]();
  document.querySelectorAll('#tabbar [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  if (typeof scheduleSummaryCache === 'function') scheduleSummaryCache();
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
  const acc = db.accounts[0];
  return {
    id: null, type: 'expense', date: date || defaultDate(), amount: '', currency: acc?.currency || disp(),
    categoryId: first?.id, genre: '', accountId: acc?.id, toAccountId: db.accounts[1]?.id, toAmount: '', place: '', note: '',
  };
}
// New entries default to today, or the 1st of the viewed month if browsing another month.
const defaultDate = () => ymKey(ui.y, ui.m) === today().slice(0, 7) ? today() : `${ymKey(ui.y, ui.m)}-01`;

function readTxForm() {
  if (!draft) return;
  for (const k of ['amount', 'date', 'place', 'note', 'accountId', 'toAccountId', 'toAmount', 'rate', 'repeat']) {
    const el = $('#f-' + k);
    if (el) draft[k] = el.value;
  }
}

const fmtRate = r => String(Number(r.toPrecision(6)));
// Rate used for the live "≈" preview: whatever is typed in the rate field, else the draft's locked/current rate.
const previewRate = () => Number($('#f-rate')?.value) || draftRate(draft);

function rateNote(d) {
  const fx = d.fx;
  if (!d.id || !fx) return d.date < today() ? 'The rate for this date is looked up automatically when online.' : "Today's rate is locked in when you save.";
  if (fx.manual) return 'Rate set manually.';
  if (fx.date === d.date) return `Locked: ${fx.source ? fx.source.replace('ECB', 'ECB rate of') : 'rate on the day it was recorded'}.`;
  return 'Locked at entry time; the rate for this date will be looked up when online.';
}

function renderTxSheet() {
  const d = draft;
  const cats = db.categories.filter(c => c.type === d.type);
  const cat = catById(d.categoryId);
  const accOpts = sel => db.accounts.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.icon)} ${esc(a.name)} (${a.currency})</option>`).join('');
  const places = [...new Set(db.transactions.filter(t => t.place && t.type === d.type).sort(byNewest).map(t => t.place))].slice(0, 40);
  const toCur = accById(d.toAccountId)?.currency;
  const amt = parseAmount(d.amount);
  const foreign = d.currency !== disp();
  const locked = fmtRate(draftRate(d));
  const shownRate = d.rate ?? locked;
  const approx = foreign && amt > 0 ? `≈ ${money(amt * (Number(shownRate) || draftRate(d)))}` : '';

  openSheet(`<div class="t-${d.type}">
    <div class="sheet-head"><button data-act="close">Cancel</button><h2>${d.id ? 'Edit entry' : 'New entry'}</h2><button data-act="saveTx">Save</button></div>
    <div class="seg">${['expense', 'income', 'transfer'].map(t => `<button data-act="txType" data-type="${t}" class="${d.type === t ? 'on' : ''}">${TYPE_LABEL[t]}</button>`).join('')}</div>
    ${d.type === 'expense' && typeof scanSection === 'function' ? scanSection(d) : ''}
    <div class="amount-input">
      <button type="button" class="cur-chip" data-act="txCur" aria-label="Change entry currency">${esc(currencySymbol(d.currency))} ${d.currency}</button>
      <input id="f-amount" inputmode="decimal" placeholder="0" value="${esc(d.amount)}" autocomplete="off" aria-label="Amount" data-input="amount"></div>
    <div class="approx muted" id="f-approx">${approx}</div>
    ${d.type !== 'transfer' ? `<div class="cats">${cats.map(c => `<button type="button" data-act="txCat" data-id="${c.id}" class="${c.id === d.categoryId ? 'on' : ''}"><i>${c.icon}</i>${esc(c.name)}</button>`).join('')}</div>
      ${cat?.genres.length ? `<div class="chips">${cat.genres.map(g => `<button type="button" data-act="txGenre" data-g="${esc(g)}" class="${g === d.genre ? 'on' : ''}">${esc(g)}</button>`).join('')}</div>` : ''}` : ''}
    <div class="form">
      <div class="field"><label>Date</label><input id="f-date" type="date" value="${d.date}" required></div>
      ${d.type === 'transfer'
        ? `<div class="field"><label>From</label><select id="f-accountId" data-change="txAccount">${accOpts(d.accountId)}</select></div>
           <div class="field"><label>To</label><select id="f-toAccountId" data-change="txAccount">${accOpts(d.toAccountId)}</select></div>
           ${toCur && toCur !== d.currency ? `<div class="field"><label>Received (${toCur})</label><input id="f-toAmount" inputmode="decimal" value="${esc(d.toAmount)}" placeholder="Auto: today's rate"></div>` : ''}`
        : `<div class="field"><label>${d.type === 'income' ? 'Into' : 'Paid with'}</label><select id="f-accountId" data-change="txAccount">${accOpts(d.accountId)}</select></div>
           <div class="field"><label>${d.type === 'income' ? 'From' : 'Place'}</label><input id="f-place" list="places" value="${esc(d.place)}" placeholder="${d.type === 'income' ? 'Employer, client…' : 'Store, restaurant…'}" autocomplete="off"></div>
           <datalist id="places">${places.map(p => `<option value="${esc(p)}">`).join('')}</datalist>`}
      <div class="field"><label>Memo</label><input id="f-note" value="${esc(d.note)}" placeholder="Optional"></div>
      ${typeof repeatField === 'function' ? repeatField(d) : ''}
      ${foreign ? `<div class="field"><label>Rate</label><span class="muted" style="flex:none">1 ${d.currency} =</span>
        <input id="f-rate" type="number" inputmode="decimal" step="any" min="0" value="${esc(shownRate)}" data-input="rate" data-locked="${locked}" style="text-align:right"><span class="muted" style="flex:none">${disp()}</span></div>` : ''}
    </div>
    ${foreign ? `<div class="muted" style="font-size:12px;padding:0 4px">${esc(rateNote(d))} Change the rate to match what your card or exchange actually charged.</div>` : ''}
    <button class="btn" data-act="saveTx">Save</button>
    ${d.id ? '<button class="btn secondary" data-act="dupTx">Duplicate as new</button><button class="btn danger" data-act="delTx">Delete</button>'
           : '<button class="btn secondary" data-act="saveTx" data-again="1">Save &amp; add another</button>'}
  </div>`);
  if (typeof afterTxSheet === 'function') afterTxSheet(d);
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
  const cur = d.currency || disp();
  const amount = roundMoney(parseAmount(d.amount), cur);
  if (!(amount > 0) || !isFinite(amount)) { toast('Enter an amount'); $('#f-amount')?.focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) { toast('Pick a date'); return; }
  if (d.type === 'transfer' && d.accountId === d.toAccountId) { toast('Choose two different accounts'); return; }
  // Rate lock: keep the existing lock unless the date or currency changed; otherwise freeze today's rates.
  const old = db.transactions.find(t => t.id === d.id);
  let fx = old?.fx && old.date === d.date && txCur(old) === cur ? old.fx : { rates: snapshot(), date: today() };
  const typed = Number(d.rate);
  if (cur !== disp() && d.rate != null && d.rate !== fmtRate(draftRate(d)) && typed > 0) {
    const rates = { ...fx.rates };
    rates[disp()] ||= rate(disp());
    rates[cur] = rates[disp()] / typed;
    fx = { rates, date: d.date, manual: true };
  }
  const tx = { id: d.id || uid(), type: d.type, date: d.date, amount, currency: cur, fx, accountId: d.accountId, note: d.note.trim(), created: d.created || Date.now() };
  if (d.type === 'transfer') {
    tx.toAccountId = d.toAccountId;
    const toCur = accById(d.toAccountId)?.currency || cur;
    if (toCur !== cur) {
      const received = parseAmount(d.toAmount);
      tx.toAmount = roundMoney(received > 0 ? received : txConv(tx, toCur), toCur);
      tx.toCurrency = toCur;
    }
  } else Object.assign(tx, { categoryId: d.categoryId, genre: d.genre, place: d.place.trim() });
  if (d.recurringId) tx.recurringId = d.recurringId;
  if (typeof beforeSaveTx === 'function') beforeSaveTx(d, tx); // may turn a new entry into a recurring series

  const i = db.transactions.findIndex(t => t.id === tx.id);
  if (i >= 0) db.transactions[i] = tx; else db.transactions.push(tx);
  save();
  if (i < 0 && tx.recurringId && typeof runRecurring === 'function') runRecurring();
  const [y, m] = tx.date.split('-').map(Number);
  if (y !== ui.y || m - 1 !== ui.m) { ui.y = y; ui.m = m - 1; }
  ui.sel = tx.date;
  render();
  toast(i >= 0 ? 'Updated' : 'Saved');
  if (tx.date < today() && !fx.manual && fx.date !== tx.date) lockHistoricalRates();
  if (again) {
    draft = { ...newDraft(tx.date), type: d.type, currency: cur, categoryId: d.categoryId, accountId: d.accountId, toAccountId: d.toAccountId };
    renderTxSheet();
    $('#f-amount').focus();
  } else closeSheet();
}

/* ---------- account / category sheets ---------- */
function accountSheet(a) {
  a ||= { id: null, name: '', icon: '💳', currency: disp(), opening: 0 };
  openSheet(`<div class="sheet-head"><button data-act="close">Cancel</button><h2>${a.id ? 'Edit account' : 'New account'}</h2><button data-act="saveAcc" data-id="${a.id || ''}">Save</button></div>
    <div class="form">
      <div class="field"><label>Name</label><input id="a-name" value="${esc(a.name)}" placeholder="e.g. GCash, Savings"></div>
      <div class="field"><label>Icon</label><input id="a-icon" value="${esc(a.icon)}" maxlength="4"></div>
      <div class="field"><label>Currency</label><select id="a-currency">${curOptions(a.currency)}</select></div>
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

/* ---------- deleting an account or category that's in use ---------- */
const refKeys = kind => (kind === 'account' ? ['accountId', 'toAccountId'] : ['categoryId']);
function usageOf(kind, id) {
  const uses = o => refKeys(kind).some(k => o?.[k] === id);
  return { entries: db.transactions.filter(uses), rules: (db.recurring || []).filter(r => uses(r.template)) };
}

// Entries and recurring series that use the item can be moved elsewhere. Series must be moved, or every
// future rent/subscription entry would be created without an account or category.
function deleteSheet(kind, id) {
  const isAcc = kind === 'account';
  const item = isAcc ? accById(id) : catById(id);
  if (!item) return;
  const { entries, rules } = usageOf(kind, id);
  if (!entries.length && !rules.length) {
    if (confirm(`Delete "${item.name}"?`)) finishDelete(kind, id, null);
    return;
  }
  const others = isAcc ? db.accounts.filter(a => a.id !== id) : db.categories.filter(c => c.type === item.type && c.id !== id);
  if (!others.length) { toast(`Add another ${item.type} category first, so its entries have somewhere to go`); return; }
  const seriesNames = rules.map(r => (typeof ruleName === 'function' ? ruleName(r) : 'recurring entry'));
  const used = [
    entries.length && `<b>${entries.length}</b> ${entries.length === 1 ? 'entry' : 'entries'}`,
    rules.length && `<b>${rules.length}</b> recurring series (${esc(seriesNames.join(', '))})`,
  ].filter(Boolean).join(' and ');
  const label = o => `${esc(o.icon)} ${esc(o.name)}${isAcc ? ` (${o.currency})` : ''}`;
  const keepOption = rules.length ? '' : `<option value="">Don't move — show as ${isAcc ? '"—"' : '"Uncategorized"'}</option>`;
  openSheet(`<div class="sheet-head"><button data-act="close">Cancel</button><h2>Delete ${isAcc ? 'account' : 'category'}</h2><span style="min-width:60px"></span></div>
    <div class="card">${label(item)} is used by ${used}.</div>
    <div class="form"><div class="field"><label>Move them to</label><select id="del-target">${others.map(o => `<option value="${o.id}">${label(o)}</option>`).join('')}${keepOption}</select></div></div>
    <div class="muted" style="font-size:13px;padding:0 4px">${[
      rules.length && 'Recurring series have to move so future entries still have ' + (isAcc ? 'an account.' : 'a category.'),
      isAcc && "Moved entries keep their own currency and count toward the new account's balance.",
    ].filter(Boolean).join(' ')}</div>
    <button class="btn btn-danger" data-act="confirmDelete" data-kind="${kind}" data-id="${id}">Delete "${esc(item.name)}"</button>`);
}

function finishDelete(kind, id, target) {
  const isAcc = kind === 'account';
  const item = isAcc ? accById(id) : catById(id);
  if (target) {
    for (const o of [...db.transactions, ...(db.recurring || []).map(r => r.template)]) {
      for (const k of refKeys(kind)) if (o[k] === id) o[k] = target;
    }
  }
  if (isAcc) db.accounts = db.accounts.filter(a => a.id !== id);
  else { db.categories = db.categories.filter(c => c.id !== id); delete db.budget.cats[id]; }
  save(); closeSheet(); render();
  const to = target && (isAcc ? accById(target) : catById(target));
  toast(`Deleted "${item?.name}"${to ? ` — moved to ${to.name}` : ''}`);
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
  const rows = [['Date', 'Type', 'Category', 'Genre', 'Account', 'To account', 'Amount', 'Currency', 'Received', 'Received currency', 'Place', 'Memo']];
  for (const t of [...db.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([t.date, t.type, catById(t.categoryId)?.name ?? '', t.genre ?? '', accName(t.accountId),
      t.type === 'transfer' ? accName(t.toAccountId) : '', t.amount, txCur(t), t.toAmount ?? '', t.toCurrency ?? '', t.place ?? '', t.note ?? '']);
  }
  return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
}

function addSample() {
  const exp = db.categories.filter(c => c.type === 'expense');
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const places = ['7-Eleven', 'SM Supermarket', 'Jollibee', 'Starbucks', 'Mercury Drug', 'Shopee', 'Grab', 'Puregold', 'Lazada', 'Market'];
  const salary = db.categories.find(c => c.type === 'income');
  const pesoAcc = db.accounts.find(a => a.currency === 'PHP') || db.accounts[0];
  for (let mo = 0; mo < 3; mo++) {
    const base = new Date(now.getFullYear(), now.getMonth() - mo, 1);
    const days = mo === 0 ? now.getDate() : new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    if (salary) db.transactions.push({ id: uid(), type: 'income', date: ymd(base), amount: 35000, currency: pesoAcc.currency, categoryId: salary.id, genre: '', accountId: pesoAcc.id, place: 'Employer', note: '', created: Date.now() });
    for (let i = 0; i < days * 1.5; i++) {
      const c = pick(exp), acc = pick(db.accounts);
      db.transactions.push({
        id: uid(), type: 'expense', date: ymd(new Date(base.getFullYear(), base.getMonth(), 1 + Math.floor(Math.random() * days))),
        amount: roundMoney(conv(50 + Math.random() * 900, 'PHP', acc.currency), acc.currency), currency: acc.currency,
        categoryId: c.id, genre: c.genres.length ? pick(c.genres) : '', accountId: acc.id, place: pick(places), note: '', created: Date.now(),
      });
    }
  }
  for (const t of db.transactions) t.fx ||= { rates: snapshot(), date: '' };
  save(); toast('Sample data added');
  lockHistoricalRates();
}

/* ---------- events ---------- */
const actions = {
  tab: el => { ui.tab = el.dataset.tab; ui.sub = null; render(); scrollTo(0, 0); },
  month: el => { setMonth(ui.y, ui.m + Number(el.dataset.d)); render(); },
  thisMonth: () => { setMonth(now.getFullYear(), now.getMonth()); render(); },
  cycleCur: () => {
    const list = db.settings.currencies;
    db.settings.currency = list[(list.indexOf(disp()) + 1) % list.length];
    save(); render(); toast(`Showing totals in ${disp()}`);
  },
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
    draft = { genre: '', place: '', note: '', categoryId: null, toAccountId: db.accounts[1]?.id, ...t,
      currency: txCur(t), amount: String(t.amount), toAmount: t.toAmount != null ? String(t.toAmount) : '' };
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
  txCur: () => {
    readTxForm();
    const list = [...new Set([...db.settings.currencies, draft.currency])];
    draft.currency = list[(list.indexOf(draft.currency) + 1) % list.length];
    draft.rate = undefined;
    renderTxSheet();
  },
  txCat: el => { readTxForm(); if (draft.categoryId !== el.dataset.id) draft.genre = ''; draft.categoryId = el.dataset.id; renderTxSheet(); },
  txGenre: el => { readTxForm(); draft.genre = draft.genre === el.dataset.g ? '' : el.dataset.g; renderTxSheet(); },
  saveTx: el => saveTx(el.dataset.again),
  dupTx: () => { readTxForm(); draft = { ...draft, id: null, created: null, fx: undefined, rate: undefined, recurringId: undefined, date: today() }; renderTxSheet(); toast('Copied — edit and save'); },
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
    const type = el.dataset.type || ui.rtype;
    const list = monthTx(ui.y, ui.m).filter(t => t.type === type && t.categoryId === id);
    const c = catById(id);
    openSheet(`<div class="sheet-head"><button data-act="close">Close</button><h2>${c?.icon || ''} ${esc(c?.name || 'Uncategorized')}</h2><span style="min-width:60px"></span></div>
      <div class="muted" style="text-align:center">${monthLabel()} · ${money(sum(list, val))}</div>${txGroups(list)}`);
  },
  sub: el => { ui.sub = el.dataset.sub; render(); scrollTo(0, 0); },
  back: () => { ui.sub = null; render(); },
  install: async () => { installPrompt?.prompt(); await installPrompt?.userChoice; installPrompt = null; render(); },

  toggleCur: el => {
    const c = el.dataset.c, list = db.settings.currencies;
    if (list.includes(c)) {
      if (list.length === 1) { toast('Keep at least one currency'); return; }
      db.settings.currencies = list.filter(x => x !== c);
      if (disp() === c) db.settings.currency = db.settings.currencies[0];
    } else {
      db.settings.currencies = ALL_CURRENCIES.filter(x => x === c || list.includes(x));
    }
    save(); render();
  },
  refreshRates: () => { toast('Updating rates…'); refreshRates(true); },

  editAcc: el => accountSheet(accById(el.dataset.id)),
  saveAcc: el => {
    const name = $('#a-name').value.trim();
    if (!name) { toast('Name required'); return; }
    const currency = $('#a-currency').value;
    const a = { id: el.dataset.id || uid(), name, icon: $('#a-icon').value.trim() || '💳', currency, opening: roundMoney(Number($('#a-opening').value) || 0, currency) };
    const i = db.accounts.findIndex(x => x.id === a.id);
    if (i >= 0) db.accounts[i] = a; else db.accounts.push(a);
    save(); closeSheet(); render();
  },
  delAcc: el => {
    if (db.accounts.length <= 1) { toast('Keep at least one account'); return; }
    deleteSheet('account', el.dataset.id);
  },
  confirmDelete: el => finishDelete(el.dataset.kind, el.dataset.id, $('#del-target')?.value || null),

  editCat: el => categorySheet(catById(el.dataset.id)),
  saveCat: el => {
    const name = $('#c-name').value.trim();
    if (!name) { toast('Name required'); return; }
    const old = catById(el.dataset.id);
    const c = {
      id: old?.id || uid(), type: old?.type || ui.ctype, name, icon: $('#c-icon').value.trim() || '🏷️', color: $('#c-color').value,
      genres: $('#c-genres').value.split(/[\n,]/).map(s => s.trim()).filter(Boolean),
      order: old?.order ?? Math.max(-1, ...db.categories.map(x => x.order ?? 0)) + 1,
    };
    if (old) Object.assign(old, c); else db.categories.push(c);
    save(); closeSheet(); render();
  },
  delCat: el => deleteSheet('category', el.dataset.id),
  moveCat: el => {
    const c = catById(el.dataset.id);
    const same = db.categories.filter(x => x.type === c.type);
    const j = same.indexOf(c) + Number(el.dataset.d);
    if (j < 0 || j >= same.length) return;
    // Order lives in each category's `order` field (not array position) so reordering syncs.
    same.forEach((x, i) => { x.order = i; });
    [c.order, same[j].order] = [same[j].order, c.order];
    db.categories.sort((p, q) => p.order - q.order);
    save(); render();
  },

  exportJson: () => download(`kakeibo-backup-${today()}.json`, JSON.stringify(db, null, 2), 'application/json'),
  exportCsv: () => download(`kakeibo-${today()}.csv`, toCsv(), 'text/csv'),
  importJson: () => $('#importFile').click(),
  sample: () => { addSample(); render(); },
  reset: () => {
    if (!confirm('Erase ALL entries, accounts and categories on this device?')) return;
    if (!confirm('This cannot be undone. Export a backup first if unsure. Erase now?')) return;
    // Disconnect sync first and don't record deletions, so erasing this device never wipes your other devices.
    if (typeof disconnectSync === 'function') disconnectSync();
    replaceDb(defaults()); applyTheme(); render(); toast('All data on this device erased');
  },
};

const changes = {
  budgetTotal: el => { db.budget.total = Math.max(0, Number(el.value) || 0); save(); render(); },
  budgetCat: el => {
    const v = Math.max(0, Number(el.value) || 0);
    if (v) db.budget.cats[el.dataset.id] = v; else delete db.budget.cats[el.dataset.id];
    save(); render();
  },
  budgetCurrency: el => { db.budget.currency = el.value; save(); render(); },
  currency: el => { db.settings.currency = el.value; save(); render(); toast(`Showing totals in ${el.value}`); },
  rate: el => {
    const v = Number(el.value), c = el.dataset.c;
    if (!(v > 0)) { render(); return; }
    db.fx.rates[c] = db.fx.rates[disp()] / v;
    db.fx.source = 'manual';
    if (db.settings.autoRates) { db.settings.autoRates = false; toast('Rate saved — auto-update turned off'); }
    save(); render();
  },
  autoRates: el => { db.settings.autoRates = el.checked; save(); if (el.checked) refreshRates(true); },
  txAccount: el => {
    readTxForm();
    // The entry follows the currency of the account it's paid from.
    if (el.id === 'f-accountId') {
      const c = accById(draft.accountId)?.currency || draft.currency;
      if (c !== draft.currency) { draft.currency = c; draft.rate = undefined; }
    }
    renderTxSheet();
  },
  theme: el => { db.settings.theme = el.value; save(); applyTheme(); },
  weekStart: el => { db.settings.weekStart = Number(el.value); save(); },
  importFile: async el => {
    const file = el.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.transactions) || !Array.isArray(data.categories) || !Array.isArray(data.accounts)) throw new Error('bad file');
      const synced = typeof syncConfig === 'function' && syncConfig();
      if (!confirm(`Replace current data with backup (${data.transactions.length} entries)?${synced ? '\n\nSync is on, so your other devices will be replaced with this backup too.' : ''}`)) return;
      db = migrate(data);
      save(); applyTheme(); render(); toast('Backup restored');
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
  const k = e.target.dataset.input;
  if (k === 'q') { ui.q = e.target.value; $('#txlist').innerHTML = homeList(); }
  if ((k === 'amount' || k === 'rate') && draft) {
    // Live "≈ ₱…" preview when entering a foreign-currency amount.
    const n = parseAmount($('#f-amount').value);
    $('#f-approx').textContent = draft.currency !== disp() && n > 0 ? `≈ ${money(n * previewRate())}` : '';
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#overlay').hidden) closeSheet();
  if (e.key === 'Enter' && e.target.id === 'f-amount') { e.preventDefault(); saveTx(); }
});

/* ---------- PWA ---------- */
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (ui.tab === 'more' && !ui.sub) render(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // When a new version installs (sw.js changed), offer a one-tap refresh instead of waiting for the next launch.
  // Skipped on the very first install, when there was no previous version to replace.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showUpdateBar(); });
  navigator.serviceWorker.register('sw.js').then(reg => {
    // Look for updates when the app comes back to the foreground, and every 30 minutes while it's open.
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(err => console.warn('SW registration failed', err));
}
function showUpdateBar() {
  if ($('#update-bar')) return;
  const bar = Object.assign(document.createElement('div'), { id: 'update-bar', className: 'update-bar' });
  bar.innerHTML = '<span>✨ A new version of Kakeibo is ready</span><button data-act="applyUpdate">Refresh</button>';
  document.body.append(bar);
}
actions.applyUpdate = () => {
  if (draft && !confirm('Refresh now? The entry you are editing will be discarded.')) return;
  location.reload();
};
navigator.storage?.persist?.();

applyTheme();
render();
// Home-screen shortcut ("Add expense") opens straight into the entry sheet.
if (new URLSearchParams(location.search).has('add')) {
  history.replaceState(null, '', location.pathname);
  actions.newTx({ dataset: {} });
}
if (db.settings.autoRates && navigator.onLine && Date.now() - (db.fx.updated || 0) > 6 * 36e5) refreshRates(false);
lockHistoricalRates();

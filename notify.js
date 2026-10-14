'use strict';

/* Monthly spending summary: an in-app summary screen, a "summary ready" card on Home for the first week
 * of each month, and an optional notification. The notification text is computed here (the page has the
 * data) and cached in IndexedDB so sw.js can show it from Chrome's periodic background check, or when
 * the app is next opened — whichever comes first. Preferences are per device.
 */
const NOTIFY_PREFS = 'kakeibo.notify';
const notifyPrefs = () => { try { return JSON.parse(localStorage.getItem(NOTIFY_PREFS)) || {}; } catch { return {}; } };
const setNotifyPrefs = p => { try { localStorage.setItem(NOTIFY_PREFS, JSON.stringify(p)); } catch { /* storage blocked */ } };

function notifyDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kakeibo-notify', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(key, value) {
  const d = await notifyDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const q = value === undefined ? tx.objectStore('kv').get(key) : tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve(q.result);
    tx.onerror = () => reject(tx.error);
  });
}

const prevMonthOf = (y, m) => { const d = new Date(y, m - 1, 1); return [d.getFullYear(), d.getMonth()]; };
const lastMonth = () => prevMonthOf(new Date().getFullYear(), new Date().getMonth());

/* ---------- the summary ---------- */
function monthSummary(y, m) {
  const list = monthTx(y, m);
  const { inc, exp, net } = totals(list);
  const [py, pm] = prevMonthOf(y, m);
  const prevExp = totals(monthTx(py, pm)).exp;
  const by = new Map();
  const expenses = list.filter(t => t.type === 'expense');
  for (const t of expenses) by.set(t.categoryId, (by.get(t.categoryId) || 0) + val(t));
  const days = ymKey(y, m) === today().slice(0, 7) ? new Date().getDate() : new Date(y, m + 1, 0).getDate();
  return {
    y, m, inc, exp, net, prevExp, days,
    change: prevExp > 0 ? (exp - prevExp) / prevExp : null,
    cats: [...by].map(([id, amt]) => ({ c: catById(id), amt })).sort((a, b) => b.amt - a.amt),
    budget: budgetIn(db.budget.total),
    count: expenses.length,
    biggest: [...expenses].sort((a, b) => val(b) - val(a))[0],
    label: new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long' }),
    prevLabel: new Date(py, pm, 1).toLocaleDateString(undefined, { month: 'long' }),
  };
}

function summaryNotification(s) {
  const lines = [];
  if (s.change != null) lines.push(`${Math.abs(Math.round(s.change * 100))}% ${s.change <= 0 ? 'less' : 'more'} than ${s.prevLabel}`);
  if (s.inc > 0) lines.push(`Income ${money(s.inc)} · ${s.net >= 0 ? 'saved' : 'overspent'} ${money(Math.abs(s.net))}`);
  if (s.cats.length) lines.push(`Top: ${s.cats.slice(0, 3).map(x => `${x.c?.name || 'Other'} ${money(x.amt)}`).join(', ')}`);
  if (s.budget > 0) lines.push(s.exp <= s.budget ? `Under budget by ${money(s.budget - s.exp)} 🎉` : `Over budget by ${money(s.exp - s.budget)}`);
  return {
    month: ymKey(s.y, s.m),
    title: `${s.label} spending: ${money(s.exp)}`,
    body: lines.join('\n') || 'Tap to see your summary.',
    empty: !s.count && !s.inc,
  };
}

function summarySheet(y, m) {
  const s = monthSummary(y, m);
  const title = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  let html = `<div class="sheet-head"><button data-act="close">Close</button><h2>📋 ${esc(title)}</h2><span style="min-width:60px"></span></div>`;
  if (!s.count && !s.inc) return openSheet(html + empty('Nothing recorded this month', '📋'));
  html += `<div class="card summary">
      <div><small>Spent</small><b class="neg">${money(s.exp)}</b></div>
      <div><small>Income</small><b class="pos">${money(s.inc)}</b></div>
      <div><small>${s.net >= 0 ? 'Saved' : 'Overspent'}</small><b>${money(Math.abs(s.net))}</b></div></div>`;
  const facts = [];
  if (s.change != null) {
    const pct = Math.abs(Math.round(s.change * 100));
    facts.push(`${s.change <= 0 ? '📉' : '📈'} <b>${pct}% ${s.change <= 0 ? 'less' : 'more'}</b> than ${esc(s.prevLabel)} (${money(s.prevExp)})`);
  }
  if (s.budget > 0) {
    facts.push(s.exp <= s.budget
      ? `🎯 <b>Under budget</b> by ${money(s.budget - s.exp)} ${bar(s.exp, s.budget)}`
      : `🎯 <b class="neg">Over budget</b> by ${money(s.exp - s.budget)} ${bar(s.exp, s.budget)}`);
  }
  if (s.biggest) {
    const b = s.biggest, c = catById(b.categoryId);
    facts.push(`💸 Biggest: <b>${money(val(b))}</b> · ${esc(b.place || c?.name || 'Expense')} (${dayLabel(b.date)})`);
  }
  facts.push(`🧾 ${s.count} expenses · ${money(s.exp / s.days)} a day on average`);
  html += `<div class="card summary-facts">${facts.map(f => `<div>${f}</div>`).join('')}</div>`;
  if (s.cats.length) {
    const top = s.cats[0].amt;
    html += `<div class="section-title"><span>Where it went</span></div><div class="list">${s.cats.slice(0, 6).map(x => `
      <div class="row"><span class="ico" style="background:${x.c?.color || '#94a3b8'}26">${x.c?.icon || '❔'}</span>
        <span class="main"><span class="t">${esc(x.c?.name || 'Uncategorized')}</span>${bar(x.amt, top)}</span>
        <span class="amt">${money(x.amt)}<small>${Math.round(x.amt / s.exp * 100)}%</small></span></div>`).join('')}</div>`;
  }
  html += `<button class="btn secondary" data-act="summaryReport" data-month="${ymKey(y, m)}">Open full report</button>`;
  openSheet(html);
}

function openSummary(month) {
  const [y, m] = (month || ymKey(...lastMonth())).split('-').map(Number);
  summarySheet(y, m - 1);
}

// Home card for the first week of a month, until dismissed.
function summaryBanner() {
  const [y, m] = lastMonth();
  const key = ymKey(y, m);
  if (new Date().getDate() > 7 || notifyPrefs().dismissed === key) return '';
  if (!monthTx(y, m).some(t => t.type === 'expense')) return '';
  const label = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long' });
  return `<div class="card summary-banner">
    <button class="summary-open" data-act="openSummary" data-month="${key}"><span>📋</span><span><b>Your ${esc(label)} summary is ready</b><small>Spent ${money(totals(monthTx(y, m)).exp)} · tap to see where it went</small></span></button>
    <button class="icon-btn ghost" data-act="dismissSummary" data-month="${key}" aria-label="Dismiss">✕</button></div>`;
}

/* ---------- notifications ---------- */
// Keep this month's and last month's notification text ready for the service worker.
let summaryCacheTimer = null;
function scheduleSummaryCache() {
  if (!notifyPrefs().enabled) return;
  clearTimeout(summaryCacheTimer);
  summaryCacheTimer = setTimeout(cacheSummaries, 1500);
}
async function cacheSummaries() {
  if (!notifyPrefs().enabled) return;
  const now = new Date();
  const st = (await kv('state')) || {};
  st.enabled = true;
  st.summaries = {};
  for (const [y, m] of [[now.getFullYear(), now.getMonth()], lastMonth()]) {
    const n = summaryNotification(monthSummary(y, m));
    st.summaries[n.month] = n;
  }
  await kv('state', st);
}

function askWorker(message) {
  return navigator.serviceWorker.ready.then(reg => new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = e => resolve(e.data);
    reg.active.postMessage(message, [ch.port2]);
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), 10000);
  }));
}

let backgroundCheck = 'unknown';
async function registerBackgroundCheck() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) { backgroundCheck = 'unsupported'; return; }
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (perm.state !== 'granted') { backgroundCheck = 'needs-install'; return; }
    await reg.periodicSync.register('monthly-summary', { minInterval: 12 * 60 * 60 * 1000 });
    backgroundCheck = 'on';
  } catch { backgroundCheck = 'unsupported'; }
}

async function enableSummaryNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) { toast("This browser can't show notifications"); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications are blocked — allow them for this site in Chrome settings'); return false; }
  setNotifyPrefs({ ...notifyPrefs(), enabled: true });
  const st = (await kv('state')) || {};
  // The first summary arrives when next month starts (use "Send a test" to see one now).
  st.lastNotified ||= ymKey(...lastMonth());
  st.enabled = true;
  await kv('state', st);
  await cacheSummaries();
  await registerBackgroundCheck();
  return true;
}

async function disableSummaryNotifications() {
  setNotifyPrefs({ ...notifyPrefs(), enabled: false });
  const st = (await kv('state')) || {};
  st.enabled = false;
  await kv('state', st);
  try { await (await navigator.serviceWorker.ready).periodicSync?.unregister('monthly-summary'); } catch { /* not registered */ }
}

// On open: if a new month started and the background check hasn't sent it yet, send it now.
async function checkSummaryOnOpen() {
  if (!notifyPrefs().enabled || Notification.permission !== 'granted') return;
  // Give sync a moment to bring in last-minute entries from your other device first.
  for (let i = 0; i < 15 && typeof syncState !== 'undefined' && syncState.running; i++) await new Promise(r => setTimeout(r, 1000));
  await cacheSummaries();
  return askWorker({ type: 'check-summary' });
}

function notifySettings() {
  const on = !!notifyPrefs().enabled && 'Notification' in window && Notification.permission === 'granted';
  const status = !on ? ''
    : backgroundCheck === 'on' ? "Background check on — you'll be notified at the start of each month, even if you don't open the app."
    : backgroundCheck === 'needs-install' ? 'Install the app (More → Install app) so Chrome can check in the background. Until then it arrives when you open the app.'
    : 'Arrives when you open the app in a new month.';
  return `<div class="section-title"><span>Notifications</span></div>
    <div class="form"><div class="field"><label for="notifyToggle" style="flex:1;width:auto">Monthly spending summary</label>
      <input id="notifyToggle" type="checkbox" style="flex:none;width:22px;height:22px" ${on ? 'checked' : ''} data-change="notifyToggle"></div></div>
    <div class="muted" style="font-size:13px;padding:0 4px">On the 1st of each month: total spent, change from the month before, top categories and how you did against your budget.${status ? ' ' + status : ''}</div>
    ${on ? '<button class="btn secondary" data-act="testSummary">🔔 Send a test notification</button>' : ''}`;
}

/* ---------- wiring ---------- */
const baseSettingsView = SUBVIEWS.settings;
SUBVIEWS.settings = () => baseSettingsView() + notifySettings();

Object.assign(actions, {
  openSummary: el => openSummary(el.dataset.month),
  dismissSummary: el => { setNotifyPrefs({ ...notifyPrefs(), dismissed: el.dataset.month }); render(); },
  summaryReport: el => {
    const [y, m] = el.dataset.month.split('-').map(Number);
    closeSheet(); ui.tab = 'report'; ui.rtype = 'expense'; setMonth(y, m - 1); render(); scrollTo(0, 0);
  },
  testSummary: async () => {
    const now = new Date();
    const n = summaryNotification(monthSummary(now.getFullYear(), now.getMonth()));
    n.title = `(Test) ${n.title} so far`;
    const r = await askWorker({ type: 'test-summary', notification: n });
    if (!r.ok) toast("Couldn't show a notification — check that notifications are allowed for this site");
  },
});
Object.assign(changes, {
  notifyToggle: async el => {
    el.disabled = true;
    const ok = el.checked ? await enableSummaryNotifications() : (await disableSummaryNotifications(), true);
    if (el.checked && !ok) el.checked = false;
    render();
    if (ok && el.checked) toast('Monthly summary notifications on');
  },
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'open-summary') openSummary(e.data.month); });
}
const summaryParam = new URLSearchParams(location.search).get('summary');
if (summaryParam !== null) {
  history.replaceState(null, '', location.pathname);
  openSummary(summaryParam);
}
render(); // show the Home summary card
if (notifyPrefs().enabled && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  registerBackgroundCheck();
  setTimeout(() => checkSummaryOnOpen().catch(() => {}), 3000);
}

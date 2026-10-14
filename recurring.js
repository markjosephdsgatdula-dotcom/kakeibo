'use strict';

/* Recurring entries (rent, subscriptions, salary, savings transfers…).
 * A rule holds a template entry plus a schedule. Whenever the app opens (or sync brings in rules from another
 * device), every due date up to today becomes a normal entry. Generated entries get the id
 * "<rule id>~<date>", so two devices can never both add the same rent payment, and an occurrence you
 * delete stays deleted. Editing a rule only affects future entries.
 */
const REPEAT_OPTIONS = [
  ['none', 'Never'], ['weekly:1', 'Every week'], ['weekly:2', 'Every 2 weeks'], ['monthly:1', 'Every month'],
  ['monthly:3', 'Every 3 months'], ['monthly:6', 'Every 6 months'], ['yearly:1', 'Every year'],
];
const ordinal = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return ymd(d); };

// Occurrence dates of a rule after `after` (exclusive) up to `until` (inclusive), oldest first.
function occurrences(rule, after, until) {
  const out = [];
  const start = parseD(rule.start);
  const end = rule.end && rule.end < until ? rule.end : until;
  const n = Math.max(1, Number(rule.interval) || 1);
  for (let i = 0; i < 5000; i++) {
    let d;
    if (rule.freq === 'weekly') d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 7 * n);
    else {
      const first = new Date(start.getFullYear(), start.getMonth() + (rule.freq === 'yearly' ? 12 : 1) * n * i, 1);
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const want = rule.freq === 'yearly' ? start.getDate() : rule.day === 'last' ? last : Number(rule.day) || start.getDate();
      d = new Date(first.getFullYear(), first.getMonth(), Math.min(want, last)); // the 31st → last day in short months
    }
    const key = ymd(d);
    if (key > end) break;
    if (key >= rule.start && (!after || key > after)) out.push(key);
  }
  return out;
}
const nextOccurrence = (rule, after = today()) => (rule.paused ? null : occurrences(rule, after, addDays(after, 800))[0] || null);

function freqLabel(r) {
  const n = Math.max(1, Number(r.interval) || 1);
  const start = parseD(r.start);
  if (r.freq === 'weekly') {
    const wd = start.toLocaleDateString(undefined, { weekday: 'long' });
    return n === 1 ? `Weekly on ${wd}` : `Every ${n} weeks on ${wd}`;
  }
  if (r.freq === 'yearly') {
    const md = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return n === 1 ? `Yearly on ${md}` : `Every ${n} years on ${md}`;
  }
  const day = r.day === 'last' ? 'the last day' : `the ${ordinal(Number(r.day) || start.getDate())}`;
  return n === 1 ? `Monthly on ${day}` : `Every ${n} months on ${day}`;
}

// Average cost per month in the display currency (weekly ≈ 52/12 times a month).
function perMonth(r) {
  const n = Math.max(1, Number(r.interval) || 1);
  const times = r.freq === 'weekly' ? 52 / 12 / n : r.freq === 'yearly' ? 1 / 12 / n : 1 / n;
  return conv(Number(r.template.amount) || 0, r.template.currency) * times;
}

function ruleName(r) {
  const t = r.template;
  if (t.type === 'transfer') return `${accName(t.accountId)} → ${accName(t.toAccountId)}`;
  return t.place || t.genre || catById(t.categoryId)?.name || 'Recurring entry';
}
const ruleIcon = r => (r.template.type === 'transfer' ? '🔁' : catById(r.template.categoryId)?.icon || '❔');
const ruleColor = r => (r.template.type === 'transfer' ? TRANSFER_COLOR : catById(r.template.categoryId)?.color || '#94a3b8');

const templateOf = tx => ({
  type: tx.type, amount: tx.amount, currency: tx.currency, accountId: tx.accountId, toAccountId: tx.toAccountId,
  categoryId: tx.categoryId, genre: tx.genre || '', place: tx.place || '', note: tx.note || '',
});

function entryFromRule(r, date) {
  const t = r.template;
  const tx = {
    id: `${r.id}~${date}`, recurringId: r.id, type: t.type, date, amount: Number(t.amount), currency: t.currency,
    fx: { rates: snapshot(), date: date === today() ? date : '' }, // past dates get that day's rate via lockHistoricalRates
    accountId: t.accountId, note: t.note || '', created: Date.now(),
  };
  if (t.type === 'transfer') {
    tx.toAccountId = t.toAccountId;
    const toCur = accById(t.toAccountId)?.currency;
    if (toCur && toCur !== t.currency) { tx.toCurrency = toCur; tx.toAmount = roundMoney(txConv(tx, toCur), toCur); }
  } else Object.assign(tx, { categoryId: t.categoryId, genre: t.genre || '', place: t.place || '' });
  return tx;
}

// Adds every due entry up to today. Returns how many were added.
function runRecurring() {
  const td = today();
  const added = [];
  for (const r of db.recurring) {
    if (r.paused) continue;
    const dates = occurrences(r, r.lastRun || '', td);
    for (const date of dates) {
      const id = `${r.id}~${date}`;
      if (db.deleted[id] || db.transactions.some(t => t.id === id)) continue; // deleted by you, or already added (e.g. by your other device)
      db.transactions.push(entryFromRule(r, date));
      added.push(ruleName(r));
    }
    if (dates.length) r.lastRun = dates[dates.length - 1];
  }
  if (!added.length) return 0;
  save(); render();
  lockHistoricalRates();
  const names = [...new Set(added)];
  toast(`🔁 Added ${added.length} recurring ${added.length === 1 ? 'entry' : 'entries'}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`);
  return added.length;
}

/* ---------- entry sheet ---------- */
function repeatField(d) {
  if (d.recurringId) {
    const r = db.recurring.find(x => x.id === d.recurringId);
    return `<div class="field"><label>Repeats</label>${r
      ? `<button type="button" class="link-btn" data-act="editRule" data-id="${r.id}">🔁 ${esc(freqLabel(r))}${r.paused ? ' (paused)' : ''} · Edit series ›</button>`
      : '<span class="muted">Part of a deleted series</span>'}</div>`;
  }
  const sel = d.repeat || 'none';
  return `<div class="field"><label>Repeat</label><select id="f-repeat">${REPEAT_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
}

// Called by saveTx: turning an entry into a series makes it the first occurrence.
function beforeSaveTx(d, tx) {
  if (d.recurringId || !d.repeat || d.repeat === 'none') return;
  const [freq, interval] = d.repeat.split(':');
  const rule = {
    id: uid(), freq, interval: Number(interval) || 1, day: Number(tx.date.slice(8)), start: tx.date, end: '',
    paused: false, lastRun: tx.date, template: templateOf(tx),
  };
  db.recurring.push(rule);
  if (d.id) db.transactions = db.transactions.filter(t => t.id !== d.id); // existing entry gets the series id
  tx.id = `${rule.id}~${tx.date}`;
  tx.recurringId = rule.id;
}

/* ---------- Recurring screen ---------- */
SUBVIEWS.recurring = () => {
  const rules = [...db.recurring].sort((a, b) => (nextOccurrence(a) || '9999').localeCompare(nextOccurrence(b) || '9999'));
  const active = rules.filter(r => !r.paused && (!r.end || r.end >= today()));
  const out = sum(active.filter(r => r.template.type === 'expense'), perMonth);
  const inc = sum(active.filter(r => r.template.type === 'income'), perMonth);
  let html = `<div class="card summary" style="grid-template-columns:1fr 1fr"><div><small>Recurring costs</small><b class="neg">${money(out)}</b><small>per month</small></div>
    <div><small>Recurring income</small><b class="pos">${money(inc)}</b><small>per month</small></div></div>`;
  if (!rules.length) {
    html += empty('No recurring entries yet', '🔁', 'Add rent, subscriptions, bills or your salary once and they\'ll be recorded automatically.');
  } else {
    html += '<div class="list">';
    for (const r of rules) {
      const next = nextOccurrence(r);
      const status = r.paused ? 'Paused' : next ? `Next ${dayLabel(next)}` : 'Ended';
      const t = r.template;
      const cls = t.type === 'expense' ? 'neg' : t.type === 'income' ? 'pos' : 'muted';
      html += `<button class="row" data-act="editRule" data-id="${r.id}" ${r.paused ? 'style="opacity:.55"' : ''}>
        <span class="ico" style="background:${ruleColor(r)}26">${ruleIcon(r)}</span>
        <span class="main"><span class="t">${esc(ruleName(r))}</span><span class="sub">${esc(freqLabel(r))} · ${esc(status)}</span></span>
        <span class="amt ${cls}">${money(Number(t.amount), t.currency)}</span></button>`;
    }
    html += '</div>';
  }
  return html + `<button class="btn" data-act="newRecurring">＋ Add recurring entry</button>
    <div class="muted" style="font-size:13px;padding:8px 4px">Tip: any new entry can repeat. Use the <b>Repeat</b> option when adding it.</div>`;
};

/* ---------- edit a series ---------- */
let ruleDraft = null;

function readRuleForm() {
  const r = ruleDraft, t = r.template;
  const v = id => $(`#r-${id}`)?.value;
  t.amount = v('amount') ?? t.amount;
  t.currency = v('currency') || t.currency;
  if ($('#r-place')) t.place = v('place');
  if ($('#r-categoryId')) t.categoryId = v('categoryId');
  t.accountId = v('accountId') || t.accountId;
  if ($('#r-toAccountId')) t.toAccountId = v('toAccountId');
  t.note = v('note') ?? t.note;
  const [freq, interval] = (v('repeat') || `${r.freq}:${r.interval}`).split(':');
  r.freq = freq; r.interval = Number(interval) || 1;
  if ($('#r-day')) r.day = v('day') === 'last' ? 'last' : Number(v('day'));
  r.start = v('start') || r.start;
  r.end = v('end') || '';
  r.paused = !!$('#r-paused')?.checked;
}

function ruleSheet() {
  const r = ruleDraft, t = r.template;
  const cats = db.categories.filter(c => c.type === t.type);
  const accOpts = sel => db.accounts.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.icon)} ${esc(a.name)} (${a.currency})</option>`).join('');
  const rep = `${r.freq}:${r.interval}`;
  const opts = REPEAT_OPTIONS.filter(([v]) => v !== 'none');
  if (!opts.some(([v]) => v === rep)) opts.push([rep, freqLabel(r)]);
  const day = r.day ?? parseD(r.start).getDate();
  const dayOpts = Array.from({ length: 31 }, (_, i) => i + 1)
    .map(n => `<option value="${n}" ${String(day) === String(n) ? 'selected' : ''}>${ordinal(n)}</option>`).join('')
    + `<option value="last" ${day === 'last' ? 'selected' : ''}>Last day</option>`;
  const next = nextOccurrence(r);
  const kind = t.type === 'transfer' ? 'transfer' : t.type === 'income' ? 'income' : 'expense';
  openSheet(`<div class="sheet-head"><button data-act="close">Cancel</button><h2>🔁 Recurring ${kind}</h2><button data-act="saveRule">Save</button></div>
    <div class="form">
      <div class="field"><label>Amount</label><input id="r-amount" inputmode="decimal" value="${esc(t.amount)}"><select id="r-currency" style="flex:none;width:auto">${curOptions(t.currency)}</select></div>
      ${t.type !== 'transfer' ? `<div class="field"><label>Name</label><input id="r-place" value="${esc(t.place)}" placeholder="e.g. Rent, Netflix, Salary"></div>
        <div class="field"><label>Category</label><select id="r-categoryId">${cats.map(c => `<option value="${c.id}" ${c.id === t.categoryId ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>${t.type === 'income' ? 'Into' : t.type === 'transfer' ? 'From' : 'Paid with'}</label><select id="r-accountId">${accOpts(t.accountId)}</select></div>
      ${t.type === 'transfer' ? `<div class="field"><label>To</label><select id="r-toAccountId">${accOpts(t.toAccountId)}</select></div>` : ''}
      <div class="field"><label>Repeats</label><select id="r-repeat" data-change="ruleRepeat">${opts.map(([v, l]) => `<option value="${v}" ${v === rep ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${r.freq === 'monthly' ? `<div class="field"><label>On day</label><select id="r-day" data-change="ruleRepeat">${dayOpts}</select></div>` : ''}
      <div class="field"><label>Starts</label><input id="r-start" type="date" value="${r.start}" data-change="ruleRepeat"></div>
      <div class="field"><label>Ends</label><input id="r-end" type="date" value="${r.end || ''}"></div>
      <div class="field"><label>Memo</label><input id="r-note" value="${esc(t.note)}" placeholder="Optional"></div>
      <div class="field"><label for="r-paused" style="flex:1;width:auto">Pause this series</label><input id="r-paused" type="checkbox" style="flex:none;width:22px;height:22px" ${r.paused ? 'checked' : ''}></div>
    </div>
    <div class="muted" style="font-size:13px;padding:0 4px">${esc(freqLabel(r))}${next ? ` · next on ${dayLabel(next)}` : ''}. Changes apply to future entries. Ones already added stay as they are; edit those individually.</div>
    <button class="btn" data-act="saveRule">Save</button>
    <button class="btn danger" data-act="delRule">Delete series</button>`);
}

/* ---------- Home: coming up ---------- */
function upcomingCard() {
  if (ymKey(ui.y, ui.m) !== today().slice(0, 7) || !db.recurring.length) return '';
  const td = today(), until = addDays(td, 7);
  const items = db.recurring.filter(r => !r.paused)
    .flatMap(r => occurrences(r, td, until).map(date => ({ r, date })))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!items.length) return '';
  const rows = items.slice(0, 4).map(({ r, date }) => {
    const t = r.template;
    return `<div class="budget-line"><span>${ruleIcon(r)} ${esc(ruleName(r))} <small class="muted">${dayLabel(date)}</small></span>
      <span class="${t.type === 'expense' ? 'neg' : t.type === 'income' ? 'pos' : ''}">${money(Number(t.amount), t.currency)}</span></div>`;
  }).join('');
  return `<div class="card upcoming"><div class="budget-line"><b>Coming up this week</b><a href="#" data-act="openRecurring" style="color:var(--accent)">All recurring ›</a></div>${rows}</div>`;
}

/* ---------- wiring ---------- */
Object.assign(actions, {
  openRecurring: () => { ui.tab = 'more'; ui.sub = 'recurring'; render(); scrollTo(0, 0); },
  newRecurring: () => { draft = { ...newDraft(), repeat: 'monthly:1' }; renderTxSheet(); $('#f-amount').focus(); },
  editRule: el => {
    const r = db.recurring.find(x => x.id === el.dataset.id);
    if (!r) return;
    ruleDraft = structuredClone(r);
    ruleSheet();
  },
  saveRule: () => {
    readRuleForm();
    const r = ruleDraft, t = r.template;
    const amount = roundMoney(parseAmount(t.amount), t.currency);
    if (!(amount > 0)) { toast('Enter an amount'); return; }
    if (t.type === 'transfer' && t.accountId === t.toAccountId) { toast('Choose two different accounts'); return; }
    if (r.end && r.end < r.start) { toast('The end date is before the start date'); return; }
    t.amount = amount;
    const old = db.recurring.find(x => x.id === r.id);
    if (!old) { closeSheet(); return; }
    // A changed schedule or a resumed series only adds entries from today on (no surprise back-payments).
    const scheduleChanged = ['freq', 'interval', 'day', 'start'].some(k => String(old[k]) !== String(r[k]));
    if (scheduleChanged || (old.paused && !r.paused)) r.lastRun = [old.lastRun || '', addDays(today(), -1)].sort().pop();
    Object.assign(old, r);
    save(); closeSheet(); ruleDraft = null;
    if (!runRecurring()) render();
    toast('Series updated');
  },
  delRule: () => {
    if (!confirm('Delete this series? Entries already added are kept.')) return;
    db.recurring = db.recurring.filter(x => x.id !== ruleDraft.id);
    save(); closeSheet(); ruleDraft = null; render(); toast('Series deleted');
  },
});
Object.assign(changes, {
  ruleRepeat: () => { readRuleForm(); ruleSheet(); },
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runRecurring(); }); // the date may have changed
runRecurring();

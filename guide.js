'use strict';

/* Getting started: a practical, step-by-step setup with your real money — not a tour of buttons.
 * Each step explains what to do in real life, has a button that opens the right form (pre-filled where
 * possible), and ticks itself off when the app sees it's done. Progress is kept in db.settings.guide,
 * so it syncs between devices.
 */
const guideState = () => db.settings.guide || {};
function setGuide(patch) { db.settings.guide = { ...guideState(), ...patch }; save(); }

// Entries from "Add sample data" (flagged since this version), or the tell-tale batch of 10+ entries
// created in the same instant by older versions. Recurring entries are never counted.
function sampleEntries() {
  const batch = new Map();
  for (const t of db.transactions) if (!t.recurringId && t.created) batch.set(t.created, (batch.get(t.created) || 0) + 1);
  return db.transactions.filter(t => t.sample || (!t.recurringId && t.created && batch.get(t.created) >= 10));
}
const manualExpenses = () => {
  const sample = new Set(sampleEntries().map(t => t.id));
  return db.transactions.filter(t => t.type === 'expense' && !t.recurringId && !sample.has(t.id) && t.place !== 'Unrecorded spending');
};

const GUIDE_STEPS = [
  { id: 'clean', title: 'Clear out the test entries', show: () => sampleEntries().length > 0, done: () => !sampleEntries().length },
  { id: 'accounts', title: 'Write down the money you have right now', done: () => !!guideState().accounts },
  // Stays open until you say you're done, since most people have several bills to add.
  { id: 'bills', title: 'Add the bills that come every month', done: () => ['done', 'skipped'].includes(guideState().bills) },
  { id: 'budget', title: 'Pick one monthly spending limit', done: () => db.budget.total > 0 || guideState().budget === 'skipped' },
  { id: 'record', title: 'Record what you spend, when you spend it', done: () => manualExpenses().length >= 3 },
  { id: 'check', title: 'Do a 2-minute check once a week', done: () => !!guideState().checked },
];
const activeSteps = () => GUIDE_STEPS.filter(s => !s.show || s.show());

/* ---------- Home card ---------- */
function guideCard() {
  const g = guideState();
  const steps = activeSteps();
  const doneCount = steps.filter(s => s.done()).length;
  if (doneCount === steps.length) {
    if (g.finished || g.hidden) return '';
    return `<div class="card guide-card"><div class="guide-card-main"><span class="guide-emoji">🎉</span><div><b>You're all set up!</b>
      <small>From here it's just: tap ＋ when you pay, and check your balances on Sundays.</small></div></div>
      <button class="icon-btn ghost" data-act="guideFinish" aria-label="Dismiss">✕</button></div>`;
  }
  if (g.hidden) return '';
  const next = steps.find(s => !s.done());
  return `<div class="card guide-card">
    <button class="guide-card-main" data-act="openGuide"><span class="guide-emoji">📘</span><div>
      <b>Getting started · ${doneCount} of ${steps.length} done</b>
      <small>Next: ${esc(next.title)}</small>${bar(doneCount, steps.length)}</div></button>
    <button class="icon-btn ghost" data-act="guideHide" aria-label="Hide guide">✕</button></div>`;
}

/* ---------- the guide screen ---------- */
const BILL_PRESETS = [
  ['🏠', 'Rent', 'expense', 'Housing', 'Rent'],
  ['💡', 'Electricity', 'expense', 'Utilities', 'Electricity'],
  ['🚰', 'Water', 'expense', 'Utilities', 'Water'],
  ['🌐', 'Internet', 'expense', 'Phone & internet', 'Internet'],
  ['📱', 'Phone plan', 'expense', 'Phone & internet', 'Mobile'],
  ['🎬', 'Netflix', 'expense', 'Phone & internet', 'Subscriptions'],
  ['🎵', 'Spotify', 'expense', 'Phone & internet', 'Subscriptions'],
  ['💪', 'Gym', 'expense', 'Health', 'Fitness'],
  ['👪', 'Family support', 'expense', 'Social', ''],
  ['💼', 'Salary', 'income', 'Salary', ''],
];

function stepBody(step) {
  const ex = (n, cur = disp()) => money(n, cur);
  switch (step.id) {
    case 'clean': {
      const n = sampleEntries().length;
      return `<p>There are <b>${n} test entries</b> from trying the app out (the "sample data"). Remove them so every number you see is real.</p>
        <button class="btn btn-danger" data-act="guideClean">Remove ${n} test entries</button>`;
    }
    case 'accounts':
      return `<p>Kakeibo needs a starting point. Open your wallet and your bank and e-wallet apps, and type in what each one has <b>today</b>. Don't worry about the past. You start counting from today.</p>
        <p class="guide-example">For example: Cash in wallet ${ex(2350)} · Bank ${ex(18400)} · GCash ${ex(1200)} · Yen wallet ${ex(12000, 'JPY')}</p>
        <p class="muted">Remove the accounts you don't have, and add the ones that are missing (GCash, Maya, a savings account…).</p>
        <button class="btn" data-act="guideBalances" data-mode="setup">Enter my balances</button>`;
    case 'bills': {
      const added = db.recurring.map(ruleName);
      return `<p>Think of what you pay <b>every month</b>: rent, electricity, internet, your phone plan, Netflix. And what you <b>receive</b>, like your salary. Add each one once, and Kakeibo records it automatically on its due day. You'll never type it again.</p>
        <p class="muted">Tap one, type the amount, set the date to <b>this month's due date</b>, and check <b>Paid with</b> (bank, cash, GCash…).</p>
        <div class="chips">${BILL_PRESETS.map(([icon, name], i) => `<button data-act="guideBill" data-i="${i}">${icon} ${name}</button>`).join('')}<button data-act="guideBill" data-i="-1">＋ Something else</button></div>
        ${added.length ? `<p class="guide-example">Added: ${esc(added.join(', '))} · <a href="#" data-act="openRecurring" style="color:var(--accent)">See all</a></p>
            <button class="btn" data-act="guideBillsDone">✓ That's all my bills</button>`
          : '<button class="btn secondary" data-act="guideSkip" data-step="bills">I don\'t have any regular bills</button>'}`;
    }
    case 'budget': {
      const income = sum(db.recurring.filter(r => !r.paused && r.template.type === 'income'), perMonth);
      const suggestion = income > 0 ? roundMoney(income * 0.8) : 0;
      return `<p>Just <b>one number</b>: how much you want to spend in a whole month, everything included (bills too). An easy way to choose: take your monthly income and subtract what you want to save.</p>
        ${income > 0 ? `<p class="guide-example">Your salary is about ${money(income)} a month. Saving 20% leaves a budget of <b>${money(suggestion)}</b>.</p>` : ''}
        <div class="form"><div class="field"><label>Monthly budget</label><input id="guide-budget" type="number" inputmode="decimal" min="0" placeholder="${suggestion || 'e.g. 25000'}" value="${db.budget.total || suggestion || ''}"><span class="muted">${db.budget.currency}</span></div></div>
        <button class="btn" data-act="guideBudget">Set my budget</button>
        <p class="muted">Home will show how much is left as the month goes on. Limits per category (More → Budget) can wait.</p>
        ${db.budget.total ? '' : '<button class="btn secondary" data-act="guideSkip" data-step="budget">Skip for now</button>'}`;
    }
    case 'record': {
      const n = manualExpenses().length;
      return `<p>This is the habit that makes everything work: <b>right after you pay for something</b> (even ${money(20)}), tap the green <b>＋</b>, type the amount, pick a category and Save. It takes about 10 seconds.</p>
        <ul class="guide-tips">
          <li>Not sure which category? <b>Other</b> is fine. Getting it recorded matters more.</li>
          <li>Forgot to record something? Add it later and change the date.</li>
          <li>Paid in yen? Choose your <b>Yen wallet</b> under "Paid with" and the entry switches to ¥.</li>
          <li>Have the receipt? <b>📷 Scan receipt</b> fills it in for you (optional).</li>
        </ul>
        <p class="guide-example">You've recorded ${Math.min(n, 3)} of 3 expenses so far.</p>
        <button class="btn" data-act="newTx">＋ Record an expense now</button>`;
    }
    case 'check':
      return `<p>Once a week (Sunday night works well), count the cash in your wallet and open your bank and e-wallet apps. If Kakeibo shows a different amount, you forgot to record something. That's normal! Type the real amounts and Kakeibo adds the difference as <b>"Unrecorded spending"</b>, so you're back in step.</p>
        <button class="btn" data-act="guideBalances" data-mode="check">Check my balances</button>`;
  }
  return '';
}

SUBVIEWS.guide = () => {
  const steps = activeSteps();
  const firstOpen = steps.find(s => !s.done());
  let html = `<div class="card guide-intro"><b>You don't need every feature.</b> Kakeibo works if you do just two things: write down what you <b>have</b>, and write down what you <b>spend</b>. Set it up once (about 10 minutes) and after that it's 10 seconds per purchase.</div>`;
  steps.forEach((s, i) => {
    const done = s.done();
    const open = s === firstOpen || ui.guideOpen === s.id;
    html += `<div class="card guide-step ${done ? 'done' : ''}">
      <button class="guide-step-head" data-act="guideToggle" data-step="${s.id}">
        <span class="guide-num">${done ? '✓' : i + 1}</span><b>${esc(s.title)}</b><span class="muted">${open ? '▾' : '▸'}</span></button>
      ${open ? `<div class="guide-step-body">${stepBody(s)}</div>` : ''}</div>`;
  });
  html += `<div class="section-title"><span>Safe to ignore for now</span></div>
    <div class="card guide-later">
      <div>💱 <b>Currencies</b>: automatic. Just pick the yen or dollar account when you pay with one.</div>
      <div>🏷️ <b>Editing categories</b>: the default ones cover most things.</div>
      <div>📊 <b>Reports</b>: worth a look at the end of the month.</div>
      <div>🔄 <b>Sync</b>: only if you also want to use the app on a laptop. <a href="#" data-act="openSync" style="color:var(--accent)">Set up</a></div>
      <div>🔔 <b>Monthly summary</b>: nice to switch on once you're recording regularly (More → Settings).</div>
    </div>`;
  return html;
};

/* ---------- balances: first setup, and the weekly check ---------- */
let balDraft = null;

function balanceSheet() {
  const { mode, rows } = balDraft;
  const setup = mode === 'setup';
  const curOpts = sel => db.settings.currencies.map(c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  openSheet(`<div class="sheet-head"><button data-act="close">Cancel</button><h2>${setup ? 'Money I have now' : 'Weekly check'}</h2><button data-act="guideSaveBalances">Save</button></div>
    <p class="muted" style="margin:0 4px 8px;font-size:14px">${setup
      ? 'Type what each one has today. A close guess is fine.'
      : 'Count your cash and check your apps, then type the real amounts. Only change the ones that differ.'}</p>
    <div class="form">${rows.map((r, i) => r.removed ? '' : `
      <div class="field bal-row">
        ${r.isNew
          ? `<input class="bal-name" data-i="${i}" value="${esc(r.name)}" placeholder="Name, e.g. GCash"><select class="bal-cur" data-i="${i}" style="flex:none;width:auto">${curOpts(r.currency)}</select>`
          : `<label style="width:auto;flex:1">${esc(r.icon)} ${esc(r.name)} <small class="muted">${r.currency}</small></label>`}
        <input class="bal-val" data-i="${i}" type="number" inputmode="decimal" step="any" placeholder="0" value="${r.value}" style="max-width:130px;text-align:right">
        ${setup && r.removable ? `<button class="icon-btn ghost" data-act="guideBalRemove" data-i="${i}" aria-label="I don't have this">✕</button>` : ''}
      </div>`).join('')}</div>
    ${setup ? `<button class="btn secondary" data-act="guideBalAdd">＋ Add an account (GCash, Maya, savings…)</button>
      <p class="muted" style="font-size:13px;margin:8px 4px">Tap ✕ on accounts you don't have. Credit card: enter what you owe as a negative number, e.g. -5000.</p>` : ''}
    <button class="btn" data-act="guideSaveBalances">Save</button>`);
}

function readBalanceForm() {
  for (const el of document.querySelectorAll('.bal-val')) balDraft.rows[el.dataset.i].value = el.value;
  for (const el of document.querySelectorAll('.bal-name')) balDraft.rows[el.dataset.i].name = el.value;
  for (const el of document.querySelectorAll('.bal-cur')) balDraft.rows[el.dataset.i].currency = el.value;
}

function saveBalances() {
  readBalanceForm();
  const { mode, rows } = balDraft;
  const live = rows.filter(r => !r.removed);
  if (!live.length) { toast('Keep at least one account'); return; }
  if (live.some(r => r.isNew && !r.name.trim())) { toast('Give the new account a name'); return; }
  let changed = 0;
  if (mode === 'setup') {
    for (const r of rows) {
      if (r.removed) { db.accounts = db.accounts.filter(a => a.id !== r.id); continue; }
      const target = roundMoney(Number(r.value) || 0, r.currency);
      if (r.isNew) {
        db.accounts.push({ id: uid(), name: r.name.trim(), icon: guessAccountIcon(r.name), currency: r.currency, opening: target });
        continue;
      }
      // Set the starting balance so that today's balance equals what you typed.
      const a = accById(r.id);
      a.opening = roundMoney(target - (accBalance(a.id) - (a.opening || 0)), a.currency);
    }
    setGuide({ accounts: true });
    toast('Balances saved — your starting point is set');
  } else {
    const other = type => db.categories.find(c => c.type === type && c.name === 'Other') || db.categories.find(c => c.type === type);
    for (const r of live) {
      if (r.value === '' || r.value == null) continue;
      const a = accById(r.id);
      const diff = roundMoney((Number(r.value) || 0) - accBalance(a.id), a.currency);
      if (!diff) continue;
      const type = diff < 0 ? 'expense' : 'income';
      db.transactions.push({
        id: uid(), type, date: today(), amount: Math.abs(diff), currency: a.currency, fx: { rates: snapshot(), date: today() },
        categoryId: other(type)?.id, genre: '', accountId: a.id, place: diff < 0 ? 'Unrecorded spending' : 'Balance adjustment',
        note: 'Weekly balance check', created: Date.now(),
      });
      changed++;
    }
    setGuide({ checked: true });
    toast(changed ? `Added ${changed} adjustment${changed > 1 ? 's' : ''} — balances now match` : 'Everything matches 👍');
  }
  closeSheet(); balDraft = null; render();
}

function guessAccountIcon(name) {
  const n = name.toLowerCase();
  if (/gcash|maya|paymaya|paypay|e-?wallet|wallet app/.test(n)) return '📲';
  if (/card|credit|visa|master/.test(n)) return '💳';
  if (/sav/.test(n)) return '🐷';
  if (/cash|wallet/.test(n)) return '👛';
  if (/yen|jpy/.test(n)) return '💴';
  if (/dollar|usd/.test(n)) return '💵';
  return '🏦';
}

/* ---------- wiring ---------- */
Object.assign(actions, {
  openGuide: () => { ui.tab = 'more'; ui.sub = 'guide'; render(); scrollTo(0, 0); },
  guideHide: () => { setGuide({ hidden: true }); render(); toast('Guide hidden — find it anytime in More → Getting started'); },
  guideFinish: () => { setGuide({ finished: true }); render(); },
  guideToggle: el => { ui.guideOpen = ui.guideOpen === el.dataset.step ? null : el.dataset.step; render(); },
  guideSkip: el => { setGuide({ [el.dataset.step]: 'skipped' }); render(); },
  guideBillsDone: () => { setGuide({ bills: 'done' }); render(); },
  guideClean: () => {
    const ids = new Set(sampleEntries().map(t => t.id));
    if (!confirm(`Remove ${ids.size} test entries? Your own entries are not touched.`)) return;
    db.transactions = db.transactions.filter(t => !ids.has(t.id));
    save(); render(); toast('Test entries removed');
  },
  guideBalances: el => {
    balDraft = {
      mode: el.dataset.mode,
      rows: db.accounts.map(a => {
        const used = db.transactions.some(t => t.accountId === a.id || t.toAccountId === a.id)
          || db.recurring.some(r => r.template.accountId === a.id || r.template.toAccountId === a.id);
        return { id: a.id, name: a.name, icon: a.icon, currency: a.currency, value: String(roundMoney(accBalance(a.id), a.currency)), removable: !used && db.accounts.length > 1 };
      }),
    };
    balanceSheet();
  },
  guideBalAdd: () => { readBalanceForm(); balDraft.rows.push({ isNew: true, name: '', currency: disp(), value: '' }); balanceSheet(); [...document.querySelectorAll('.bal-name')].pop()?.focus(); },
  guideBalRemove: el => { readBalanceForm(); balDraft.rows[el.dataset.i].removed = true; balanceSheet(); },
  guideSaveBalances: () => saveBalances(),
  guideBill: el => {
    const p = BILL_PRESETS[Number(el.dataset.i)];
    const d = { ...newDraft(today()), repeat: 'monthly:1' };
    if (p) {
      const [, name, type, catName, genre] = p;
      const cat = db.categories.find(c => c.type === type && c.name === catName) || db.categories.find(c => c.type === type);
      Object.assign(d, { type, place: name, categoryId: cat?.id, genre });
    }
    // Bills and salary usually go through the bank, not the cash in your wallet.
    d.accountId = (db.accounts.find(a => /bank|bdo|bpi|metrobank|savings/i.test(a.name)) || db.accounts[0])?.id;
    d.currency = accById(d.accountId)?.currency || d.currency;
    draft = d;
    renderTxSheet();
    $('#f-amount').focus();
    toast("Type the amount, this month's due date, and what you pay it with");
  },
  guideBudget: () => {
    const v = Number($('#guide-budget').value);
    if (!(v > 0)) { toast('Type a monthly amount'); return; }
    db.budget.total = roundMoney(v, db.budget.currency);
    save(); render(); toast('Budget set — Home shows how much is left');
  },
});

'use strict';

/* Device sync.
 * Data is encrypted on the device (AES-GCM, key from the user's passphrase via PBKDF2) and stored as one
 * file in a secret gist in the user's own GitHub account. Each device keeps a full local copy and works
 * offline; changes are marked "waiting" and merged record-by-record (newest edit wins, deletions kept as
 * tombstones) whenever the device is online — after edits, on launch, on reconnect and when reopened.
 * The token and passphrase live only in this device's storage (never in backups or the gist).
 */
const SYNC_KEY = 'kakeibo.sync';
const GIST_FILE = 'kakeibo-sync.json';
const GIST_DESC = 'Kakeibo sync data (encrypted)';
const GH_API = 'https://api.github.com';
const PBKDF2_ITERATIONS = 310000;

function syncConfig() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch { return null; }
}
function setSyncConfig(cfg) {
  try { if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(cfg)); else localStorage.removeItem(SYNC_KEY); } catch { /* storage blocked */ }
}

const syncState = { running: false, again: false, error: '', timer: null };

class SyncError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/* ---------- encryption ---------- */
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const keyCache = new Map();
async function deriveKey(pass, salt) {
  const id = `${pass}|${toB64(salt)}`;
  if (!keyCache.has(id)) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    keyCache.set(id, await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(id);
}

async function encryptData(obj, pass, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return JSON.stringify({ app: 'kakeibo', format: 1, kdf: `PBKDF2-SHA256-${PBKDF2_ITERATIONS}`, salt: toB64(salt), iv: toB64(iv), data: toB64(ct) });
}

async function decryptData(text, pass) {
  let p;
  try { p = JSON.parse(text); } catch { throw new SyncError('The sync file on GitHub is damaged.', 'corrupt'); }
  if (p?.app !== 'kakeibo') throw new SyncError('The sync file on GitHub is not Kakeibo data.', 'corrupt');
  const salt = fromB64(p.salt);
  try {
    const key = await deriveKey(pass, salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(p.iv) }, key, fromB64(p.data));
    return { data: JSON.parse(new TextDecoder().decode(plain)), salt };
  } catch {
    throw new SyncError('Wrong passphrase — use the same passphrase as on your other device.', 'passphrase');
  }
}

/* ---------- GitHub gist storage ---------- */
async function gh(method, path, token, body) {
  let res;
  try {
    res = await fetch(GH_API + path, {
      method, cache: 'no-store', body: body && JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch { throw new SyncError('Could not reach GitHub — are you offline?', 'network'); }
  if (res.status === 401) throw new SyncError('Your GitHub token is invalid or expired. Turn sync off and reconnect with a new token.', 'auth');
  if (res.status === 403 || res.status === 429) throw new SyncError("GitHub refused the request — the token may be missing the 'gist' permission, or you've hit a rate limit.", 'forbidden');
  if (res.status === 404) throw new SyncError('Sync file not found on GitHub.', 'notfound');
  if (!res.ok) throw new SyncError(`GitHub error (${res.status}). Try again later.`, 'http');
  return res.status === 204 ? null : res.json();
}

async function findGist(token) {
  for (let page = 1; page <= 10; page++) {
    const list = await gh('GET', `/gists?per_page=100&page=${page}`, token);
    const g = list.find(x => x.files?.[GIST_FILE]);
    if (g) return g.id;
    if (list.length < 100) break;
  }
  return null;
}

async function readGist(cfg) {
  const g = await gh('GET', `/gists/${cfg.gistId}`, cfg.token);
  const f = g.files?.[GIST_FILE];
  if (!f) return null;
  if (!f.truncated) return f.content;
  // The API inlines up to 1 MB; larger files are fetched from the raw URL.
  const res = await fetch(f.raw_url, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) throw new SyncError('Could not download the sync file from GitHub.', 'network');
  return res.text();
}

/* ---------- merging ---------- */
const syncPayload = d => ({
  version: d.version, settings: d.settings, budget: d.budget, fx: d.fx,
  accounts: d.accounts, categories: d.categories, transactions: d.transactions, recurring: d.recurring, deleted: d.deleted,
});

const newer = (a, b) => (!a ? b : !b ? a : (b.updated || 0) > (a.updated || 0) ? b : a);

function mergeDb(local, remote) {
  const deleted = { ...remote.deleted };
  for (const [id, ts] of Object.entries(local.deleted || {})) deleted[id] = Math.max(deleted[id] || 0, ts);
  const list = (r = [], l = []) => {
    const m = new Map();
    for (const x of r) m.set(x.id, x); // remote order first, so nothing changes when there's nothing new locally
    for (const x of l) m.set(x.id, newer(m.get(x.id), x));
    // A deletion beats any edit made before it; an edit made after a deletion brings the record back.
    return [...m.values()].filter(x => !(deleted[x.id] >= (x.updated || 0)));
  };
  return {
    ...local,
    settings: newer(remote.settings, local.settings),
    budget: newer(remote.budget, local.budget),
    fx: newer(remote.fx, local.fx),
    accounts: list(remote.accounts, local.accounts),
    categories: list(remote.categories, local.categories).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    transactions: list(remote.transactions, local.transactions),
    recurring: list(remote.recurring, local.recurring),
    deleted,
  };
}

// A device that has never been used (no entries, nothing edited) simply adopts the synced data.
const isPristine = d => !d.transactions.length && [...d.accounts, ...d.categories].every(x => !x.updated);

// First sync of a device that already has its own data: categories/accounts with the same name as ones
// already synced are treated as the same thing, so you don't end up with two "Food" categories.
function reconcile(local, remote) {
  const remap = {};
  const norm = s => String(s).trim().toLowerCase();
  const match = (coll, same) => {
    local[coll] = local[coll].filter(x => {
      if (remote[coll].some(r => r.id === x.id)) return true;
      const m = remote[coll].find(r => same(r, x));
      if (m) { remap[x.id] = m.id; return false; }
      return true;
    });
  };
  match('categories', (r, x) => r.type === x.type && norm(r.name) === norm(x.name));
  match('accounts', (r, x) => r.currency === x.currency && norm(r.name) === norm(x.name));
  for (const t of [...local.transactions, ...(local.recurring || []).map(r => r.template)]) {
    for (const k of ['categoryId', 'accountId', 'toAccountId']) if (remap[t[k]]) { t[k] = remap[t[k]]; t.updated = Date.now(); }
  }
  local.budget.cats = Object.fromEntries(Object.entries(local.budget.cats).map(([id, v]) => [remap[id] || id, v]));
}

/* ---------- sync loop ---------- */
async function syncNow(manual = false) {
  let cfg = syncConfig();
  if (!cfg) return;
  if (syncState.running) { syncState.again = true; return; }
  if (!navigator.onLine) {
    updateSyncUI();
    if (manual) toast("You're offline — changes will sync when you reconnect");
    return;
  }
  clearTimeout(syncState.timer);
  syncState.running = true;
  updateSyncUI();
  const wasDirty = cfg.dirty;
  try {
    let remote = null;
    if (cfg.gistId) {
      try {
        const text = await readGist(cfg);
        if (text) {
          const r = await decryptData(text, cfg.pass);
          remote = migrate(r.data);
          cfg.salt = toB64(r.salt);
        }
      } catch (e) {
        if (e.code !== 'notfound') throw e;
        cfg.gistId = null; // the gist was deleted on GitHub: recreate it from this device's data
      }
    }
    // Edits made from here on mark the config dirty again and trigger another round.
    setSyncConfig({ ...cfg, dirty: false });

    let merged = db;
    if (remote) {
      if (!cfg.lastSync && isPristine(db)) merged = { ...remote };
      else {
        const local = cfg.lastSync ? db : structuredClone(db);
        if (!cfg.lastSync) reconcile(local, remote);
        merged = mergeDb(local, remote);
      }
    }
    const before = JSON.stringify(syncPayload(db));
    if (JSON.stringify(syncPayload(merged)) !== before) {
      replaceDb(merged);
      if (typeof runRecurring === 'function') runRecurring(); // rules from the other device may be due here too
      applyTheme(); render();
    }

    const out = syncPayload(db);
    if (!remote || JSON.stringify(out) !== JSON.stringify(syncPayload(remote))) {
      cfg.salt ||= toB64(crypto.getRandomValues(new Uint8Array(16)));
      const content = await encryptData(out, cfg.pass, fromB64(cfg.salt));
      const files = { [GIST_FILE]: { content } };
      if (cfg.gistId) await gh('PATCH', `/gists/${cfg.gistId}`, cfg.token, { files });
      else cfg.gistId = (await gh('POST', '/gists', cfg.token, { description: GIST_DESC, public: false, files })).id;
    }

    const stored = syncConfig();
    if (!stored) return; // turned off while syncing
    setSyncConfig({ ...cfg, dirty: !!stored.dirty, lastSync: Date.now() });
    syncState.error = '';
    if (stored.dirty) syncState.again = true;
    if (manual) toast('Synced ✓');
  } catch (e) {
    syncState.error = e.message || 'Sync failed';
    const stored = syncConfig();
    if (stored) setSyncConfig({ ...stored, dirty: stored.dirty || wasDirty });
    if (manual || e.code === 'auth' || e.code === 'passphrase') toast(syncState.error);
  } finally {
    syncState.running = false;
    updateSyncUI();
    if (syncState.again) { syncState.again = false; scheduleSync(500); }
  }
}

function scheduleSync(delay = 2500) {
  if (!syncConfig()) return;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(() => syncNow(), delay);
}

// Called by save() in app.js whenever local data actually changed.
function onLocalChange() {
  const cfg = syncConfig();
  if (!cfg) return;
  setSyncConfig({ ...cfg, dirty: true });
  updateSyncUI();
  scheduleSync();
}

function disconnectSync() {
  setSyncConfig(null);
  clearTimeout(syncState.timer);
  syncState.error = '';
  keyCache.clear();
}

/* ---------- status UI ---------- */
const SYNC_LABELS = {
  syncing: ['🔄', 'Syncing…'],
  error: ['⚠️', 'Sync problem'],
  'offline-pending': ['📴', 'Offline — changes waiting'],
  offline: ['📴', 'Offline'],
  pending: ['⏳', 'Changes waiting to sync'],
  synced: ['☁️', 'Synced'],
};

function syncStatus() {
  const cfg = syncConfig();
  if (!cfg) return 'off';
  if (syncState.running) return 'syncing';
  if (syncState.error) return 'error';
  if (!navigator.onLine) return cfg.dirty ? 'offline-pending' : 'offline';
  return cfg.dirty ? 'pending' : 'synced';
}

const ago = t => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString();
};

function syncBadge() {
  const s = syncStatus();
  if (s === 'off') return '';
  const [icon, label] = SYNC_LABELS[s];
  return `<button class="sync-badge sync-${s}" data-act="openSync" title="${label}" aria-label="${label}">${icon}</button>`;
}

function syncSummary() {
  const cfg = syncConfig();
  if (!cfg) return 'Off — keep your phone and laptop in step';
  const s = syncStatus();
  if (s === 'error') return `Problem: ${syncState.error}`;
  return SYNC_LABELS[s][1] + (cfg.lastSync ? ` · ${ago(cfg.lastSync)}` : '');
}

function updateSyncUI() {
  const el = document.querySelector('.sync-badge');
  if (el) el.outerHTML = syncBadge();
  else if (ui.tab !== 'more' && syncConfig()) render();
  // Refresh the sync screen's status text, but never while the connect form is shown (it would clear typed input).
  if (ui.tab === 'more' && ui.sub === 'sync' && syncConfig()) render();
  if (ui.tab === 'more' && !ui.sub) render();
}

SUBVIEWS.sync = () => {
  const cfg = syncConfig();
  if (!cfg) {
    return `<div class="card" style="font-size:14px">Keep your phone and laptop in step. Your data is <b>encrypted on this device</b> with a passphrase you choose, then stored as a private file (a secret gist) in <b>your own GitHub account</b>. GitHub only ever sees scrambled data, and no other server is involved.</div>
      <div class="section-title"><span>Step 1 · Create a sync token on GitHub</span></div>
      <a class="btn secondary" style="text-align:center;text-decoration:none" href="https://github.com/settings/tokens/new?scopes=gist&description=Kakeibo%20sync" target="_blank" rel="noopener">Open GitHub token page ↗</a>
      <div class="muted" style="font-size:13px;padding:6px 4px">Leave only <b>gist</b> ticked, choose an expiration (“No expiration” means you won't need to redo this), press <b>Generate token</b> and copy it. You can use the same token on your other device.</div>
      <div class="section-title"><span>Step 2 · Connect this device</span></div>
      <div class="form">
        <div class="field"><label for="s-token">Token</label><input id="s-token" type="password" autocomplete="off" spellcheck="false" placeholder="ghp_…"></div>
        <div class="field"><label for="s-pass">Passphrase</label><input id="s-pass" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
      </div>
      <div class="muted" style="font-size:13px;padding:0 4px">Use the <b>same passphrase on every device</b> and write it down — it can't be recovered. Without it, synced data can't be read (your entries stay on each device either way).</div>
      <button class="btn" id="s-connect" data-act="syncConnect">Connect &amp; sync</button>`;
  }
  const [icon, label] = SYNC_LABELS[syncStatus()];
  return `<div class="card"><div class="budget-line"><b>${icon} ${label}</b><span class="muted">${cfg.lastSync ? 'Last synced ' + ago(cfg.lastSync) : 'Not synced yet'}</span></div>
      ${syncState.error ? `<div class="neg" style="margin-top:6px;font-size:13px">${esc(syncState.error)}</div>` : ''}</div>
    <button class="btn" data-act="syncNow" ${syncState.running ? 'disabled' : ''}>🔄 Sync now</button>
    <div class="card muted" style="font-size:13px;line-height:1.55"><b>How it works</b><br>
      • Everything works offline. Changes are saved on this device first and marked as waiting (⏳ / 📴 at the top).<br>
      • When you're online they upload within seconds, and changes from your other device arrive when the app opens, reconnects, or every few minutes while it's open.<br>
      • Edits merge entry by entry. If the same entry was changed on both devices, the most recent change wins.<br>
      • Data is encrypted with your passphrase before upload.</div>
    <button class="btn danger" data-act="syncDisconnect">Turn off sync on this device</button>`;
};

Object.assign(actions, {
  openSync: () => { ui.tab = 'more'; ui.sub = 'sync'; render(); scrollTo(0, 0); },
  syncNow: () => syncNow(true),
  syncConnect: async () => {
    const token = $('#s-token').value.trim(), pass = $('#s-pass').value;
    if (!token) { toast('Paste your GitHub token'); return; }
    if (pass.length < 8) { toast('Use a passphrase of at least 8 characters'); return; }
    if (!navigator.onLine) { toast('Connect to the internet to set up sync'); return; }
    const btn = $('#s-connect');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const gistId = await findGist(token);
      if (gistId) {
        // Check the passphrase against the existing data before changing anything on this device.
        const text = await readGist({ token, gistId });
        if (text) await decryptData(text, pass);
      }
      setSyncConfig({ token, pass, gistId, salt: null, lastSync: 0, dirty: true });
      ui.sub = 'sync';
      await syncNow();
      render();
      toast(syncState.error ? syncState.error : gistId ? 'Connected — data merged from your other device' : 'Sync is on — now connect your other device');
    } catch (e) {
      toast(e.message || 'Could not connect');
      btn.disabled = false; btn.textContent = 'Connect & sync';
    }
  },
  syncDisconnect: () => {
    if (!confirm('Turn off sync on this device? Your data stays here and on your other devices.')) return;
    disconnectSync(); render(); toast('Sync turned off on this device');
  },
});

/* ---------- triggers ---------- */
addEventListener('online', () => syncNow());
addEventListener('offline', updateSyncUI);
document.addEventListener('visibilitychange', () => {
  const cfg = syncConfig();
  if (!cfg) return;
  if (document.visibilityState === 'visible' && Date.now() - (cfg.lastSync || 0) > 30000) syncNow();
  if (document.visibilityState === 'hidden' && cfg.dirty) syncNow(); // flush before the app is backgrounded
});
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 5 * 60 * 1000);
if (syncConfig()) { render(); syncNow(); }

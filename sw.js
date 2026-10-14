// Bump VERSION whenever you deploy changes so clients pick up the new files.
const VERSION = 'kakeibo-v7';
// Version-pinned third-party files (the receipt reader). Kept across app updates; they never change.
const CDN_CACHE = 'kakeibo-cdn-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sync.js',
  './receipt.js',
  './notify.js',
  './icons/badge-96.png',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== CDN_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- monthly summary notification ----------
 * The page pre-writes each month's summary text into IndexedDB (the service worker can't read the app's
 * localStorage). In a new month, whichever runs first — Chrome's periodic background check or the app
 * being opened — shows last month's summary once.
 */
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
const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

async function notifySummary(n) {
  await self.registration.showNotification(n.title, {
    body: n.body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: `summary-${n.month}`, data: { month: n.month },
  });
}

async function checkMonthlySummary() {
  const st = await kv('state');
  if (!st?.enabled) return 'disabled';
  const now = new Date();
  const prev = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  if ((st.lastNotified || '') >= prev) return 'already-sent';
  const n = st.summaries?.[prev];
  if (n && !n.empty) await notifySummary(n); // if this throws (permission revoked) we retry next time
  st.lastNotified = prev;
  await kv('state', st);
  return n && !n.empty ? 'sent' : 'nothing-to-report';
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'monthly-summary') e.waitUntil(checkMonthlySummary().catch(() => {}));
});

// The page asks the worker to run the same check (on open) or to send a test notification.
self.addEventListener('message', e => {
  const reply = r => e.ports[0]?.postMessage(r);
  if (e.data?.type === 'check-summary') e.waitUntil(checkMonthlySummary().then(r => reply({ ok: true, result: r }), err => reply({ ok: false, error: String(err) })));
  if (e.data?.type === 'test-summary') e.waitUntil(notifySummary(e.data.notification).then(() => reply({ ok: true }), err => reply({ ok: false, error: String(err) })));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const month = e.notification.data?.month || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.registration.scope));
    if (win) { await win.focus(); win.postMessage({ type: 'open-summary', month }); }
    else await self.clients.openWindow(`./?summary=${month}`);
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // OCR engine + language data from jsDelivr: cache-first so receipt scanning works offline after first use.
  if (url.origin === 'https://cdn.jsdelivr.net') {
    e.respondWith(caches.open(CDN_CACHE).then(async cache => {
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      // Script tags and importScripts give opaque responses; the URLs are version-pinned, so cache them too.
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;

  // App files — stale-while-revalidate: answer from cache instantly (works offline), refresh in the background.
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      const network = fetch(req)
        .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});

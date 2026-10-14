// Bump VERSION whenever you deploy changes so clients pick up the new files.
const VERSION = 'kakeibo-v6';
// Version-pinned third-party files (the receipt reader). Kept across app updates; they never change.
const CDN_CACHE = 'kakeibo-cdn-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sync.js',
  './receipt.js',
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

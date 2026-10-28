const VERSION = '{{VERSION}}';
const CACHE = `chassette-${VERSION}`;
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/PressStart2P-latin.woff2',
  '/fonts/PressStart2P-latin-ext.woff2',
  '/fonts/TwemojiCountryFlags.woff2',
  '/audio/hiss.wav',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for the app shell so new deploys show up immediately; cache is the offline fallback.
// The live API, range requests and cross-origin audio streams are never intercepted.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('range')) return;
  if (url.pathname.startsWith('/api/')) return;

  const key = req.mode === 'navigate' ? '/' : url.pathname;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error())),
  );
});

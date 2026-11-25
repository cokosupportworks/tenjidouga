const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = 'exhibit-video-player-shell:' + SCOPE.pathname + ':';
const CACHE = CACHE_PREFIX + 'v15';
const FILES = [
  './', './index.html', './style.css', './app.js', './storage.js', './manifest.webmanifest',
  './projection.html', './projection.js', './clips.js', './manual.html',
  './apple-touch-icon.png', './icon-192.png', './icon-512.png', './favicon.ico',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(path => new Request(new URL(path, SCOPE), { cache: 'reload' })))));
});

self.addEventListener('message', event => {
  if (event.data === 'activate-exhibit-player-update') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin) return;
  const scopePage = url.pathname === SCOPE.pathname || url.pathname === new URL('./index.html', SCOPE).pathname;
  const shellFile = FILES.find(path => new URL(path, SCOPE).pathname === url.pathname);
  if (!shellFile) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = new URL(event.request.mode === 'navigate' && scopePage ? './' : shellFile, SCOPE);
    return await cache.match(key) || fetch(event.request);
  })());
});

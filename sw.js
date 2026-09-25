// Service worker for QR Bootstrap: stale-while-revalidate, so installed copies pick up
// updates on the next load without having to bump a version.
const CACHE = 'qr-bootstrap';
const ASSETS = ['./', 'index.html', 'fountain.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(request);
    const fresh = fetch(request).then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    });
    if (cached) { fresh.catch(() => {}); return cached; }
    return fresh;
  }));
});

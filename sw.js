// Service worker: every file the loader needs is cached at installation, so that it works without a
// network afterwards. Stale-while-revalidate: an installed copy picks up a new deployment on the
// next launch when a network happens to be available.
const CACHE = 'qr-bootstrap';
const ASSETS = [
  './', 'index.html', 'boot.js', 'core.js', 'fountain.js', 'gif.js', 'decode-worker.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'vendor/qrcode.mjs', 'vendor/jsQR.js',
  'vendor/zxing/share.js', 'vendor/zxing/reader/index.js', 'vendor/zxing/reader/zxing_reader.wasm',
];
const OPTIONAL = ['core.bin']; // absent in builds without a signing key

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS).then(() => Promise.all(OPTIONAL.map(f => c.add(f).catch(() => {})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(request, { ignoreSearch: true });
    const fresh = fetch(request).then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    });
    if (cached) { fresh.catch(() => {}); return cached; }
    return fresh;
  }));
});

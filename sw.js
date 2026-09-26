// Service worker: every file the loader needs is cached at installation, so that it works without a
// network afterwards. Network first: when a network is available each file is fetched fresh (and the
// cache refreshed), so a new deployment appears on the first visit; the cache answers when the
// network fails or takes longer than a few seconds.
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

const TIMEOUT = 4000; // ms before a slow network gives way to the cache

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const fresh = fetch(request, { cache: 'no-cache' }).then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    });
    const late = new Promise(r => setTimeout(r, TIMEOUT));
    try {
      const res = await Promise.race([fresh, late]);
      if (res?.ok) return res;
    } catch {}
    const cached = await cache.match(request, { ignoreSearch: true });
    return cached ?? fresh;
  }));
});

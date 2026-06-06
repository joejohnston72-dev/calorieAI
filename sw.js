const CACHE = 'calorieai-v9';
// Relative paths so the app works whether it's served from the domain root
// or from a project subpath (e.g. GitHub Pages at /calorieai/).
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // Never touch the Anthropic API
  if (req.url.includes('anthropic.com')) return;

  // NETWORK-FIRST: always try to get the freshest version.
  // Fall back to cache only when offline. This guarantees code
  // updates are picked up immediately instead of being stuck
  // behind a stale cached index.html / app.js.
  e.respondWith(
    fetch(req)
      .then(res => {
        // Update the cache with the fresh copy for offline use
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
  );
});

const CACHE = 'calorieai-v12';
// Relative paths so the app works whether it's served from the domain root
// or from a project subpath (e.g. GitHub Pages at /calorieAI/).
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './metabolic.js',
  './manifest.json',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Only prune our own caches: the github.io origin is shared with ARC,
  // whose caches must survive a CalorieAI update.
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('calorieai-') && k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Only GETs for our own files (+ the pinned Chart.js). API calls to Anthropic
  // and GitHub pass straight through: they must fail honestly when offline and
  // their (private, token-authenticated) responses must never be cached.
  if (req.method !== 'GET') return;
  const ours = url.origin === location.origin || url.href.startsWith('https://cdn.jsdelivr.net/npm/chart.js@');
  if (!ours) return;

  // NETWORK-FIRST: always try to get the freshest version.
  // Fall back to cache only when offline. This guarantees code
  // updates are picked up immediately instead of being stuck
  // behind a stale cached index.html / app.js.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(cached =>
        cached || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});

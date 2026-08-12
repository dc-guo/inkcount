/* InkCount service worker.
 *
 * Strategy:
 *  - App shell (small, changes each release): precached at install under a
 *    versioned cache; served network-first with cache fallback, so local
 *    development never sees stale files but the app works offline.
 *  - vendor/ runtime (~80 MB: OpenCV.js, transformers bundle, wasm, model):
 *    cache-first, populated as the pages request it. Too big to block
 *    install on; effectively immutable between releases.
 *
 * CACHE_VERSION bumps together with the page's inkcount-version meta and
 * APP_VERSION in src/ui.js on every release.
 */
const CACHE_VERSION = 'v6';
const SHELL_CACHE = 'inkcount-shell-' + CACHE_VERSION;
const VENDOR_CACHE = 'inkcount-vendor-' + CACHE_VERSION;

const scopeUrl = (p) => new URL(p, self.registration.scope).toString();

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'src/mats.js',
  'src/decode.js',
  'src/preprocess.js',
  'src/segment.js',
  'src/recognize.js',
  'src/count.js',
  'src/geometric.js',
  'src/ui.js',
  'src/store.js',
  'src/preflight.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'samples/sample_page.jpg',
  'device-test.html',
].map(scopeUrl);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const stale = names.filter((n) => n.startsWith('inkcount-') && n !== SHELL_CACHE && n !== VENDOR_CACHE);
    await Promise.all(stale.map((n) => caches.delete(n)));
    await self.clients.claim();
    if (stale.length > 0) {
      for (const client of await self.clients.matchAll({ type: 'window' })) {
        client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
      }
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // never touch cross-origin (there is none)

  const isVendor = url.pathname.includes('/vendor/');
  if (isVendor) {
    // Cache-first: huge, immutable-per-release runtime files.
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const resp = await fetch(req);
      if (resp.ok) cache.put(req, resp.clone());
      return resp;
    })());
    return;
  }

  // Network-first with cache fallback for the shell and everything else in
  // scope: fresh in development and after deploys, available offline.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const resp = await fetch(req);
      if (resp.ok) cache.put(req, resp.clone());
      return resp;
    } catch (_) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match(scopeUrl('index.html'));
        if (shell) return shell;
      }
      throw _;
    }
  })());
});

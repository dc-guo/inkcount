/* InkCount service worker.
 *
 * Strategy:
 *  - App shell (small, changes each release): precached at install under a
 *    versioned cache; served network-first with cache fallback, so local
 *    development never sees stale files but the app works offline.
 *  - vendor/ runtime (~80 MB: OpenCV.js, transformers bundle, wasm, model):
 *    cache-first, populated as the pages request it. Too big to block
 *    install on; effectively immutable between releases. The vendor cache
 *    survives releases by design (stable, un-versioned name) so returning
 *    users never re-download the ~65 MB model.
 *
 * CACHE_VERSION bumps together with the page's inkcount-version meta and
 * APP_VERSION in src/ui.js on every release.
 */
import { idbMatch, idbPut } from './src/vendorstore.js';

const CACHE_VERSION = 'v8';
const SHELL_CACHE = 'inkcount-shell-' + CACHE_VERSION;
// STABLE, un-versioned: releases must never purge the ~65 MB model again
// (v7 clients' legacy inkcount-vendor-v* caches are swept by activate).
const VENDOR_CACHE = 'inkcount-vendor';

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
  'src/history.js',
  'src/vendorstore.js',
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
    // Cache-first, then IndexedDB (large-file fallback), then network with a
    // VERIFIED store: iOS silently rejects huge Cache API writes — catch it
    // and store the blob in IndexedDB instead. waitUntil keeps the worker
    // alive while the copy lands.
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const idbHit = await idbMatch(req.url);
      if (idbHit) return idbHit;
      const resp = await fetch(req);
      if (resp.ok) {
        // Store in the background: clone now, read + persist inside
        // waitUntil so the page starts receiving bytes immediately. The
        // blob is read once so a failed Cache API write can still retry
        // into IndexedDB.
        const copy = resp.clone();
        const contentType = resp.headers.get('Content-Type') || 'application/octet-stream';
        event.waitUntil((async () => {
          try {
            const blob = await copy.blob();
            try { await cache.put(req, new Response(blob, { headers: { 'Content-Type': contentType } })); }
            catch (_) { try { await idbPut(req.url, blob, contentType); } catch (_) {} }
          } catch (_) {}
        })());
      }
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

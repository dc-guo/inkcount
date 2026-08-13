/* IndexedDB fallback store for huge vendor files (the ~45 MB decoder):
 * iOS Safari's Cache API silently rejects very large cache.put() writes,
 * but its IndexedDB handles large Blobs well. sw.js stores here when a
 * Cache API write throws; pages (device-test) read it to report where the
 * model actually lives. Keys are URL pathnames so relative and absolute
 * references to one file share one entry. */

const DB_NAME = 'inkcount-vendor-idb';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
  });
}

const keyFor = (url) => new URL(url, self.location.href).pathname;

export async function idbPut(url, blob, contentType) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ blob, contentType }, keyFor(url));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('idb write failed'));
      tx.onabort = () => reject(tx.error || new Error('idb write aborted'));
    });
  } finally { db.close(); }
}

export async function idbGet(url) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(keyFor(url));
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error || new Error('idb read failed'));
    });
  } finally { db.close(); }
}

export async function idbMatch(url) {
  try {
    const rec = await idbGet(url);
    if (!rec) return null;
    return new Response(rec.blob, { headers: { 'Content-Type': rec.contentType || 'application/octet-stream' } });
  } catch (_) { return null; }
}

export async function idbHas(url) {
  try { return !!(await idbGet(url)); } catch (_) { return false; }
}

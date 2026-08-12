/* Local persistence: the in-progress entry and the private history.
 * localStorage only — nothing ever leaves the device. All reads are
 * corrupt-safe: bad JSON or a wrong shape yields empty state, never a crash.
 * Quota ladder on writes: full -> overlays stripped -> in-memory only. */

const ENTRY_KEY = 'inkcount-entry-v1';
const HISTORY_KEY = 'inkcount-history-v1';
const HISTORY_CAP = 50;

export function storageAvailable() {
  try {
    localStorage.setItem('inkcount-probe', '1');
    localStorage.removeItem('inkcount-probe');
    return true;
  } catch (_) { return false; }
}

function read(key, validate) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return validate(parsed) ? parsed : null;
  } catch (_) { return null; }
}

const isPage = (p) => !!p && typeof p === 'object' && typeof p.count === 'number' &&
  Array.isArray(p.transcript) && Array.isArray(p.perLine) && Array.isArray(p.lowConfidence);
const isEntry = (e) => !!e && typeof e === 'object' && typeof e.id === 'string' &&
  Array.isArray(e.pages) && e.pages.every(isPage);
const isRow = (r) => !!r && typeof r === 'object' && typeof r.id === 'string' &&
  typeof r.total === 'number' && Array.isArray(r.perPageCounts);

export function newEntry() {
  return {
    id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    startedAt: new Date().toISOString(),
    pages: [],
  };
}

export function loadEntry() { return read(ENTRY_KEY, isEntry); }

export function saveEntry(entry) {
  try { localStorage.setItem(ENTRY_KEY, JSON.stringify(entry)); return 'full'; } catch (_) {}
  const lean = { ...entry, pages: entry.pages.map((p) => ({ ...p, overlay: null })) };
  try { localStorage.setItem(ENTRY_KEY, JSON.stringify(lean)); return 'stripped'; } catch (_) {}
  return 'memory';
}

export function clearEntry() { try { localStorage.removeItem(ENTRY_KEY); } catch (_) {} }

export function entryTotal(entry) { return entry.pages.reduce((s, p) => s + p.count, 0); }

export function loadHistory() {
  return read(HISTORY_KEY, (v) => Array.isArray(v) && v.every(isRow)) || [];
}

export function saveToHistory(entry) {
  const row = {
    id: entry.id,
    savedAt: new Date().toISOString(),
    total: entryTotal(entry),
    pageCount: entry.pages.length,
    perPageCounts: entry.pages.map((p) => p.count),
    thumb: entry.pages.length ? entry.pages[0].thumb : null,
  };
  let rows = loadHistory().filter((r) => r.id !== row.id);
  rows.unshift(row);
  while (rows.length > HISTORY_CAP) rows.pop();
  // Quota: evict oldest until the write fits. If even [row] alone cannot be
  // written, the final pop empties the list and we report failure with null.
  while (rows.length) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(rows)); return row; }
    catch (_) { rows.pop(); }
  }
  return null;
}

export function deleteHistoryRow(id) {
  const rows = loadHistory().filter((r) => r.id !== id);
  try {
    if (rows.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(rows));
    else localStorage.removeItem(HISTORY_KEY);
  } catch (_) {}
}

export function clearHistory() { try { localStorage.removeItem(HISTORY_KEY); } catch (_) {} }

export function isEntrySaved(entry) {
  if (!entry || entry.pages.length === 0) return false;
  const digest = entry.pages.map((p) => p.count).join(',');
  return loadHistory().some((r) => r.id === entry.id && r.perPageCounts.join(',') === digest);
}

export function makeThumb(canvas, maxEdge, quality) {
  const s = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * s));
  out.height = Math.max(1, Math.round(canvas.height * s));
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', quality);
}

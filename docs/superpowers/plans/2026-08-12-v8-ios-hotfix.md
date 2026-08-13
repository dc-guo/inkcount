# v8 iOS Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship InkCount version 8 per `docs/superpowers/specs/2026-08-12-v8-ios-hotfix-design.md`: the model caches durably on iOS (stable vendor cache + verified writes + IndexedDB fallback), page reads survive on phones (memory diet + generation caps + crash resume from a session stash), and light-on-dark photos get a pre-flight warning.

**Architecture:** New pure module `web/src/vendorstore.js` (IndexedDB blob store) backs a rewritten service-worker vendor path (stable un-versioned cache, verified writes). `recognize.js` gains a token cap, progressive crop release, and a resume-`prior` argument. `ui.js`'s `analyzePhoto` snapshots all JPEGs up front and drops every large canvas before the model runs, and a sessionStorage stash + boot resume turns iOS tab-kills into continued reads. `preflight.js` gains a median-luminance signal.

**Tech Stack:** Vanilla ES modules, IndexedDB, module-type service worker, existing CDP suite.

## Global Constraints

- Zero-backend covenant: zero off-origin requests (suite audits it).
- Branch `v8-ios-hotfix`; local suite `SUITE: PASS` at every commit boundary; one merge to `main` at release.
- **Pipeline no-diff list for v8:** `web/src/{mats,decode,preprocess,segment,geometric,count}.js` — note `recognize.js` IS in scope this time (Task 2 only), `preflight.js` is in scope (Task 4 only).
- **Accuracy invariant:** the `accuracy`, `segment`, and `count` gates must report identical numbers to v7 — if the token cap shifts any fixture count, the change backs out (spec §7).
- Version stamps stay `7`/`v7` until Task 6, then `meta[name=inkcount-version]`=8, `APP_VERSION`='8', `CACHE_VERSION`='v8' move together. The vendor cache name becomes **stable** (`inkcount-vendor`, no version) in Task 1 and must never regain a version suffix.
- Every new `web/` file joins the sw.js precache SHELL in its creating commit.
- No native `confirm()`/`alert()`. No `Date.now()` restrictions apply here (app code).
- Gate page contract: `tests/<name>.html`, `document.title` = `<NAME> PASS`/`FAIL`, `#verdict` + `#log`, zero console errors, zero external requests.
- Commands run in Git Bash; commits use heredoc messages ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `vendorstore.js` + stable/verified vendor caching in the service worker

**Files:**
- Create: `web/src/vendorstore.js`, `tests/vendorstore.html`
- Modify: `web/sw.js` (vendor cache name, vendor fetch handler, module import), `web/index.html` (SW registration type), `web/device-test.html:50-54` (SW registration type), `tools/ci/run-suite.mjs:32` (DEFAULT_GATES)

**Interfaces:**
- Produces (consumed by sw.js here and device-test in Task 5):
  `idbPut(url, blob, contentType) -> Promise<void>` · `idbGet(url) -> Promise<{blob, contentType}|null>` · `idbMatch(url) -> Promise<Response|null>` · `idbHas(url) -> Promise<boolean>`. Keys are URL **pathnames** (relative and absolute forms of the same file collide to one key). DB `inkcount-vendor-idb`, object store `files`.
- sw.js becomes a **module** service worker; both registrations pass `{ type: 'module' }` (supported Chrome 91+/Safari 16.4+; the target device runs Safari 26.5).

- [ ] **Step 1: Write the gate** — `tests/vendorstore.html` (count.html skeleton):

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>vendorstore module</title>
<style>body{font-family:system-ui;margin:2rem}#verdict{font-size:1.3rem;font-weight:700}.pass{color:#18a34a}.fail{color:#e53935}pre{background:#f4f4f4;padding:1rem}</style></head>
<body>
<h1>vendorstore.js</h1>
<div id="verdict">Running…</div>
<pre id="log"></pre>
<script type="module">
import { idbPut, idbGet, idbMatch, idbHas } from '../web/src/vendorstore.js';

const log = document.getElementById('log');
const lines = [];
const say = (s) => { lines.push(s); log.textContent = lines.join('\n'); };
let failed = null;
const assertTrue = (got, name) => {
  const ok = got === true;
  say(`${ok ? 'ok  ' : 'FAIL'} ${name}: got=${JSON.stringify(got)}`);
  if (!ok && !failed) failed = name;
};

try {
  await new Promise((res) => { const rq = indexedDB.deleteDatabase('inkcount-vendor-idb'); rq.onsuccess = rq.onerror = rq.onblocked = res; });

  assertTrue((await idbGet('/web/vendor/nothing.bin')) === null, 'miss -> null');
  assertTrue((await idbMatch('/web/vendor/nothing.bin')) === null, 'match miss -> null');
  assertTrue((await idbHas('/web/vendor/nothing.bin')) === false, 'has miss -> false');

  const small = new Blob(['hello vendor'], { type: 'text/plain' });
  await idbPut('/web/vendor/small.txt', small, 'text/plain');
  const rec = await idbGet('/web/vendor/small.txt');
  assertTrue(!!rec && rec.contentType === 'text/plain', 'small round-trip contentType');
  const resp = await idbMatch('/web/vendor/small.txt');
  assertTrue(!!resp && (await resp.text()) === 'hello vendor', 'match returns body');
  assertTrue(resp.headers.get('Content-Type') === 'text/plain', 'match returns header');

  // Relative and absolute URLs for the same file share one key.
  const abs = new URL('/web/vendor/small.txt', location.href).href;
  assertTrue(await idbHas(abs), 'absolute URL hits same key');

  // Multi-MB blob (the whole point: large files that Cache API may reject).
  const big = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' });
  await idbPut('/web/vendor/big.onnx', big, 'application/octet-stream');
  const bigResp = await idbMatch('/web/vendor/big.onnx');
  assertTrue(!!bigResp && (await bigResp.blob()).size === 5 * 1024 * 1024, '5 MB round-trip size');

  // Overwrite wins.
  await idbPut('/web/vendor/small.txt', new Blob(['second'], { type: 'text/plain' }), 'text/plain');
  assertTrue((await (await idbMatch('/web/vendor/small.txt')).text()) === 'second', 'overwrite');
} catch (e) {
  failed = failed || 'exception';
  say('EXCEPTION: ' + (e.stack || e.message));
} finally {
  await new Promise((res) => { const rq = indexedDB.deleteDatabase('inkcount-vendor-idb'); rq.onsuccess = rq.onerror = rq.onblocked = res; });
}

const verdict = document.getElementById('verdict');
verdict.textContent = failed ? 'VENDORSTORE FAIL — ' + failed : 'VENDORSTORE PASS';
verdict.className = failed ? 'fail' : 'pass';
document.title = failed ? 'VENDORSTORE FAIL' : 'VENDORSTORE PASS';
</script>
</body>
</html>
```

- [ ] **Step 2: Run it, expect FAIL** — `GATES=vendorstore node tools/ci/run-suite.mjs` → `[gate] vendorstore: FAIL` (module missing). (Requires Step 4's DEFAULT_GATES edit first — do that edit, then run.)

- [ ] **Step 3: Implement `web/src/vendorstore.js`**

```js
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
```

- [ ] **Step 4: Rewrite the sw.js vendor path.** Top of file gains the import and the stable cache name (header comment updated to say the vendor cache survives releases by design):

```js
import { idbMatch, idbPut } from './src/vendorstore.js';

const CACHE_VERSION = 'v7';
const SHELL_CACHE = 'inkcount-shell-' + CACHE_VERSION;
// STABLE, un-versioned: releases must never purge the ~65 MB model again
// (v7 clients' legacy inkcount-vendor-v* caches are swept by activate).
const VENDOR_CACHE = 'inkcount-vendor';
```

The activate handler's stale filter is already `n.startsWith('inkcount-') && n !== SHELL_CACHE && n !== VENDOR_CACHE` — with the stable name it now automatically deletes legacy `inkcount-vendor-v7`; **no change needed, verify it reads exactly that**. Replace the vendor branch of the fetch handler with:

```js
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
        const blob = await resp.clone().blob();
        const contentType = resp.headers.get('Content-Type') || 'application/octet-stream';
        event.waitUntil((async () => {
          try { await cache.put(req, new Response(blob, { headers: { 'Content-Type': contentType } })); }
          catch (_) { try { await idbPut(req.url, blob, contentType); } catch (_) {} }
        })());
      }
      return resp;
    })());
    return;
  }
```

Add `'src/vendorstore.js',` to SHELL after `'src/history.js',`. In `tools/ci/run-suite.mjs` DEFAULT_GATES insert `vendorstore` after `preflight` (13 gates).

- [ ] **Step 5: Module registrations.** In `web/index.html`'s inline SW script AND `web/device-test.html:52`, the register call becomes:

```js
    navigator.serviceWorker.register('./sw.js', { type: 'module' }).catch(function () {});
```

(index.html's version keeps its existing comment/catch shape; only the options argument is added.)

- [ ] **Step 6: Gate green, pwa green** — `GATES=vendorstore,pwa node tools/ci/run-suite.mjs` → both PASS. The pwa gate is the SW integration proof: offline boot to Ready through the module worker and stable vendor cache.

- [ ] **Step 7: Full suite, commit**

Run: `node tools/ci/run-suite.mjs` → `SUITE: PASS` (13 gates + 24-step walkthrough).
Commit: `git add web/src/vendorstore.js tests/vendorstore.html web/sw.js web/index.html web/device-test.html tools/ci/run-suite.mjs && git commit -m "v8: stable vendor cache with verified writes + IndexedDB fallback"`

### Task 2: `recognize.js` — token cap, progressive crop release, resume-`prior`

**Files:**
- Modify: `web/src/recognize.js:64-91` (recognizeLines + new export)
- Modify: `tests/recognize.html` (append two assertions)

**Interfaces:**
- Produces (consumed by Task 3 and device-test): `recognizeLines(crops, onLine, prior = []) -> Promise<string[]>` — for `i < prior.length` the output is `prior[i]`, no inference runs, `onLine` does NOT fire; every consumed slot is set `crops[i] = null` (the array's `.length` is preserved); `onLine(i, n, text)` fires only for freshly-read lines. New export `MAX_NEW_TOKENS = 48`. Existing callers with two args are unaffected.

- [ ] **Step 1: Replace `recognizeLines`** (docstring updated to match):

```js
/** Longest sensible generation for one handwritten line (~5-12 words).
 * Far above any real line, far below a runaway repetition loop — bounds both
 * latency and the per-line wasm memory spike that kills iOS tabs. */
export const MAX_NEW_TOKENS = 48;

/**
 * recognizeLines(crops, onLine, prior) -> transcripts (one string per crop,
 * '' on a per-line failure — a single bad crop must not sink the page).
 * prior: transcripts from an interrupted read; those lines are reused, not
 * re-read. Consumed crop slots are nulled so a long page never holds every
 * line canvas at once (iOS memory kills). onLine(i, n, text) fires only for
 * freshly-read lines.
 */
export async function recognizeLines(crops, onLine, prior = []) {
  const ocr = await modelPromise;
  if (!ocr) throw new Error('Model not loaded — call loadModel() first.');
  const out = [];
  for (let i = 0; i < crops.length; i++) {
    if (i < prior.length) {
      out.push(prior[i]);
      crops[i] = null;
      continue;
    }
    let text = '';
    try {
      // Data URLs are the pipeline's most portable image input across
      // transformers.js versions; the PNG encode is a few ms per line.
      const result = await ocr(crops[i].toDataURL('image/png'), { max_new_tokens: MAX_NEW_TOKENS });
      text = (result?.[0]?.generated_text ?? '').trim();
    } catch (e) {
      lastError = e;
      text = '';
    }
    crops[i] = null; // release the consumed canvas immediately
    out.push(text);
    try { onLine && onLine(i, crops.length, text); } catch (_) {}
    await new Promise((r) => setTimeout(r, 0)); // let Safari's GC breathe
  }
  return out;
}
```

- [ ] **Step 2: Append two assertions to `tests/recognize.html`.** Read the file first; using its existing `say`/fail bookkeeping (model is already loaded by its earlier tests), append before the verdict block:

```js
// v8: resume-prior skips inference entirely for seeded lines.
{
  let fired = 0;
  const seeded = await recognizeLines([null], () => { fired++; }, ['seeded line']);
  const ok = JSON.stringify(seeded) === JSON.stringify(['seeded line']) && fired === 0;
  say(`${ok ? 'ok  ' : 'FAIL'} prior skip: out=${JSON.stringify(seeded)} onLine fired=${fired}`);
  if (!ok && !failed) failed = 'prior skip';
}
// v8: consumed crops are released (slot nulled, length preserved).
{
  const c = document.createElement('canvas'); c.width = 100; c.height = 32;
  c.getContext('2d').fillStyle = '#fff'; c.getContext('2d').fillRect(0, 0, 100, 32);
  const arr = [c];
  const out = await recognizeLines(arr, null);
  const ok = arr.length === 1 && arr[0] === null && out.length === 1 && typeof out[0] === 'string';
  say(`${ok ? 'ok  ' : 'FAIL'} crop release: slot=${arr[0]} len=${arr.length} out=${JSON.stringify(out)}`);
  if (!ok && !failed) failed = 'crop release';
}
```

(If the gate's local variable names differ — e.g. `failed` — adapt to its actual names; the assertions' logic is fixed.)

- [ ] **Step 3: Gates** — `GATES=recognize,accuracy,count,segment node tools/ci/run-suite.mjs` → all PASS **with the accuracy table identical to v7's** (compare the logged per-fixture numbers against the previous `tools/ci/report.json` if still present, else the bounds assertion suffices — the gate asserts exact counts for cursive and the illustration). If any fixture count changed, remove the `max_new_tokens` option, re-run to confirm it was the cause, and STOP — report BLOCKED with the numbers (spec §7 backs the cap out rather than shipping shifted counts).

- [ ] **Step 4: Full suite, commit**

Run: `node tools/ci/run-suite.mjs` → `SUITE: PASS`.
Commit: `git add web/src/recognize.js tests/recognize.html && git commit -m "v8: cap generation, release crops progressively, resume-prior arg"`

### Task 3: ui.js memory diet + crash stash/resume + walkthrough

**Files:**
- Modify: `web/src/ui.js` (analyzePhoto, showStagedOverlay, countCurrentPhoto, loadInto, clearPhoto, startNewEntry, boot; new stash helpers + resume)
- Modify: `tools/ci/run-suite.mjs` (`runUI()`: one changed assertion + one new end-block)

**Interfaces:**
- Consumes: `recognizeLines(crops, onLine, prior)` and `MAX_NEW_TOKENS`-capped behavior from Task 2; `makeThumb` from store.js.
- Produces: sessionStorage contract (consumed by the walkthrough and by future device work) — `inkcount-stash-photo-v1` = JSON `{name, dataUrl}` written at analyze time; `inkcount-stash-progress-v1` = JSON `{total, transcripts: [string]}` written at read start and after every line; both cleared on read completion (photo key only if the read's photo is still staged), Clear photo, New entry, or manually staging a different photo. After `analyzePhoto`, `state.photo` = `{name, crops, lines, skewAngle, textHeight, rejectedCount, thumb, overlayJpeg, preview}` — **no canvas fields**; `countCurrentPhoto(prior = [])` accepts resume transcripts.

- [ ] **Step 1: Stash helpers** (place near `persistEntry`):

```js
  const STASH_PHOTO_KEY = 'inkcount-stash-photo-v1';
  const STASH_PROGRESS_KEY = 'inkcount-stash-progress-v1';

  function writeStashPhoto(name, dataUrl) {
    try { sessionStorage.setItem(STASH_PHOTO_KEY, JSON.stringify({ name, dataUrl })); } catch (_) {}
  }
  function writeStashProgress(total, transcripts) {
    try { sessionStorage.setItem(STASH_PROGRESS_KEY, JSON.stringify({ total, transcripts })); } catch (_) {}
  }
  function clearStashProgress() {
    try { sessionStorage.removeItem(STASH_PROGRESS_KEY); } catch (_) {}
  }
  function clearStash() {
    try { sessionStorage.removeItem(STASH_PHOTO_KEY); } catch (_) {}
    clearStashProgress();
  }
  function readStash() {
    try {
      const photo = JSON.parse(sessionStorage.getItem(STASH_PHOTO_KEY));
      if (!photo || typeof photo.dataUrl !== 'string' || typeof photo.name !== 'string') return null;
      let progress = null;
      try { progress = JSON.parse(sessionStorage.getItem(STASH_PROGRESS_KEY)); } catch (_) {}
      if (progress && (!Array.isArray(progress.transcripts) || typeof progress.total !== 'number')) progress = null;
      return { photo, progress };
    } catch (_) { return null; }
  }
```

- [ ] **Step 2: `analyzePhoto` — snapshot early, drop early.** Full replacement (keeps the identity token; `drawOverlay` and DEBUG behavior unchanged):

```js
  async function analyzePhoto() {
    const mine = state.photo;
    setStatus('Straightening and reading the page layout…');
    const staged = await withMats(async (scope) => {
      const pre = preprocess(mine.canvas, scope);
      const segs = segmentLines(pre, scope);
      const est = estimateWords(pre, segs);
      const overlay = drawOverlay(pre.gray, segs.map((s) => s.rect), est.boxes, segs.rejected);
      if (DEBUG && segs.rejected) console.log('[inkcount debug] rejected bands:', JSON.stringify(segs.rejected));
      return { crops: segs.map((s) => s.canvas), overlayCanvas: overlay, skewAngle: pre.skewAngle,
        textHeight: pre.textHeight, lines: segs.length, rejectedCount: (segs.rejected || []).length };
    });
    if (state.photo !== mine) return;
    // Snapshot every JPEG the rest of the flow needs, stash the photo for
    // crash resume, then DROP the big canvases — during the model read the
    // only pixel data alive is the line crops (released one by one).
    mine.thumb = makeThumb(mine.canvas, 160, 0.7);
    mine.overlayJpeg = makeThumb(staged.overlayCanvas, 1000, 0.75);
    mine.preview = makeThumb(mine.canvas, 800, 0.8);
    if (!mine.fromStash) writeStashPhoto(mine.name, makeThumb(mine.canvas, 2000, 0.8));
    mine.crops = staged.crops;
    mine.skewAngle = staged.skewAngle;
    mine.textHeight = staged.textHeight;
    mine.lines = staged.lines;
    mine.rejectedCount = staged.rejectedCount;
    mine.canvas = null;
    showPreviewImage(mine);
    showStagedOverlay();
    renderWarnings(evaluatePreflight(staged));
    setStatus(staged.lines === 0 ? 'No handwriting found in this photo — try another.' : 'Ready — press Count words.');
    updateRunEnabled();
  }

  function showPreviewImage(ph) {
    const img = document.createElement('img');
    img.src = ph.preview;
    img.alt = 'Photo of your page: ' + ph.name;
    els.imageSlot.replaceChildren(img);
  }
```

- [ ] **Step 3: `showStagedOverlay` — img, not canvas.** Full replacement:

```js
  function showStagedOverlay() {
    const ph = state.photo;
    const img = document.createElement('img');
    img.src = ph.overlayJpeg;
    img.alt = ph.lines === 0 ? 'The straightened page — no handwritten lines found'
      : 'The straightened page with ' + ph.lines + ' detected line' + (ph.lines > 1 ? 's' : '') + ' boxed';
    img.title = 'Open full size';
    img.addEventListener('click', async () => {
      const blob = await (await fetch(ph.overlayJpeg)).blob();
      window.open(URL.createObjectURL(blob), '_blank');
    });
    els.overlaySlot.replaceChildren(img);
    els.overlayCaption.textContent = (ph.lines === 0
      ? "No handwritten lines were found on this photo — nothing is boxed. InkCount looks for rows of English handwriting; drawings, printed pages, and non-English text won't register."
      : 'New photo — ' + ph.lines + ' line' + (ph.lines > 1 ? 's' : '') + ' detected on the straightened page. Press Count words to read them.')
      + (DEBUG && ph.rejectedCount ? ' [debug: ' + ph.rejectedCount + ' rejected band' + (ph.rejectedCount > 1 ? 's' : '') + ' in red]' : '');
    els.overlayCard.hidden = false;
  }
```

- [ ] **Step 4: `countCurrentPhoto(prior = [])`.** Changes relative to the current body — signature gains `prior`; the streaming seed becomes `const seen = prior.slice();`; progress stash writes bracket the read; the PageRecord uses the snapshots; stash clears on success. Show the full changed region:

```js
  async function countCurrentPhoto(prior = []) {
    if (state.running || !state.photo || !state.photo.crops || state.photo.lines === 0) return;
    state.running = true;
    hideError();
    els.reset.disabled = true;
    els.newEntryBtn.disabled = true;
    els.saveEntryBtn.disabled = true;
    updateRunEnabled();
    const t0 = performance.now();
    const ph = state.photo;
    const baseTotal = state.entry ? entryTotal(state.entry) : 0;
    const pageNo = (state.entry ? state.entry.pages.length : 0) + 1;
    try {
      setStatus('Loading the handwriting reader…');
      els.progress.hidden = false;
      els.progress.removeAttribute('max');
      els.progress.removeAttribute('value');
      await loadModel((p) => {
        if (p && p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
          els.progress.max = 100;
          els.progress.value = Math.round(p.progress || 0);
          setStatus('Downloading the handwriting reader (one-time)… ' + Math.round(p.progress || 0) + '%');
        }
      });
      els.progress.max = ph.crops.length;
      els.progress.value = prior.length;
      writeStashProgress(ph.crops.length, prior);
      const seen = prior.slice();
      const transcripts = await recognizeLines(ph.crops, (i, n, text) => {
        seen.push(text);
        writeStashProgress(n, seen);
        els.progress.value = i + 1;
        setStatus('Reading line ' + (i + 1) + ' of ' + n + ' on page ' + pageNo + '…');
        showCount(baseTotal + countWords(seen).total, 'so far — reading line ' + (i + 1) + ' of ' + n + '…');
      }, prior);
      const { total, perLine, lowConfidence } = countWords(transcripts);
      const flagged = lowConfidence.filter(Boolean).length;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (!state.entry) state.entry = newEntry();
      state.entry.pages.push({
        name: ph.name, count: total, lines: ph.lines, secs: Number(secs),
        transcript: transcripts, perLine, lowConfidence,
        thumb: ph.thumb,
        overlay: ph.overlayJpeg,
      });
      state.selectedPage = state.entry.pages.length - 1;
      persistEntry();
      clearStashProgress();
      if (state.photo === ph) {
        clearStash();
        state.photo = null;
        els.imageSlot.replaceChildren();
        els.label.textContent = 'No image loaded.';
        els.fileInput.value = '';
        els.cameraInput.value = '';
        renderWarnings([]);
      }
      els.progress.hidden = true;
      state.running = false;
      renderEntry();
      renderSelectedPage();
      setStatus('Page ' + pageNo + ' done in ' + secs + 's — ' + total + ' word' + (total === 1 ? '' : 's') +
        (flagged ? ' (' + flagged + ' line' + (flagged > 1 ? 's' : '') + ' not counted)' : '') +
        '. Entry total: ' + entryTotal(state.entry) + '.');
    } catch (e) {
      state.running = false;
      showError(humanError('Counting failed', e));
      setStatus('Error.');
      els.progress.hidden = true;
      renderEntry();
      // The crops are partially consumed — this photo can't be re-counted
      // as-is. Re-stage it from the stash (no auto-count: a persistent
      // failure must not loop).
      if (state.photo === ph) {
        const stash = readStash();
        state.photo = null;
        clearStashProgress();
        if (stash) {
          try {
            const blob = await (await fetch(stash.photo.dataUrl)).blob();
            await loadInto(blob, stash.photo.name, 'Re-preparing the photo…', { fromStash: true });
          } catch (_) {}
        }
      }
    } finally {
      state.running = false;
      els.reset.disabled = false;
      els.newEntryBtn.disabled = false;
      renderSaveButton();
      updateRunEnabled();
    }
  }
```

- [ ] **Step 5: `loadInto` gains a `fromStash` option** (skips clearing/re-writing the stash when the photo IS the stash). Changed signature and the two touched spots — the rest of the body stays as it is today:

```js
  async function loadInto(source, name, loadingMessage, { fromStash = false } = {}) {
    state.loading = true;
    updateRunEnabled();
    setStatus(loadingMessage);
    hideError();
    if (!fromStash) clearStash(); // a manually staged photo invalidates any old stash
    try {
      const canvas = await decodeToCanvas(source);
      state.photo = { canvas, name, crops: null, fromStash };
      ...rest unchanged...
```

`clearPhoto()` and `startNewEntry()` each gain a `clearStash();` line next to their existing `renderWarnings([]);`.

- [ ] **Step 6: Boot resume.** In the `loadOpenCV().then(...)` block, after the existing photo/status logic add:

```js
    const stash = readStash();
    if (stash && !state.photo) await resumeFromStash(stash);
```

and add the function:

```js
  async function resumeFromStash(stash) {
    const doneLines = stash.progress ? stash.progress.transcripts.length : 0;
    if (stash.progress) {
      setStatus('Your last read was interrupted at line ' + Math.min(doneLines + 1, stash.progress.total) +
        ' of ' + stash.progress.total + ' — this device ran low on memory. Resuming…');
    }
    try {
      const blob = await (await fetch(stash.photo.dataUrl)).blob();
      await loadInto(blob, stash.photo.name, 'Restoring your photo…', { fromStash: true });
      if (stash.progress && state.photo && state.photo.crops) {
        if (state.photo.crops.length === stash.progress.total) {
          await countCurrentPhoto(stash.progress.transcripts);
        } else {
          // The restored photo segmented differently — prior lines don't map.
          clearStashProgress();
          setStatus('Photo restored — press Count words to read it from the start.');
        }
      }
    } catch (e) {
      clearStash();
      showError(humanError('Your interrupted photo could not be restored', e));
    }
  }
```

- [ ] **Step 7: Walkthrough.** (a) In the `analyze-on-load` eval, `overlayCanvases: document.querySelectorAll('#overlay-slot canvas').length` becomes `overlayImgs: document.querySelectorAll('#overlay-slot img').length` and the step condition uses `overlayImgs === 1`. (b) Insert this block immediately BEFORE the `camera-first-markup` step (at that point the entry holds 1 unsaved page from `refresh-then-run`):

```js
    // Crash-resume: seed a stash as if a read was killed before line 1,
    // reload, and the app must restore the photo and finish the read alone.
    await evalJS(page.cdp, `(function () {
      window.__stashSeeded = false;
      fetch('./samples/sample_page.jpg').then((r) => r.blob()).then((b) => new Promise((res) => {
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b);
      })).then((dataUrl) => {
        sessionStorage.setItem('inkcount-stash-photo-v1', JSON.stringify({ name: 'sample_page.jpg', dataUrl: dataUrl }));
        sessionStorage.setItem('inkcount-stash-progress-v1', JSON.stringify({ total: 16, transcripts: [] }));
        window.__stashSeeded = true;
      });
    })()`);
    await pollEval(page.cdp, `window.__stashSeeded === true`, (v) => v === true, 30000, 'stash seeded');
    origin = await evalJS(page.cdp, 'performance.timeOrigin');
    await page.goto(`${BASE}/web/index.html?resume=1`);
    await freshReady(origin, 'ready for resume');
    await pollEval(page.cdp, `document.querySelectorAll('#pages-strip .page-card').length`, (n) => n === 2, 600000, 'resume completed');
    const resumed = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      total: parseInt(document.getElementById('result-total').textContent, 10),
      stashPhotoCleared: sessionStorage.getItem('inkcount-stash-photo-v1') === null,
      stashProgressCleared: sessionStorage.getItem('inkcount-stash-progress-v1') === null,
    })`));
    step('crash-resume', resumed.total >= 340 && resumed.total <= 400 &&
      resumed.stashPhotoCleared === true && resumed.stashProgressCleared === true, resumed);
```

(The seeded stash uses the sample's ORIGINAL bytes — FileReader base64 of the fetched blob — so re-analysis reproduces exactly 16 crops and the resume path auto-counts to a second page: strip 2, total 340–400.)

- [ ] **Step 8: Full suite** — `node tools/ci/run-suite.mjs` → `SUITE: PASS` (25-step walkthrough). Debug via `[ui] failure page state` on failures.

- [ ] **Step 9: Commit** — `git add web/src/ui.js tools/ci/run-suite.mjs && git commit -m "v8: read-memory diet + crash stash and auto-resume"`

### Task 4: `preflight.js` — median luminance + `inverted` warning

**Files:**
- Modify: `web/src/preflight.js`, `tests/preflight.html`, `web/src/ui.js` (two lines in analyzePhoto)

**Interfaces:**
- Produces: `medianLuminance(grayLike) -> number` (0–255; `grayLike` needs only `.data` of grayscale bytes — an OpenCV gray Mat qualifies); `evaluatePreflight` signals gain optional `medianLum` (undefined ⇒ rule skipped); new warning id `inverted` (fires when `medianLum < DARK_BACKGROUND_MEDIAN`, exported const = 110), emitted FIRST and preserved even when `no-lines` short-circuits the rest.

- [ ] **Step 1: Extend the gate.** In `tests/preflight.html` add unit rows before the calibration section (adapting to the file's `assertIds` helper):

```js
assertIds({ skewAngle: 0, lines: 5, textHeight: 30, medianLum: 109 }, ['inverted'], 'dark background');
assertIds({ skewAngle: 0, lines: 5, textHeight: 30, medianLum: 110 }, [], 'light background at threshold');
assertIds({ skewAngle: 0, lines: 5, textHeight: 30 }, [], 'medianLum absent -> rule skipped');
assertIds({ skewAngle: 0, lines: 0, textHeight: 30, medianLum: 50 }, ['inverted', 'no-lines'], 'inverted survives no-lines short-circuit');
assertIds({ skewAngle: 5, lines: 1, textHeight: 5, medianLum: 50 }, ['inverted', 'one-line', 'tilted', 'small-text'], 'inverted first in stack');
```

And extend the calibration loop's `withMats` return with `medianLum: medianLuminance(pre.gray)` (import it at the top), include it in the signals passed to `evaluatePreflight`, and log it per fixture — every fixture and the sample are light-background and must stay free of `inverted` (expected want-lists unchanged).

- [ ] **Step 2: Run gate, expect FAIL** — `GATES=preflight node tools/ci/run-suite.mjs` → FAIL (`medianLuminance` not exported).

- [ ] **Step 3: Implement in `web/src/preflight.js`:**

```js
export const DARK_BACKGROUND_MEDIAN = 110;

/** Median luminance (0-255) of a grayscale image ({data} of bytes — an
 * OpenCV gray Mat qualifies). Pure; histogram-based, O(n). */
export function medianLuminance(grayLike) {
  const data = grayLike.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const half = data.length / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= half) return v; }
  return 255;
}
```

and rework `evaluatePreflight` so `inverted` is computed first and survives the `no-lines` early return:

```js
export function evaluatePreflight({ skewAngle, lines, textHeight, medianLum }) {
  const warnings = [];
  if (typeof medianLum === 'number' && medianLum < DARK_BACKGROUND_MEDIAN) {
    warnings.push({ id: 'inverted', severity: 'warn',
      message: "This looks like light text on a dark background — InkCount reads dark handwriting on light paper (photos of screens and dark-mode pages won't count reliably)." });
  }
  if (lines === 0) {
    warnings.push({ id: 'no-lines', severity: 'warn',
      message: 'No handwritten lines were found. Retake closer and straight on — fill the frame with the page.' });
    return warnings;
  }
  ...one-line / tilted / small-text rules unchanged...
  return warnings;
}
```

(Module header comment gains one line documenting the 110 threshold and its calibration evidence from the gate log.)

- [ ] **Step 4: Wire into ui.js.** In `analyzePhoto`'s `withMats` return add `medianLum: medianLuminance(pre.gray),` (import `medianLuminance` alongside `evaluatePreflight`), and pass it through: the `evaluatePreflight(staged)` call already receives it via `staged`.

- [ ] **Step 5: Gates then full suite** — `GATES=preflight node tools/ci/run-suite.mjs` → PASS with per-fixture medianLum logged; then `node tools/ci/run-suite.mjs` → `SUITE: PASS` (sample stays zero-warning in the walkthrough's `analyze-on-load`).

- [ ] **Step 6: Commit** — `git add web/src/preflight.js tests/preflight.html web/src/ui.js && git commit -m "v8: light-on-dark preflight warning (median luminance)"`

### Task 5: device-test — "Reader cached?" row + kill breadcrumbs

**Files:**
- Modify: `web/device-test.html`

**Interfaces:**
- Consumes: `idbHas(url)` from `web/src/vendorstore.js` (Task 1); `recognizeLines(crops, onLine)` per-line callback (Task 2).

- [ ] **Step 1: Breadcrumbs.** Add `import { idbHas } from './src/vendorstore.js';` to the module imports. At the top of the async IIFE (before the Browser row):

```js
  const CRUMB = 'inkcount-devtest-crumb';
  try {
    const prev = JSON.parse(localStorage.getItem(CRUMB) || 'null');
    if (prev && prev.done === false) {
      row('Previous run', 'bad', 'was killed at line ' + prev.line + ' of ' + prev.total +
        ' — this device runs out of memory mid-read');
    }
  } catch (_) {}
```

In the counting-accuracy try block, bracket the read (the `recognizeLines` call gains a callback):

```js
    localStorage.setItem(CRUMB, JSON.stringify({ line: 0, total: crops.length, done: false }));
    const transcripts = await recognizeLines(crops, (i, n) => {
      try { localStorage.setItem(CRUMB, JSON.stringify({ line: i + 1, total: n, done: false })); } catch (_) {}
    });
```

and after the `countWords` line: `localStorage.setItem(CRUMB, JSON.stringify({ done: true }));`
Note Task 2's crop release nulls `crops[i]` — the existing `crops.length` uses below remain valid (length is preserved), but the per-line timing math must not touch `crops[i]` (it doesn't).

- [ ] **Step 2: "Reader cached?" row.** After the counting-accuracy block (model long since fetched; the SW's waitUntil store has had time to land), insert:

```js
  try {
    const decoderPath = './vendor/models/Xenova/trocr-small-handwritten/onnx/decoder_model_merged_quantized.onnx';
    const decoderUrl = new URL(decoderPath, location.href).href;
    const cacheHit = typeof caches !== 'undefined' && !!(await caches.match(decoderUrl, { ignoreSearch: true }));
    const inIdb = await idbHas(decoderUrl);
    row('Reader cached?', (cacheHit || inIdb) ? 'ok' : 'bad',
      cacheHit ? 'yes — Cache API (survives new visits and app updates)'
        : inIdb ? 'yes — IndexedDB large-file fallback (survives new visits and app updates)'
          : 'NO — the ~65 MB reader will re-download on the next visit');
  } catch (e) { row('Reader cached?', 'skip', e.message); }
```

- [ ] **Step 3: Verify + commit.** `node tools/ci/run-suite.mjs` → `SUITE: PASS` (device-test isn't gate-driven, but it IS in the SW precache — the pwa gate proves it still installs; load `http://localhost:8000/web/device-test.html` once via `python -m http.server 8000` or rely on the suite's server if simpler, and confirm by eye in the suite logs that no gate broke). Commit: `git add web/device-test.html && git commit -m "v8: device-test reader-cache row + mid-read kill breadcrumbs"`

### Task 6: Release version 8

**Files:**
- Modify: `web/index.html` (meta 7→8), `web/src/ui.js` (`APP_VERSION = '8'`), `web/sw.js` (`CACHE_VERSION = 'v8'`)

- [ ] **Step 1: Stamps** — all three move together to `8`/`'8'`/`'v8'`. Verify `VENDOR_CACHE` is still the un-versioned `'inkcount-vendor'` (the point of this release).
- [ ] **Step 2: Full suite** — `node tools/ci/run-suite.mjs` → `SUITE: PASS`. Commit: `git add web/index.html web/src/ui.js web/sw.js && git commit -m "v8 release: version stamps (stable model cache, read resume, dark-photo warning)"`
- [ ] **Step 3: Merge + push** (controller-executed): `git checkout main && git merge --no-ff v8-ios-hotfix && git push origin main`; watch the Actions run to green deploy.
- [ ] **Step 4: Live verify** (controller): fresh load → version 8, sample count completes; mobile-preset reload → camera-first intact; then hand to the user's iPhone: sample read completes (or resumes to completion), second visit shows no reader download, device-test "Reader cached?" green, dark-mode book photo fires the `inverted` warning.

---

## Self-review

- **Spec coverage:** W1→Task 1 (+device-test row in Task 5); W2→Tasks 2–3 (pre-sized crops deferred per amended spec); W3→Task 3 (+breadcrumbs Task 5); W4→Task 4; release/§6→Task 6; §7 DoD phone items are Task 6 step 4 user-side checks. Accuracy invariant enforced in Task 2 step 3 with an explicit BLOCKED path.
- **Placeholders:** Task 3 step 4/5 mark unchanged regions with "rest unchanged" against the current file — acceptable because the implementer edits the live file; every CHANGED line is shown. Task 2 step 2 and Task 4 step 1 tell the implementer to adapt helper names to the gate file they read first, with fixed logic shown.
- **Type consistency:** `idbPut(url, blob, contentType)`/`idbMatch`/`idbHas` consistent across Tasks 1/5; `recognizeLines(crops, onLine, prior)` consistent across Tasks 2/3 and device-test's 2-arg call remains valid; stash keys `inkcount-stash-photo-v1`/`inkcount-stash-progress-v1` identical in Task 3 code and walkthrough; `medianLum` name identical in Tasks 3(wiring in T4 step 4)/4; `overlayJpeg`→PageRecord `overlay` mapping shown in Task 3 step 4.
- **Sequencing:** T1 (independent) → T2 (recognize contract) → T3 (consumes prior) → T4 (adds signal into T3's analyze) → T5 (consumes T1+T2) → T6. Suite green at every boundary; walkthrough count moves 24→25 in T3.

# v8.1 Reader Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship InkCount version 9 per `docs/superpowers/specs/2026-08-13-v81-reader-prefetch-design.md`: the reader downloads and stores at idle boot time (never racing a read's memory peak), every vendor store is read-back-verified with a per-file log, and device-test reports where the store landed.

**Architecture:** `recognize.js` gets a mutable progress ref; `ui.js` gains `prefetchReader()` + `setIdleStatus()`; `sw.js`'s vendor store verifies each layer by reading it back and logs the outcome through new `vendorstore.js` meta helpers; `device-test.html` surfaces the log.

**Tech Stack:** unchanged (vanilla ES modules, module SW, CDP suite).

## Global Constraints

- Branch `v81-reader-prefetch`; `PORT=8010` on every suite command; `SUITE: PASS` (13 gates + 25-step walkthrough) at every commit boundary; foreground runs, timeout 600000.
- Pipeline no-diff list: `web/src/{mats,decode,preprocess,segment,geometric,count,preflight,store,history}.js` (recognize.js Task 1 only, vendorstore.js Task 2 only).
- Accuracy/segment/count gate numbers must stay identical (nothing here touches inference parameters — a shift means something went wrong; report BLOCKED).
- Version stamps stay `8`/`v8` until Task 3, then all three move to `9`/`'9'`/`'v9'` together. `VENDOR_CACHE` stays the stable `'inkcount-vendor'`.
- No native dialogs; zero off-origin requests; commits via Git Bash heredoc ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Boot prefetch (`recognize.js` progress ref + `ui.js` prefetch/idle-status)

**Files:**
- Modify: `web/src/recognize.js` (loadModel), `web/src/ui.js` (boot block + two new functions + one import)

**Interfaces:**
- Produces: `loadModel(onProgress)` — a non-null `onProgress` on ANY call (first or memoized) replaces the live callback; `prefetchReader()` and `setIdleStatus()` in ui.js scope. Consumes: `isModelReady()` (already exported).

- [ ] **Step 1: recognize.js.** Add a module-level ref and rewire the callback (only these lines change):

```js
let currentProgress = null;
```

In `loadModel(onProgress)`: first line becomes `if (onProgress) currentProgress = onProgress;`, and the pipeline option becomes `progress_callback: (ev) => { try { currentProgress && currentProgress(ev); } catch (_) {} },`. Docstring gains: "A non-null onProgress on any call (even when the load is already in flight) replaces the live progress callback — a Count pressed mid-prefetch takes over the progress UI."

- [ ] **Step 2: ui.js.** Import `isModelReady` alongside the existing recognize imports. Add near `persistEntry`:

```js
  function setIdleStatus() {
    if (state.photo || state.running) return;
    setStatus(state.cvReady ? (state.entry ? 'Ready — add another page.' : 'Ready — add a page.') : 'Preparing the analyzer…');
  }

  function prefetchReader() {
    // Download + store the ~65 MB reader while the page is idle. On tight
    // devices the service worker's background store must not race a read's
    // memory peak — field-observed on iOS: the store lost that race, so
    // every crash re-downloaded the model and the transfer buffers fed the
    // very pressure causing the kills.
    if (isModelReady()) return;
    let announced = false;
    loadModel((p) => {
      if (!announced && p && p.status === 'progress') {
        announced = true;
        if (!state.photo && !state.running) setStatus('Ready — the reader is downloading in the background (one-time)…');
      }
    }).then(() => {
      setIdleStatus();
    }).catch(() => { /* the lazy load at Count remains the fallback */ });
  }
```

In the `loadOpenCV().then(async () => { ... })` boot block, add `prefetchReader();` as the LAST statement (after the stash block and the final `updateRunEnabled()` — a stash resume that already loaded the model makes it a no-op via `isModelReady`, and a resume in flight shares the memoized promise).

- [ ] **Step 3: Full suite** — `PORT=8010 node tools/ci/run-suite.mjs` → `SUITE: PASS`. The walkthrough already tolerates the prefetch (its polls key on title/strip/status regexes the prefetch messages never match; the announce/complete statuses only ever render in idle state). If any step flakes on a status assertion, read the failure page state before changing anything — the fix belongs in the prefetch guards, not the walkthrough.

- [ ] **Step 4: Commit** — `git add web/src/recognize.js web/src/ui.js && git commit -m "v8.1: prefetch the reader at idle boot; live progress callback ref"`

### Task 2: Read-back-verified stores + store log (`vendorstore.js`, `sw.js`, gate)

**Files:**
- Modify: `web/src/vendorstore.js`, `tests/vendorstore.html`, `web/sw.js`

**Interfaces:**
- Produces: `idbSetMeta(name, value) -> Promise<void>`, `idbGetMeta(name) -> Promise<value|null>` (keys `meta:`-prefixed — never collide with pathname file keys); SW writes `store-log:<pathname>` = `{layer: 'cache'|'idb'|'none', when}` per vendor file store attempt. Consumed by Task 3's device-test row.

- [ ] **Step 1: Gate additions first** — in `tests/vendorstore.html` before the `finally`, using its `assertTrue`/`say` helpers:

```js
  // v8.1 meta helpers: round-trip, absence, and no collision with file keys.
  assertTrue((await idbGetMeta('nope')) === null, 'meta miss -> null');
  await idbSetMeta('store-log:/web/vendor/big.onnx', { layer: 'idb', when: 123 });
  const meta = await idbGetMeta('store-log:/web/vendor/big.onnx');
  assertTrue(!!meta && meta.layer === 'idb' && meta.when === 123, 'meta round-trip');
  await idbSetMeta('store-log:/web/vendor/big.onnx', { layer: 'cache', when: 456 });
  assertTrue((await idbGetMeta('store-log:/web/vendor/big.onnx')).when === 456, 'meta overwrite');
  assertTrue((await idbMatch('/web/vendor/big.onnx')) !== null, 'file key unaffected by meta writes');
```

Update the import line to include `idbSetMeta, idbGetMeta`. Run `PORT=8010 GATES=vendorstore node tools/ci/run-suite.mjs` → FAIL (missing exports).

- [ ] **Step 2: vendorstore.js** — append:

```js
const META_PREFIX = 'meta:';

/** Store a small metadata value (e.g. the SW's per-file store log) under a
 * meta: key — the prefix keeps these out of the pathname file-key space. */
export async function idbSetMeta(name, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ meta: value }, META_PREFIX + name);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('idb meta write failed'));
      tx.onabort = () => reject(tx.error || new Error('idb meta write aborted'));
    });
  } finally { db.close(); }
}

export async function idbGetMeta(name) {
  try {
    const db = await openDb();
    try {
      const rec = await new Promise((resolve, reject) => {
        const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(META_PREFIX + name);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error || new Error('idb meta read failed'));
      });
      return rec ? rec.meta : null;
    } finally { db.close(); }
  } catch (_) { return null; }
}
```

- [ ] **Step 3: sw.js.** Import gains `idbSetMeta, idbGet`; the vendor store's `waitUntil` body becomes (replacing the current try/catch chain inside it — the clone/contentType lines above it stay):

```js
        event.waitUntil((async () => {
          const pathname = new URL(req.url).pathname;
          const logStore = async (layer) => {
            try { await idbSetMeta('store-log:' + pathname, { layer, when: Date.now() }); } catch (_) {}
          };
          try {
            const blob = await copy.blob();
            try {
              await cache.put(req, new Response(blob, { headers: { 'Content-Type': contentType } }));
              // iOS can resolve put() without persisting — trust only a read-back.
              if (!(await cache.match(req))) throw new Error('cache read-back miss');
              await logStore('cache');
            } catch (_) {
              try {
                await idbPut(req.url, blob, contentType);
                if (!(await idbGet(req.url))) throw new Error('idb read-back miss');
                await logStore('idb');
              } catch (_) { await logStore('none'); }
            }
          } catch (_) {}
        })());
```

- [ ] **Step 4: Gates then full suite** — `PORT=8010 GATES=vendorstore,pwa node tools/ci/run-suite.mjs` → both PASS; then full → `SUITE: PASS`.

- [ ] **Step 5: Commit** — `git add web/src/vendorstore.js tests/vendorstore.html web/sw.js && git commit -m "v8.1: read-back-verified vendor stores with per-file store log"`

### Task 3: Device-test store-log display + release stamps

**Files:**
- Modify: `web/device-test.html`, then `web/index.html` + `web/src/ui.js` + `web/sw.js` (stamps)

- [ ] **Step 1: device-test.** Import gains `idbGetMeta`. In the "Reader cached?" block, after computing `cacheHit`/`inIdb`/`anyCache`, fetch the log and append it to whichever detail string renders:

```js
    const storeLog = await idbGetMeta('store-log:' + new URL(decoderPath, location.href).pathname);
    const logNote = storeLog ? ' · last store attempt: ' + storeLog.layer + ' (' + new Date(storeLog.when).toLocaleTimeString() + ')' : '';
```

and concatenate `+ logNote` onto all four branch strings of the `row('Reader cached?', ...)` detail argument.

- [ ] **Step 2: Stamps** — `web/index.html` meta `content="9"`, `web/src/ui.js` `APP_VERSION = '9'`, `web/sw.js` `CACHE_VERSION = 'v9'` (verify `VENDOR_CACHE` still `'inkcount-vendor'`, unchanged).

- [ ] **Step 3: Full suite** — `PORT=8010 node tools/ci/run-suite.mjs` → `SUITE: PASS`. Commit: `git add web/device-test.html web/index.html web/src/ui.js web/sw.js && git commit -m "v8.1 release: version 9 (reader prefetch, verified stores, store log)"`

- [ ] **Step 4 (controller): merge, deploy, verify** — final review → `git checkout main && git merge --no-ff v81-reader-prefetch && git push origin main` → Actions green → live checks (prefetch observable at idle boot, store log present after a count, stamps 9) → iPhone checklist to the user.

---

## Self-review

- Spec coverage: §2→T1, §3→T2, §4+§6→T3. Reserve lever (§5) intentionally unimplemented.
- Placeholders: none — all changed code shown; unchanged context named precisely.
- Type consistency: `idbSetMeta/idbGetMeta` names identical across T2 code, T2 gate, T3 consumer; `store-log:` key format identical in sw.js and device-test; `isModelReady` already exported by recognize.js (verified in v8).
- Sequencing: T1 and T2 independent; T3 consumes T2's meta helpers; stamps land last; suite green at each boundary.

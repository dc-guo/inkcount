# InkCount v8.1 — Reader Prefetch + Read-Back-Verified Stores (Design)

Date: 2026-08-13
Status: **Approved** (user "go"; scope proposed after the v8 iPhone retest)
Builds on: `docs/superpowers/specs/2026-08-12-v8-ios-hotfix-design.md` (whose §8
reserve levers and final review anticipated exactly these fixes)

## 1. Field evidence (v8 retest, the primary iPhone)

Read killed at line 6 → reload → **the reader re-downloaded** → resume banked
the progress and continued to line 8–9 → killed again. Diagnosis: resume works;
the model store does not stick. The background store of the ~45 MB decoder runs
concurrently with lines 1–6 of the read — exactly the memory peak that kills
the tab — so the store loses the race, every cycle re-downloads, and the
download's transfer buffers add to the very pressure causing the kills. The
crash and the cache failure feed each other.

## 2. W1 — Prefetch the reader at boot (ships the store before any read)

- After OpenCV is ready and the stash-resume block has run, `ui.js` calls a new
  `prefetchReader()`: fire-and-forget `loadModel(...)` so the download AND the
  service worker's background store complete while the page is idle (no mats,
  no inference). Count then starts from cache (~2 s init).
- Status is announced once, only when idle: "Ready — the reader is downloading
  in the background (one-time)…", restored to the normal idle status on
  completion via a new `setIdleStatus()` helper. Never overwrites an active
  photo/count status; no streaming percentages into the live region.
- `recognize.js`'s memoized `loadModel(onProgress)` currently bakes in the
  FIRST caller's callback; it becomes a mutable ref (`currentProgress`) so a
  Count pressed mid-prefetch still gets real progress UI.
- Failure is silent — the lazy load at Count remains the fallback.

## 3. W2 — Read-back-verified stores + store log

iOS can resolve `cache.put()` without durably persisting (v8's verification
only caught thrown rejections), and a store can be killed mid-write. The SW's
vendor store becomes trust-only-a-read-back:

- After `cache.put`: `cache.match(req)` must hit, else fall through to IDB.
- After `idbPut`: `idbGet(url)` must return a record, else record failure.
- Every attempt writes a per-file store log via new `vendorstore.js` meta
  helpers — `idbSetMeta(name, value)` / `idbGetMeta(name) -> value|null`,
  stored under `meta:`-prefixed keys (no collision with pathname keys) — as
  `store-log:<pathname>` = `{ layer: 'cache'|'idb'|'none', when }`.
  (Service workers have no localStorage; IDB is the SW-visible log channel.)

## 4. W3 — Device-test reports the store log

The "Reader cached?" row appends the decoder's last store attempt when a log
exists: `· last store attempt: idb (13:42:07)`. After a kill-and-reload cycle
on the phone, the report card now shows where (or whether) the store landed.

## 5. Held in reserve (unchanged from v8 §8)

Phone-reduced processing resolution — its trigger condition (post-diet retest
still dies) is met, but the download-during-read buffers must be eliminated
first; re-evaluate on the next iPhone report card.

## 6. Release

Branch `v81-reader-prefetch`; stamps move together to **9**; suite (13 gates +
25-step walkthrough) green at every commit; vendorstore gate gains meta-helper
assertions; one merge to `main`. DoD: on the iPhone — second visit shows no
download; device-test "Reader cached?" green with a logged layer; sample read
completes or resumes to completion with retries now costing seconds, not
65 MB.

# InkCount v8 — iOS Hotfix: Model Cache, Read Memory, Crash Resume (Design)

Date: 2026-08-12
Status: **Approved** (user "go", 2026-08-12; both §8 defaults stand)
Trigger: Diane's iPhone field report on v7 (iOS 18.7 / Safari 26.5, 4 cores):
(1) the ~65 MB reader re-downloads on every visit; (2) recognition dies
mid-read and the page reloads — line ~4 of 21 on a real photo, line ~6 of 16
on the **bundled sample** (small, clean image → the kill is dominated by
inference-side memory growth, not photo size); (3) a printed light-on-dark
book page was confidently counted instead of being warned about.

## 1. Goal

Make v7's features actually usable on the primary device: the model downloads
once and stays cached on iOS; a page read survives to the end (or, when iOS
kills the tab anyway, resumes where it stopped instead of losing everything);
obviously-out-of-scope photos get told, not counted.

### Non-goals

Printed-text recognition (still a Phase 2 gate); WebGPU/worker inference;
reduced processing resolution on phones (accuracy-affecting — held as a last
resort, only with fresh on-device evidence that W2+W3 are insufficient).

## 2. W1 — A model cache that survives iOS (fixes the re-download)

Two defects compound today: `sw.js` writes vendor files with a fire-and-forget
`cache.put()` (iOS Cache API rejects large writes when it feels like it — the
~45 MB decoder — and the rejection is silently unhandled), and the vendor
cache name is versioned (`inkcount-vendor-v7`), so **every release deliberately
deletes the downloaded model** (flagged in the Phase 1 final review).

- **Stable vendor cache:** rename to un-versioned `inkcount-vendor`. The
  activate handler keeps deleting stale `inkcount-shell-*` caches and now also
  legacy `inkcount-vendor-v*` caches (one final purge migrating v7 clients),
  but never the stable vendor cache. Vendor files are immutable per path —
  correctness is unaffected by releases.
- **Verified writes with an IndexedDB fallback:** new `web/src/vendorstore.js`
  (pure module, no DOM): `idbPut(url, response)` / `idbMatch(url) -> Response|null`
  storing `{blob, contentType}` in db `inkcount-vendor-idb`, store `files`,
  key = URL pathname. The SW vendor handler becomes: Cache API match → IDB
  match → network, then `await cache.put(...)` in a try/catch whose failure
  path stores to IDB instead. (iOS handles large IDB blobs far better than
  large Cache API entries.)
- **Device-test check:** a new "Reader cached?" row reports which layer holds
  the decoder (CacheStorage / IndexedDB / neither) so the next report card
  answers this without timing guesswork.
- **Gate:** `vendorstore` gate page (round-trip a multi-MB synthetic Response,
  match miss, overwrite). SW integration stays covered by the `pwa` offline
  gate (a boot from nothing still proves some layer served everything).

## 3. W2 — Read-memory diet + growth bounds (attacks the crash)

During a v7 read the page holds: the ≤2000 px photo canvas, the same-size
overlay canvas, ALL line-crop canvases, plus the wasm heap growing with every
decode step — and generation length is uncapped, so a hallucinating line can
decode far beyond its real content (the repetition-loop lines we already flag
are also memory spikes).

- **Snapshot early, drop early:** `analyzePhoto()` now produces the page thumb
  (160 px) AND the overlay JPEG (1000 px) immediately, displays the staged
  overlay as an `<img>` (no live overlay canvas retained), swaps the photo
  preview to a ~800 px `<img>`, and **drops the full-res canvas** — after
  analyze, only the line crops remain. `countCurrentPhoto()` builds the
  PageRecord from the snapshots. (Walkthrough's `analyze-on-load` assertion
  changes from canvas to img.)
- **Progressive crop release:** `recognizeLines(crops, …)` nulls `crops[i]`
  after line i is read — a 21-line read no longer holds 21 canvases at line 20.
  (Resume after a crash re-derives crops from the stashed photo, §4.)
- **Cap generation:** the pipeline call gets `{ max_new_tokens: 48 }` — a
  handwritten line is ~5–12 words; 48 tokens is far above any real line and
  far below a runaway loop. Calibration rule: all 9 fixtures + sample keep
  their exact counts (accuracy gate enforces).
- **GC breathing room:** a `setTimeout(0)` macro-task yield between lines.
- **Deferred: pre-sized crops.** Rescaling crops before the processor risks
  interpolation-level count shifts on the fixtures for a modest transient-
  memory win; it stays out of v8 unless the on-device retest still dies.

## 4. W3 — Crash forensics + resume (when iOS kills us anyway)

iOS will sometimes kill the tab no matter how lean we are. Today that loses
the photo and all progress silently ("website resets"). v8 makes a kill a
bump, not a wipeout:

- **Session stash:** at analyze time the staged photo is written to
  sessionStorage (`inkcount-stash-v1`: JPEG data-URL ~0.5 MB + name); each
  completed line appends its transcript to the stash. Cleared on read
  completion, Clear photo, New entry, or staging a different photo.
  Privacy: sessionStorage is this-tab, this-device, short-lived — nothing
  leaves the device; the photo is still never written to history.
- **Boot resume:** if a stash with reading progress exists at boot, the app
  says "Your last read was interrupted at line N of M — this device ran low
  on memory. Resuming…", restores the photo from the stash, re-analyzes
  (deterministic → same crops), and continues the read from line N reusing
  the stashed transcripts. No tap required (default; flag if you want a
  confirm). Multiple kills converge: each attempt banks its lines.
- **Device-test:** the recognition check writes a per-line breadcrumb; after
  a kill the page reports "previous run was killed at line N of M" instead of
  an eternal "Running…" (this is why we never got a finished report card).
- **Gate/walkthrough:** a walkthrough step seeds a synthetic stash (sample
  photo, 6 of 16 lines done), reloads, and asserts the read auto-completes
  with the total in the normal sample bounds — proving resume end-to-end.

## 5. W4 — Light-on-dark pre-flight warning

`analyzePhoto` already has the grayscale mat; compute the page's median
luminance. If the background is dark (median < 110), `evaluatePreflight`
gains signal `darkBackground` → warning `inverted`:
"This looks like light text on a dark background — InkCount reads dark
handwriting on light paper (photos of screens and dark-mode pages won't
count reliably)." Advisory only. Calibration: all 9 fixtures + sample are
light-background and must stay silent; the threshold is measured against
them in the preflight gate.

Printed text stays a copy-level honesty item (footer already says English
handwriting) — no detection attempted.

## 6. Release

Branch `v8-ios-hotfix`; stamps 6→… all three move together to **8** (shell
pairing only — the vendor cache no longer purges on version bumps, that's the
point of W1). New files (`vendorstore.js`) join the SHELL precache in their
creating commit. Suite (now 13 gates + extended walkthrough) green at every
commit; one merge to `main`; live + on-device verification (Diane's iPhone is
the real gate for W1/W2/W3: sample read must complete, second visit must not
re-download).

## 7. Definition of done

- Diane's iPhone: sample page reads to completion (or resumes to completion
  across kills); second visit loads the reader without re-downloading
  (device-test "Reader cached?" row green); the dark-mode book photo warns.
- Suite PASS locally + Actions; stamps at 8; no pipeline-module diffs
  (`preprocess.js` gains only the median-luminance read if placed there —
  otherwise computed in ui.js from the existing gray mat; decision at plan
  time, default: ui.js, pipeline untouched).
- Accuracy gate unchanged: identical fixture counts (token cap + crop
  pre-sizing must not shift any number; if one shifts, the change backs out).

## 8. Open defaults (flag to change, otherwise these ship)

1. **Resume is automatic** (no confirm tap) with an explanatory status line.
2. **Processing resolution stays 2000 px** everywhere; phone-reduced
   resolution is explicitly deferred unless your retest still dies post-W2/W3.

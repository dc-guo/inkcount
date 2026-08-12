# InkCount Phase 1 — Multi-Page Entries, Private History, Camera-First (Design)

Date: 2026-08-11
Status: **Approved** (design presented in-session and accepted; "explicit save"
history model chosen by the user; camera-first validated by an in-progress
green iPhone report card — iOS 18.7 / Safari 26.5, wasm OK, OpenCV 0.6 s,
reader ready 11.9 s)
Builds on: `docs/PRODUCT_PLAN.md` §4 Phase 1 · `docs/PHASE1_HANDOFF.md`

## 1. Goal

Fit the whole job: a journal entry is 2–3 pages, not one photo. Phase 1 ships
exactly three features as release **version 7**:

1. **Multi-page entries** — per-page cards with individual counts, one running
   total as the headline; the in-progress entry survives refresh.
2. **Private history** — a local-only log of past entries, written **only by an
   explicit "Save entry" action** (user decision; no auto-save).
3. **Camera-first capture** — on phones the primary path is taking the photo,
   with framing guidance and pre-flight warnings before the ~15 s read.

### Non-goals (explicitly out, user-confirmed)

Exportable result cards; count-confidence ranges; IndexedDB; `getUserMedia`
viewfinder; editing/renaming history rows; multiple concurrent draft entries;
retaining photos anywhere. The zero-backend covenant is untouched: no accounts,
no uploads, no analytics, no off-origin requests.

## 2. Data model & storage — new `web/src/store.js`

All persistence goes through `store.js` (pure data module, no DOM). Two
versioned localStorage keys:

- `inkcount-entry-v1` — the in-progress entry
- `inkcount-history-v1` — array of saved history rows, newest first

Parsing is corrupt-safe: bad JSON, wrong shape, or wrong version silently
yields the empty state — boot must never crash on stored data.

### Shapes

```js
Entry       = { id, startedAt, pages: [PageRecord] }        // id: random slug
PageRecord  = { name, count, lines, secs,
                transcript: [string], perLine: [number], lowConfidence: [bool],
                thumb,             // data-URL JPEG, long edge 160 px (~15 KB)
                overlay }          // data-URL JPEG, long edge 1000 px (~150 KB), or null
HistoryRow  = { id, savedAt, total, pageCount,
                perPageCounts: [number],
                thumb }            // first page's thumb only
```

A page enters `entry.pages` only when its count **completes**. At that moment
the full-resolution canvas, the line-crop canvases, and the live overlay canvas
are all dropped — the page lives on as small JPEGs plus numbers/strings
(~165 KB). A 3-page entry totals ~500 KB: phone-memory-safe and comfortably
inside the ~5 MB localStorage quota. Pages are numbered positionally (removing
page 2 of 3 renumbers the old page 3 to "Page 2"). An **un-counted** photo is
transient (never persisted): refreshing mid-photo loses only that photo.

History rows carry **no transcripts and no overlays** — rows stay ~15 KB.
History is capped at **50 rows**; inserting past the cap evicts the oldest.
Saving is an **upsert by entry id**: re-saving the same entry updates its row,
never duplicates it.

### API

```js
loadEntry() -> Entry            saveEntry(entry)         clearEntry()
loadHistory() -> [HistoryRow]   saveToHistory(entry) -> HistoryRow   // upsert
deleteHistoryRow(id)            clearHistory()
isEntrySaved(entry) -> bool     // history has row w/ same id + same perPageCounts
makeThumb(canvas, maxEdge, quality) -> dataURL   // shared by thumb + overlay
storageAvailable() -> bool
```

### Failure ladder

- **Entry write fails (quota):** retry with every `overlay` set to `null`
  (overlay slots for restored pages then explain storage was full); if it still
  fails, keep the entry in memory only and show a one-time gentle banner.
- **History write fails:** evict oldest rows one at a time until the write
  fits; if a single row still cannot be written, surface "Couldn't save — this
  device's storage is full."
- **localStorage entirely unavailable** (hard private mode): the app runs
  normally in-memory; "Save entry" explains that this browser is blocking
  local storage. Nothing crashes.

## 3. UI — the bento extends; nothing is rebuilt

### Input card ("Add a page" → "Add another page" once a page exists)

- Existing current-photo slot (`#image-slot`), label, and the
  "Try a sample page" button (`#btn-sample`) stay — the sample loads as the
  current photo like any other image.
- **Camera-first buttons** (§5): `#camera-input` (new) + `#file-input`.
- **Pre-flight warnings** (§4): `<ul id="preflight-warnings">`, `aria-live="polite"`.
- **Pages strip**: `<ul id="pages-strip">` of `li.page-card`, one per counted
  page — thumbnail, "Page N · 62 words", and a labeled remove button.
  Selecting a card (its main button) shows that page in the transcript and
  overlay cards; `aria-current` marks the selection. Removing the selected
  page selects its nearest neighbor.

### Hero card

- `#result-total` = **entry total** (sum of counted pages). With one page this
  equals today's single-page count — legacy walkthrough count bounds still hold.
- `#result-sub` e.g. "3 pages · 574 words". During a read, the streamed count
  is added on top of the already-counted base ("574 so far — reading line 4 of
  16 on page 3…" pattern preserved).
- Buttons: `#btn-run` (Count words, unchanged id); `#btn-reset` relabeled
  **"Clear photo"** (clears only the current un-counted photo); new
  `#btn-save-entry` ("Save entry" → disabled "Saved ✓" when
  `isEntrySaved(entry)`); new `#btn-new-entry` ("New entry", inline-confirms
  if the entry has unsaved pages).

### Boot restore

On load, `loadEntry()`/`loadHistory()` drive the initial render: a non-empty
entry re-renders the strip, totals, and the last page's transcript/overlay
(selected = last page), with the status line noting "Restored your in-progress
entry." History renders its card if any rows exist.

### History card (new, bottom of the bento)

`#history-card`, hidden when history is empty. Rows: date ("Mon, Aug 11") ·
total · per-page counts ("62 + 71 + 55") · first-page thumbnail · labeled
delete button. `#btn-clear-history` ("Clear all"). Copy, verbatim:

> Past entries stay only in this browser on this device — never uploaded.
> Photos aren't kept; just the counts and a small preview.

### Inline confirms — no native dialogs, anywhere

`confirm()`/`alert()` are banned: headless Chrome auto-dismisses them, which
would make these paths untestable by the walkthrough. Destructive actions
(remove page, New entry with unsaved pages, delete history row, clear history)
swap the trigger for an adjacent "Really? **Yes / No**" pair (`.confirm-yes` /
`.confirm-no`). Focus moves to the pair; No/Escape restores the trigger and
focus. No auto-cancel timer.

## 4. Pipeline split & pre-flight — new `web/src/preflight.js`

**No pipeline module changes.** `mats/decode/preprocess/segment/geometric/
recognize/count` are untouched; the split is a `ui.js` refactor at the existing
stage-1 seam:

- `analyzePhoto()` — runs when a photo loads (~2–3 s): stage 1 inside
  `withMats` (preprocess → segmentLines → estimateWords → overlay draw,
  including the `?debug=1` rejected-band rendering), then keeps
  `{ crops, overlayCanvas, skewAngle, textHeight, lines }` on transient photo
  state. The overlay card renders **immediately** (instant trust feedback) and
  pre-flight warnings appear.
- `countCurrentPhoto()` — the Count button: model load + `recognizeLines` over
  the cached crops (streaming, as today), then `countWords`, PageRecord
  construction, `entry.pages.push`, `saveEntry`, drop all canvases, clear the
  photo slot, auto-select the new page.

Net compute equals today's; it is just re-ordered. The 0-line early-exit moves
to load time: with `lines === 0` there are no crops, `#btn-run` stays disabled,
and the warning explains why (same terminal state as today's error, surfaced
~15 s earlier). Warnings are otherwise **advisory only** — counting is never
blocked by a heuristic.

### `evaluatePreflight(signals) -> [{ id, severity, message }]`

Pure function over `{ skewAngle, lines, textHeight }`:

| id | fires when | message gist |
|---|---|---|
| `no-lines` | `lines === 0` | No handwriting lines found — retake closer, straight on (Count disabled: nothing to read) |
| `one-line` | `lines === 1` | Only one line found — if the page has more, fill the frame with the page |
| `tilted` | `abs(skewAngle) >= 4.5` (°; estimator caps at ±6) | Page looks tilted (straightened automatically, but straight-on reads better) |
| `small-text` | `textHeight < 12` (px, post-deskew) | Writing appears small — a closer shot reads more accurately |

**Calibration rule (a gate, not a vibe):** the 9 rendered fixtures and the
bundled sample page must produce **zero warnings**. If a threshold trips a
known-good fixture, the threshold moves (documented in `preflight.js`), not the
fixture.

## 5. Camera-first capture

- New `<input type="file" id="camera-input" accept="image/*"
  capture="environment">` — on iOS/Android this opens the camera directly.
  `#file-input` keeps its current accept list (incl. `.heic`) as the
  library/file path. Both share one change handler → `loadInto` → the existing
  decoder. **No new decode path** (camera yields JPEG/HEIC like any file).
- On coarse-pointer devices (`matchMedia('(pointer: coarse)')`): "📷 Take
  photo" is the primary pill, "Choose from library" secondary, plus one line of
  framing copy: *"Fill the frame with the page — straight on, in good light."*
- On fine-pointer devices: today's single "Choose photo" primary is unchanged;
  the camera input stays in the DOM (statically assertable by CI) but hidden.
- Pre-flight (§4) is the second half of this feature: bad framing is caught in
  ~2–3 s instead of after a 15 s read.

## 6. Service worker, versions, release

- `sw.js` precache gains `src/store.js`, `src/preflight.js`, `src/history.js`
  **in the same commit that creates them** (a listed-but-missing file fails the
  whole `cache.addAll` install).
- Version stamps bump **together** 6 → **7**: `meta[name=inkcount-version]`
  (index.html), `APP_VERSION` (ui.js), `CACHE_VERSION` (sw.js).
- All Phase 1 work happens on a branch; `main` receives it as one merge (CI
  runs on `main` push only; the local suite is the pre-merge law). README
  gains multi-page + history sections and the privacy line for history.

## 7. Testing

Suite grows 10 → **12 gates** plus an extended walkthrough.

- **`store` gate** (`tests/store.html`): entry round-trip; history upsert (two
  saves of one entry → one row); delete row; clear; cap-50 eviction (55
  inserts → 50 rows, oldest gone); corrupt JSON → clean empty state; simulated
  quota failure (patched `setItem` throwing) → overlay-strip fallback and
  oldest-row eviction both exercised. Cleans up its keys in `finally`.
- **`preflight` gate** (`tests/preflight.html`): table-driven threshold cases
  incl. boundaries (4.4°/4.5°, 11/12 px, 0/1/2 lines); plus the calibration
  assertion — real stage-1 pass over the sample page yields zero warnings.
- **Walkthrough** (existing 11 steps preserved; additions sequenced so the
  legacy refresh-then-run block still starts from a fresh entry):
  1. `localStorage` cleared up front — gates and the walkthrough share one
     origin, so the `store` gate must clean up after itself AND the
     walkthrough must start clean (hard-won-gotcha class: cross-gate
     localStorage bleed).
  2. Count sample → 1 page card in `#pages-strip`, hero total 170–200.
  3. Count sample again → 2 cards, per-page counts each 170–200, hero total
     340–400.
  4. Select page 1 → transcript shows page 1's 16 lines.
  5. Remove page 2 via inline confirm → 1 card, total back to 170–200.
  6. Save entry → `#history-card` visible, exactly 1 row; save again → still 1
     row (upsert); button reads "Saved ✓".
  7. **Real reload** → entry restored (1 card, same total) and history intact
     (1 row) — persistence proven through an actual navigation.
  8. New entry → strip empty, total "—", history still 1 row.
  9. Delete the history row via inline confirm → history card hidden.
  10. `#camera-input[capture="environment"]` present; `#preflight-warnings`
      empty after a sample load (zero warnings on known-good input).
- **Changed legacy assertion:** counted pages render their overlay as a
  persisted JPEG `<img>` (the live canvas is dropped for memory); the
  walkthrough's overlay check becomes "exactly one canvas **or** img in
  `#overlay-slot`" (canvas while a photo is staged, img for counted pages).
- **a11y gate** now audits the new markup: labeled remove/delete buttons
  ("Remove page 2, 71 words" / "Delete entry from Aug 11, 574 words"), list
  semantics for strip and history, `aria-current` selection, live regions,
  focus management in inline confirms — axe stays clean at critical/serious.
- Unchanged gates keep protecting the untouched pipeline (`accuracy`,
  `segment`, `decode`, …): the split must not alter any counted number.

## 8. Definition of done (from the handoff, made concrete)

- Three features working as specified; suite 12 gates + extended walkthrough
  **PASS locally and on GitHub Actions**; live walkthrough PASS after deploy.
- Version stamps at 7; README updated (multi-page, history, privacy line).
- Covenant clean: zero off-origin requests (existing audit step enforces).
- No pipeline module diffs (`git diff` on preprocess/segment/geometric/
  recognize/count/decode/mats is empty).

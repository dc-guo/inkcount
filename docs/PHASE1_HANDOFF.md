# Phase 1 Handoff — InkCount

For a fresh Claude Code session. Read this fully, then start work.
Everything here is current as of 2026-08-08, commit `05c39b9`.

## Kickoff prompt (paste this into the new chat)

```text
Read docs/PHASE1_HANDOFF.md and start work on Phase 1.
```

---

## 1. What InkCount is

A Beta web app that counts handwritten words from a photo, entirely on the
user's device. Live at <https://dc-guo.github.io/inkcount/>, repo
`dc-guo/inkcount`, deployed from `web/` by GitHub Pages.

- Pipeline: decode (JPG/PNG/WebP/HEIC) → deskew/de-rule (OpenCV.js 4.9) →
  line segmentation → on-device recognition (TrOCR-small via transformers.js,
  ~80 MB vendored) → word count + per-line transcript.
- Primary user: a student checking a handwritten lecture journal against a
  word requirement, on a phone.
- Accuracy: CI-bounded ≤5% mean / ≤10% worst on 9 rendered fixtures
  (measured ~1–2%); one photographed real page validated.
- It is a PWA: installable, offline after first visit, versioned caches.

**Local folder:** `C:\Users\diane\dev\countWithMe` — unless the user has run
`C:\Users\diane\dev\rename-to-inkcount.bat`, in which case it is
`C:\Users\diane\dev\inkcount`. Same repo either way; check where you are.

## 2. The covenant (non-negotiable)

Zero backend. No accounts, no uploads, no analytics, no third-party runtime
requests — every asset ships from our own origin, and the CI suite fails the
build if the app makes any external request. All costs stay $0.

## 3. Phase 1 scope — exactly three features

Approved by the user ("that's it" — result cards and confidence ranges are
explicitly OUT of Phase 1):

1. **Multi-page entries.** A journal entry is often 2–3 pages. "Add another
   page" → per-page cards with individual counts, one running total as the
   headline number. The in-progress entry survives a refresh (localStorage).
   Per-page transcript/overlay still reachable.
2. **Private history.** Local-only log of past entries: date, count,
   per-page counts, small thumbnail. Clearable (one tap, with confirm).
   Copy must state it never leaves the device. localStorage/IndexedDB —
   thumbnails are small; the photos themselves are NOT retained.
3. **Camera-first capture.** On phones, taking the photo should be the
   primary path: `capture` attribute / camera flow, framing guidance
   ("fill the frame with the page"), and pre-flight warnings BEFORE the
   ~15 s read using the already-computed signals (skew estimate, text
   height, line count — e.g. warn if 0–1 lines or extreme skew found by the
   fast geometric pass).

Process: brainstorm → spec (`docs/superpowers/specs/`) → plan
(`docs/superpowers/plans/`) → implement with gates green → ship. The user
approves the spec before implementation.

## 4. How to verify and ship (the law of this repo)

```bash
node tools/ci/run-suite.mjs
```

runs 10 gates (smoke, assets, count, decode, preprocess, segment, recognize,
accuracy, a11y, pwa) + an 11-step UI walkthrough in headless Chrome.
**SUITE: PASS or it does not ship.** Pushing to `main` runs the same suite on
GitHub Actions (`test` job) and a red gate blocks the deploy.

Release ritual — bump **all three together** or cached browsers break:
- `web/index.html` → `<meta name="inkcount-version">`
- `web/src/ui.js` → `APP_VERSION`
- `web/sw.js` → `CACHE_VERSION`
(Currently all `6`. Phase 1 ships as `7`.)

New files under `web/` that the app needs offline must be added to the
service-worker precache list in `web/sw.js` — and they must exist, or
`cache.addAll` fails the whole install.

## 5. Hard-won gotchas (each cost real debugging — do not relearn)

- **CDP/harness rules** are written as comments at the top of
  `tools/ci/run-suite.mjs`. Core ones: never `Runtime.evaluate` while a page
  runs the monolithic opencv.js eval (title-poll via `/json/list` instead);
  Page-only CDP sessions; `const` in evaluate persists globally → wrap in
  IIFEs; after `Page.navigate` the OLD title is still reported briefly —
  readiness = `performance.timeOrigin` changed AND title ends " — Ready".
- **opencv.js is a self-resolving thenable** — `await cv` never settles.
  `web/src/mats.js` handles it; don't touch that loader.
- **transformers.js local-only quirks** are documented in
  `web/src/recognize.js` and `tools/build_transformers_bundle.md` (incl. the
  GitHub push-protection false positive on `Mistral3ForConditionalGeneration`
  — the bundle splits that string; keep the post-step if rebundling).
- **PowerShell 5.1:** `$env:X = ""` DELETES the variable (use `none`
  sentinels); embedded double quotes break `git commit -m` → write the
  message to a file and use `git commit -F`.
- **`server.close()`** hangs on keep-alive sockets — `closeAllConnections()`
  first (already in the suite; remember if writing new harness code).
- **Segmentation guards are balanced against opposing fixtures**: real loose
  handwriting (fixture 09, must find 4 lines/31 words) vs a no-text
  illustration (fixture 08, must be exactly 0). If you touch
  `web/src/segment.js`, both gates will hold you honest — use the app's
  `?debug=1` mode (draws rejected bands in red with reasons) before tuning.
- **A word = whitespace token containing a letter or digit** ("Wow!" is one
  word, a lone "&" is none). Hallucinated lines (letter spam, repetition
  loops) are flagged AND excluded from the total.

## 6. Where knowledge lives

- `docs/PRODUCT_PLAN.md` — the approved strategy; Phase 1 details in §4.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — prior specs/plans
  (v2 design, Phase 0) showing the expected shape and rigor.
- `docs/CONTRIBUTING_FIXTURES.md` — real-page intake rules.
- `tools/ci/report.json` — written by every suite run (gitignored).
- Claude's project memory (auto-loads) carries the same gotchas in short form.

## 7. Outstanding user-side items (ask, don't block)

- iPhone/Android run of <https://dc-guo.github.io/inkcount/device-test.html>
  — screenshot of the report card (closes the device matrix; also the first
  real HEIC test). **Camera-first capture work should ideally wait for the
  iPhone report card**, since it validates the exact path being built.
- Real handwriting photos + hand counts for the fixture set.

## 8. Definition of done for Phase 1

- All three features working, spec'd, and covered by new/updated gates
  (multi-page and history need UI-walkthrough steps; camera capture needs at
  least a decode-path test — the camera itself can't run headless).
- Full suite PASS locally and on GitHub Actions; live walkthrough PASS.
- Version stamps at 7; README updated for multi-page + history.
- No covenant violations: nothing leaves the device, including history.

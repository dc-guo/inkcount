# InkCount — Product Assessment & Growth Plan

Status: **Draft for management review** · Author: Product (PM/SE/UX) · Date: 2026-08-07
Product: <https://dc-guo.github.io/inkcount/> · Repo: `dc-guo/inkcount`

---

## 1. What InkCount is today (honest assessment)

A single-page web tool that counts handwritten words from a photo, entirely on
the user's device. Built for one job: a student with a lecture-journal word
requirement photographs their page and gets a number they can act on.

### Scorecard

| Dimension | State | Evidence |
|---|---|---|
| Core accuracy | **Strong** | 0.9% mean error / 3.2% worst on the 9-fixture suite; cursive exact; validated on one real photo ("close enough" — the user) |
| Trust surfaces | **Strong** | Per-line transcript with word counts, flagged unreadable lines excluded from totals, detected-lines overlay, `?debug=1` diagnostics |
| Privacy/cost | **Best-in-class** | Zero requests off-origin (verified per release); no backend; $0 to run and $0 per use |
| Speed | **Adequate** | 10–20 s per page after a one-time ~80 MB model download; instant on repeat visits |
| Platform coverage | **Unproven where it matters** | Verified only in desktop Chrome (automated). iPhone/Android — the actual student device — never tested; HEIC path untested with a real iPhone file |
| Multi-page reality | **Gap** | Journals routinely run 2–3 pages; users must run pages one at a time and add totals by hand |
| Record keeping | **Absent** | No history; nothing to show a teacher a week later |
| Engineering safety | **Half-done** | Strong 9-fixture regression suite + browser harness exist, but live outside the repo with no CI — `main` is protected only by discipline |
| Accessibility | **Unaudited** | Canvas-heavy UI, no screen-reader pass, pastel palette contrast unchecked |
| Positioning | **Undersold** | Still labeled "Proof of concept" while measurably working; README speaks to developers, not students or teachers |

### What this week proved about process

Every shipped defect that mattered was found by a real user with a real input
in minutes, and each fix landed as a permanent regression fixture. The
product's quality engine is: **real inputs in → fixtures out**. The plan below
leans into that instead of speculative features.

---

## 2. Users and the job to be done

**Primary:** students with recurring handwritten-journal requirements
(~200 words/entry). JTBD: *"Before I hand this in, tell me if I've written
enough — without retyping anything or uploading my private journal
anywhere."*

**Secondary (validate before building for them):** instructors spot-checking
submissions; longhand writers tracking drafts.

The privacy stance is not a technical detail — it is the moat. A student's
journal is personal writing; "nothing leaves your device" is the reason to
choose InkCount over pointing a cloud OCR app at it.

---

## 3. Strategy

Three pillars, in order:

1. **Be dependable where students actually are** — a phone, often iOS, often
   on mobile data. Nothing else matters if the iPhone experience fails.
2. **Fit the whole job** — a journal entry, not a single photo. Multi-page
   totals and a lightweight record close the loop.
3. **Earn the trust claim** — replace "proof of concept" with evidence:
   real-handwriting test set, CI on every change, accessibility, honest
   accuracy copy.

Standing constraint (recommend reaffirming): **the zero-backend covenant.**
No accounts, no uploads, no analytics beacons. Every feature below fits
inside it; the two that wouldn't are listed as explicit decisions, not plans.

---

## 4. Roadmap

### Phase 0 — Dependable (target: ~2 weeks of focused work)

| Item | Why | Success looks like |
|---|---|---|
| Real-device validation matrix (iPhone Safari, Android Chrome, iPad) | The product has never run where its user lives; HEIC, wasm memory (~80 MB model on older iPhones), and camera capture are all unproven | A page photographed on an iPhone counts correctly end-to-end; failures fixed or honestly documented |
| PWA: installable, offline-first, versioned caching | 80 MB re-downloads and cache eviction are the mobile deal-breakers; service-worker versioning also replaces today's manual version-stamp ritual (which shipped one real crash) | Second visit works in airplane mode; updates apply cleanly without the Ctrl+Shift+R folklore |
| CI: move the browser test harness into the repo, run all gates on every push via GitHub Actions | The 9-gate suite caught two bad "fixes" this week but only runs when remembered; `main` deploys straight to users | A red gate blocks deploy; the suite is a public quality artifact |
| Real-handwriting fixture set (5–10 volunteer pages with hand counts) | All accuracy claims rest on rendered fonts plus one photo; each real page this week found a new bug | Suite includes real pages; accuracy table reports synthetic and real separately |
| Accessibility pass (keyboard flow, ARIA on dynamic regions, alt text for overlays, contrast check on the pastel tokens) | Students include screen-reader and keyboard users; canvas-heavy UI is currently opaque to them | Keyboard-only run works; axe-core clean; contrast AA |
| Drop "Proof of concept" → "Beta", rewrite landing copy for students | The label now undersells a measured product; copy should answer "can I trust this number?" in one screen | New header, one-paragraph how-it-works, honest accuracy statement |

### Phase 1 — Fit the job (target: +3–4 weeks)

| Item | Why | Shape |
|---|---|---|
| Multi-page entries | The defining workflow gap; journals are 2–3 pages | "Add another page" → per-page cards, one running total; session survives refresh via localStorage |
| Private history | "What did I submit last week?" has no answer today | Local-only log: date, thumbnail, count, per-page counts; clearable; explicitly never leaves the device |
| Exportable result card | The number's consumer is often a teacher | One-tap image/PDF: count, date, page thumbnails, per-line counts — something a student can attach or show |
| Camera-first mobile flow | Reduce the retake loop that burns 20 s per attempt | Capture button with framing guidance (fill the frame, avoid steep tilt); pre-flight warnings from the existing skew/text-height estimators before the 15-second read |
| Count-confidence framing | A count of 196 against a 200 minimum needs honesty | Surface flagged/uncertain lines as a range ("192–199"), not false precision; copy tested with the primary user |
| Miscount feedback loop (privacy-safe) | The quality engine needs inputs after launch | "Report a miscount" prefills a GitHub issue; attaching the photo stays a deliberate user choice — no automatic capture |

### Phase 2 — Faster and broader (target: exploratory, gated)

| Item | Gate to start |
|---|---|
| WebGPU + worker inference (goal: <5 s/page; UI never blocks) | P0 device matrix shows where WebGPU is available to our users |
| Optional higher-accuracy model tier (TrOCR-base, larger download, user-chosen) | Real-page fixture set shows where trocr-small actually fails |
| Additional languages (separate models per language) | Demonstrated demand; each language is a model + fixture set, not a toggle |
| Printed-text mode (typed notes, whiteboards) | Distinct segmentation profile; only if users keep trying it (today it's deliberately rejected) |

---

## 5. Measurement (within the no-analytics covenant)

No telemetry. Progress is measured by: the real-page fixture accuracy table
(published in the README each release); CI pass rate on `main`; GitHub
issues/stars as the demand and defect channel; and scheduled hands-on tests
on the device matrix. If management wants usage data, that is a covenant
decision (see §7), not a default.

## 6. Risks

| Risk | Exposure | Mitigation |
|---|---|---|
| iOS Safari can't run the 80 MB model on older devices | Primary-user platform | P0 matrix first; fallback copy ("use a laptop"); evaluate smaller quantization |
| Browser evicts the cached model → repeat 80 MB downloads on data | Mobile retention | PWA persistent storage request; clear download messaging |
| Real handwriting is worse than the one good photo suggests | Accuracy claims | Real fixture set before any accuracy marketing; publish both numbers |
| Single-maintainer bus factor | Everything | CI in-repo, docs current (already strong), fixtures reproducible |
| Scope temptation (teacher dashboards, accounts) | Privacy moat | §7 makes these explicit decisions with named costs |

## 7. Decisions requested from management

1. **Approve Phase 0 scope** as the next block of work (order within it is
   flexible; device matrix first is strongly recommended).
2. **Reaffirm the zero-backend covenant** — explicitly deferring: shareable
   result links and any teacher/class dashboard (both require a server,
   per-use cost, and a privacy-story rewrite). Revisit only with evidence of
   pull.
3. **Bless the "Beta" relabel** and the accuracy copy that comes with it
   (synthetic and real numbers stated separately).
4. **Device access for the matrix**: borrowed physical devices (free) vs. a
   BrowserStack-class subscription (~$40/mo) — recommend starting free with
   the devices already in reach.
5. **Model-tier spike (Phase 2)**: pre-approve a timeboxed evaluation of
   TrOCR-base (accuracy vs. ~3× download) so it can start the moment real
   fixtures expose small-model limits.

## 8. Explicit non-goals

Accounts and sign-in; storing student work off-device; grading or
authenticity judgments ("did a human write this") — InkCount counts, it does
not police; cloud OCR fallbacks; ads or paid tiers while the covenant stands.

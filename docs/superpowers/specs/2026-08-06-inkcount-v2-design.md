# InkCount v2 — Accurate Handwritten Word Counting (Design)

Date: 2026-08-06
Status: **Awaiting user review**
Supersedes: the geometric-parity design in `docs/MIGRATION_PLAN.md`

## 1. Goal

Given a photo or screenshot of a handwritten page, report **how many words are on it** — accurately enough to be trusted by a student checking a lecture journal against a word requirement (typically ~200 words).

There is **no target, threshold, or pass/fail** in the product. InkCount reports a number.

### Non-goals

- Transcribing notes for reading or export (the transcript exists only so the user can sanity-check the count).
- Grading, storage, accounts, history, or sync.
- Languages other than English (the chosen model is English-only).
- Multi-page documents in one run.

## 2. Why v2 exists — measured failure of v1

v1 counts *clusters of ink* using horizontal projection. Seven notebook pages were generated with exact ground truth (189 words each; handwriting fonts, ruled lines, camera skew, shadows, tight spacing) and run through the shipped algorithm:

| Page condition | v1 counted | v1 error |
|---|---|---|
| Flat, well-spaced | 186 | −1.6% |
| Ruled notebook lines | 174 | −7.9% |
| Tilted 3.5° | **3** | **−98.4%** |
| Uneven lighting | 186 | −1.6% |
| Tight line spacing | **3** | **−98.4%** |
| Cursive-style script | 160 | −15.3% |
| Ruled + tilt + shadow | **1** | **−99.5%** |

**Mean absolute error: 46.1%.**

Root cause: line detection sums ink along perfectly horizontal rows. A few degrees of tilt — unavoidable in a handheld photo — smears the projection until no valleys remain, so the entire page collapses into one "line" and the word splitter cannot recover. Tight line spacing fails the same way. v1 only works on flat, generously spaced, perfectly aligned images, which is exactly what its two demo samples are.

A second, permanent ceiling: measuring gaps between ink cannot distinguish one long cursive word from three joined ones. Even perfectly tuned, geometry caps out near ±10%.

## 3. Approach, validated by spike

Straighten the page, segment real text lines, then **read each line with an on-device handwriting recognition model** and count words in the transcript. Word counting is far more forgiving than transcription: misreading "brown" as "brawn" costs nothing, only word boundaries matter.

Measured end-to-end on the same seven pages (`Xenova/trocr-small-handwritten`, q8, via transformers.js):

| Page condition | v1 error | v2 error |
|---|---|---|
| Flat, well-spaced | −1.6% | −1.1% |
| Ruled notebook lines | −7.9% | −3.2% |
| Tilted 3.5° | −98.4% | −1.6% |
| Uneven lighting | −1.6% | −2.6% |
| Tight line spacing | −98.4% | −0.5% |
| Cursive-style script | −15.3% | **0.0%** |
| Ruled + tilt + shadow | −99.5% | +6.3% |

**Mean absolute error: 46.1% → 2.2%.** Speed: **~70 ms per line, ~1.2 s per page**. Model on disk: **68 MB**, downloaded once and cached.

Two findings that shaped the design:

- **Order matters.** Removing ruled lines before deskewing leaves fragments (rules are not horizontal on a tilted page) that masquerade as text lines — 25 phantom bands instead of 15, and the model hallucinates text on the junk crops (+61.9%). Deskew first, then de-rule, then discard low-ink bands: +6.3%.
- **Segmentation is now the bottleneck, not recognition.** Every remaining error traces to line cropping, not to misread words.

## 4. Architecture

All processing is client-side. Nothing is uploaded; the model is served from our own origin.

```
photo ──▶ decode ──▶ preprocess ──▶ segment ──▶ recognize ──▶ count ──▶ UI
         (HEIC/    (deskew,       (line       (TrOCR per   (tokens)
          JPEG/     de-rule,       bands,      line)
          PNG)      binarize)      crops)
```

### 4.1 Module boundaries

`web/app.js` today is a single ~600-line file mixing loader, pipeline, and DOM. Adding recognition would make it unmanageable, so it splits into focused modules under `web/src/`:

| Module | Responsibility | Depends on |
|---|---|---|
| `decode.js` | File/Blob → `HTMLCanvasElement`. HEIC detection and decode. | libheif-wasm |
| `preprocess.js` | Canvas → `{ grayDeskewed, binaryDeskewed, textHeight, skewAngle }` | OpenCV.js |
| `segment.js` | Preprocess output → array of line crop canvases + their page rectangles | OpenCV.js |
| `recognize.js` | Line crops → transcripts, with load/progress callbacks | transformers.js |
| `count.js` | Transcripts → `{ total, perLine, lowConfidenceLines }` | none (pure) |
| `geometric.js` | v1-style fast estimate, used only for the instant pre-count | OpenCV.js |
| `ui.js` | DOM wiring, rendering, progress, error surfaces | all of the above |
| `app.js` | Thin entry point: boot, wire modules, guard on `#app` | `ui.js` |

Each module is a plain ES module exporting pure-ish functions, so each is testable in isolation from a Node or browser harness.

### 4.2 Pipeline detail

Parameters below are the ones validated in the spike; they are the starting point, subject to recalibration against real photographs (§7).

**Decode.** Accept `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`. Detect HEIC by magic bytes (`ftyp` brand `heic`/`heix`/`mif1`) rather than trusting the extension or MIME type, since browsers frequently report an empty type for `.heic`. Decode HEIC via bundled libheif-wasm to RGBA, then draw to canvas. Downscale so the long edge is at most 2000 px.

**Preprocess.**
1. Grayscale, then CLAHE (`clipLimit 2.0`, `tileGridSize 8×8`).
2. Gaussian blur 5×5, adaptive threshold (Gaussian, inverted, `blockSize 31`, `C 15`) → binary ink mask.
3. **Estimate skew**: downscale mask ×0.35; for each angle in −6°…+6° step 0.25°, rotate and compute the variance of the horizontal projection; keep the angle maximizing variance (text lines produce the sharpest peaks and valleys when horizontal).
4. **Deskew** both the binary mask and the grayscale image by that angle if `|angle| > 0.1°`.
5. **Remove ruled lines**: morphological open with a `(max(30, width/12), 1)` horizontal kernel and a `(1, max(30, height/12))` vertical kernel; dilate the union by 3×3; subtract from the mask. Runs *after* deskew so rules are truly axis-aligned.
6. **Estimate text height**: median height of connected components with height in `[3, 0.1×imageHeight]` and area ≥ 12. This is the scale every later threshold is expressed in.

**Segment.**
1. Horizontal projection of the mask, smoothed with a box kernel of `max(3, round(textHeight×0.6) | 1)` — scaled to the handwriting, not to the image.
2. Bands where the smoothed projection exceeds `max(0.10 × peak, 255×3)`.
3. Drop bands shorter than `0.55 × textHeight`.
4. Drop bands whose ink area is below `0.9 × textHeight²` (phantom bands from residual rules/noise — this is what the model hallucinates on).
5. Horizontal extent: first to last non-empty column of the whole mask, ±10 px, so crops are not full page width.
6. Crop from the **deskewed grayscale** with vertical padding `0.45 × textHeight`.

**Recognize.** `Xenova/trocr-small-handwritten`, `dtype: 'q8'`, vendored under `web/vendor/models/`. Load lazily on first analysis, not at page load. Run lines sequentially, emitting progress after each. Prefer WebGPU when `navigator.gpu` exists, falling back to WASM (WASM alone already meets the latency budget, so WebGPU is an optimization, not a requirement).

**Count.** Split each transcript on whitespace, discard empty tokens. Total = sum across lines. Mark a line **low-confidence** when its transcript is degenerate — ≥5 tokens where the majority are single characters (the `a b c d e f g h i` hallucination signature), or an empty transcript from a non-empty crop. Low-confidence lines still contribute to the count but are visibly flagged, so the user can spot inflation rather than being silently misled.

### 4.3 Two-stage result

First visit needs a 68 MB download, so:

1. On analyze, immediately run `geometric.js` (<1 s, no download) and show the number **explicitly labelled a rough estimate**.
2. Start/continue the model download with a progress bar.
3. When ready, run recognition and **replace** the estimate with the accurate count, dropping the "estimate" labelling.

The model is cached by the browser, so subsequent visits skip straight to step 3. The geometric path doubles as the fallback if the model fails to load, in which case the count stays labelled as an estimate and an explanatory message appears.

## 5. UI

Single page, same visual language as today. Top to bottom:

1. Header: InkCount, "Proof of concept" badge removed once real-photo validation passes (§7); privacy line stating image *and* model stay on the device.
2. Input: drop zone, file picker (`accept` including `.heic`), and camera capture on mobile.
3. Analyze button, status line, progress bar (distinguishing "downloading model 42%" from "reading line 12 of 18").
4. **Result: the word count**, large and alone. No target, no pass/fail.
5. "What InkCount read" — collapsible, per line: the transcript, its word count, and a low-confidence marker where applicable. This is how a user decides whether to trust the number.
6. Detected-lines overlay on the image (green boxes on the deskewed page), collapsible.
7. Footer: limitations, English-only, model/version credits.

Errors surface in the existing banner: unreadable file, unsupported format, HEIC decode failure, model download failure, zero lines detected.

## 6. Repository changes

```
web/
├── index.html          # rewritten body: no target input, no pass/fail
├── styles.css          # extended
├── app.js              # thin entry point
├── src/                # NEW modules (§4.1)
├── vendor/
│   ├── opencv.js       # unchanged, 4.9.0
│   ├── transformers/   # NEW transformers.js bundle
│   ├── libheif/        # NEW HEIC decoder
│   └── models/         # NEW TrOCR-small-handwritten q8 (~68 MB)
└── samples/            # replaced with realistic pages (§7)
tests/
├── fixtures/           # 7 ground-truth pages + expected counts
└── accuracy.html       # NEW regression page asserting error bounds
```

**Python.** `app.py` and `cv_utils.py` stop being the reference implementation — the browser algorithm is deliberately different and better. They stay in the repo, relabelled as the v1 prototype in the README. Parity tests (`tests/parity.html`, `tests/fixtures/reference.json`) are retired; `tests/math.html` and `tests/smoke.html` remain useful.

## 7. Testing

- **Accuracy regression suite.** The seven ground-truth pages are committed with their true word counts. `tests/accuracy.html` runs the full pipeline over each and asserts mean absolute error ≤ 8% and worst-case ≤ 15%. The existing headless-Chrome harness runs it and fails the build on regression.
- **Real-photo validation (required before declaring done).** Synthetic pages use handwriting *fonts*, which are more uniform than real handwriting; the 2.2% figure is therefore optimistic. At least three photographs of genuine handwritten pages, with hand-counted true totals, must be added to the suite and the thresholds re-tuned against them. Until then, accuracy claims stay caveated.
- **Unit-level.** `count.js` is pure and gets direct tests including the degenerate-output guard. `segment.js` is checked against known line counts per fixture.
- **Manual sweep.** HEIC upload from an iPhone, camera capture on mobile, slow-connection first visit, model-load failure, and a photo with no handwriting at all.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Real handwriting is harder than fonts; accuracy could be materially worse | Real-photo validation gate (§7) before removing caveats; thresholds re-tuned on real data |
| 68 MB is heavy on mobile data | One-time and cached; instant geometric estimate meanwhile; download is explicit and progress-tracked |
| Model hallucinates on junk crops, inflating counts | Low-ink band rejection plus degenerate-output detection; flagged lines visible to the user |
| Segmentation is now the accuracy bottleneck | Line count per fixture asserted in tests; overlay lets users see mis-segmentation directly |
| English-only model | Stated in the UI and README; other languages are out of scope |
| Repo grows by ~70 MB | Well within GitHub limits; documented in README for anyone cloning |

## 9. Out of scope

Multi-page runs, editing or exporting the transcript, accounts or history, non-English handwriting, and any backend or cloud service.

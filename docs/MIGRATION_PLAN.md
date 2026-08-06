# Migration Plan — Python/Streamlit POC → Client-Side Web App (GitHub Pages)

Date: 2026-08-05
Status: **Awaiting approval** (no web code written yet)
Source spec: `GITHUB_ONLY_HANDOFF.md` (user-provided handoff)

## 1. Scope and ground rules

- Port the handwritten word counter POC to a fully static site: HTML + CSS + vanilla JS + OpenCV.js, hosted on GitHub Pages.
- No backend, no Python runtime, no database, no external API, no API keys, no React. All image processing happens in the visitor's browser.
- Port the **actual** OpenCV parameters and math from `cv_utils.py`. Do not invent a different counting algorithm. Preserve current POC limitations.
- Python files stay untouched; they remain in the repo as the reference implementation.
- New site lives in `web/`, using relative paths that work under the project Pages URL (shipped as <https://dc-guo.github.io/inkcount/>).

## 2. What the current app actually does (audit)

The counting pipeline lives in `cv_utils.py` and is driven by `app.py` (Streamlit). It has four stages.

### Stage 0 — Load and resize
- `cv2.imread` (BGR). If width > 2000: resize to width 2000, height `int(h * 2000/w)`, `INTER_AREA`.
- `app.py` performs the *same* resize separately on the original color image (`cv_orig_rgb`, converted BGR→RGB) which is used for previews **and as the source of line crops in Stage 3**.

### Stage 1 — Preprocess (`preprocess_image`) — feeds Stage 2 only
1. Grayscale: `cvtColor(BGR2GRAY)`
2. CLAHE: `clipLimit=2.0, tileGridSize=(8,8)`
3. Unsharp mask: `GaussianBlur(ksize=(9,9), sigma=10.0)` then `addWeighted(enhanced, 1.5, blur, -0.5, 0)`

### Stage 2 — Line segmentation (`extract_line_bounding_boxes`)
1. `GaussianBlur (5,5), sigma 0`
2. `adaptiveThreshold(maxValue=255, ADAPTIVE_THRESH_GAUSSIAN_C, THRESH_BINARY_INV, blockSize=31, C=15)`
3. **Debug-only contour engine** (red fragment boxes + global x-margins):
   - kernel `MORPH_RECT`, size `(max(10, int(w*0.05)), max(2, int(h*0.002)))`, `dilate` ×2 iterations
   - `findContours(RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)` → `boundingRect`
   - keep boxes with `w ≥ max(10, int(imgW*0.005))` and `h ≥ max(3, int(imgH*0.001))`, sorted by y
4. **Actual line detector — horizontal projection** (on the *un-dilated* threshold):
   - `h_proj = np.sum(thresh, axis=1)` (per-row ink sum)
   - smooth: `np.convolve(h_proj, ones(k)/k, mode='same')`, `k = max(5, int(imgH*0.015))`
   - `noise_thresh = max(max(smoothed)*0.05, 255*5)`
   - scan rows for contiguous runs above threshold → peaks `(start, end)`
   - global x-range from the debug contour boxes (fallback `5 .. imgW-5`)
   - drop peaks with height `< max(15, int(imgH*0.005))`
   - `original_bands` = unpadded peaks; `merged_boxes` = peaks padded vertically by `pad_y = max(4, int(peakH*0.15))` (clamped to y ≥ 0; height = peakH + 2·pad_y, *not* clamped to image bottom)

### Stage 3 — Word clusters per line (`extract_word_clusters`)
Input: crop of the **resized original RGB image** (not the preprocessed one), clamped to image bounds.
1. `cvtColor(BGR2GRAY)` — **note: applied to RGB data**, see quirk Q1
2. `GaussianBlur (5,5), sigma 0`
3. `adaptiveThreshold(255, GAUSSIAN_C, BINARY_INV, blockSize=21, C=10)`
4. kernel `MORPH_RECT (max(6, int(cropW*0.008)), max(2, int(cropH*0.06)))`, `dilate` ×1
5. `findContours(RETR_EXTERNAL)` → `boundingRect`; keep `w ≥ max(4, int(cropH*0.1))`, `h ≥ max(4, int(cropH*0.15))`
6. Wide-box splitting: if `boxW > cropW*0.25`, take the box's ROI in the *threshold* image, compute the vertical projection `np.sum(roi, axis=0)`, find zero-columns gaps with width `≥ max(3, int(cropW*0.003))`, split at each gap center (`gap_start + gapW//2`); keep sub-boxes with width ≥ min width, else keep the whole box
7. Sort boxes by x. **Word count for the line = number of boxes.**

### Stage 4 — Total and verdict
- Total = sum of per-line box counts. PASS if total ≥ target (UI default 31, min 1, step 10).

### Unused code (will NOT be ported, stays in repo untouched)
- `ocr_utils.py` — TrOCR deep-learning OCR; **not imported by `app.py`**. Legacy.
- `config.json` — Tesseract path; unused by the current app.
- `generate_samples.py`, `INSTALL_DEMO.bat`, `RUN_DEMO.bat`, `run_app.py`, `BUILD_WINDOWS.md`, `PACKAGE_NOTES.md` — dev/packaging helpers.
- `app.py`'s inline sample generator (PIL default font) — the web app bundles the two pre-generated files in `samples/` instead (`demo_meeting.jpg`, `demo_lecture.jpg`; synthetic, safe to publish).

## 3. Operation-by-operation mapping

| Python (exact call) | OpenCV.js / JS equivalent | Parity |
|---|---|---|
| `cv2.imread(path)` → BGR | `File`/`Image` → `<canvas>` → `cv.imread(canvas)` → RGBA | Adapted (see §4.1) |
| `cv2.resize(img, (2000, int(h*ratio)), INTER_AREA)` | `cv.resize(src, dst, new cv.Size(2000, Math.trunc(h*ratio)), 0, 0, cv.INTER_AREA)` | Exact |
| `cv2.cvtColor(BGR2GRAY)` on true BGR (Stage 1) | `cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)` | Exact (same fixed-point coefficients on the same true channels) |
| `cv2.cvtColor(BGR2GRAY)` on RGB data (Stage 3, quirk Q1) | `cv.cvtColor(rgbaCrop, gray, cv.COLOR_BGRA2GRAY)` — reproduces the swapped weights bit-for-bit | Exact, quirk preserved |
| `cv2.createCLAHE(2.0, (8,8))` | `new cv.CLAHE(2.0, new cv.Size(8,8))` + `.apply()` | Exact — availability in the official opencv.js build verified in the first smoke test; fallback in §4.6 |
| `cv2.GaussianBlur((9,9), 10.0)` / `((5,5), 0)` | `cv.GaussianBlur(src, dst, ksize, sigma)` | Exact |
| `cv2.addWeighted(a, 1.5, b, -0.5, 0)` | `cv.addWeighted(...)` (saturating uint8) | Exact |
| `cv2.adaptiveThreshold(255, GAUSSIAN_C, BINARY_INV, 31, 15)` and `(21, 10)` | `cv.adaptiveThreshold(...)` same constants | Exact |
| `cv2.getStructuringElement(MORPH_RECT, (w,h))` | `cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(w,h))` | Exact |
| `cv2.dilate(img, kernel, iterations=n)` | `cv.dilate(src, dst, kernel, new cv.Point(-1,-1), n, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue())` | Exact |
| `cv2.findContours(RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)` | `cv.findContours(...)` with `cv.MatVector` | Exact |
| `cv2.boundingRect(c)` | `cv.boundingRect(contour)` → `{x, y, width, height}` | Exact |
| NumPy slice crop `img[y1:y2, x1:x2]` | `mat.roi(new cv.Rect(x1, y1, w, h))` + `.clone()` | Exact |
| `np.sum(thresh, axis=1)` (row sums) | JS loop over `mat.data` (Uint8Array), one sum per row | Exact (integer sums; doubles are exact ≤ 2^53) |
| `np.sum(roi, axis=0)` (column sums) | JS loop over ROI columns | Exact |
| `np.convolve(a, ones(k)/k, 'same')` | Hand-written `convolveSame(a, k)`: zero-padded windowed sums with numpy's `'same'` centering (offset `(k-1)//2`) | Exact math; FP summation order may differ at ~1e-15 relative — no practical effect on threshold comparisons |
| `np.max(arr)` | JS loop max | Exact |
| Python `int(x)` scaling (all kernel/threshold sizes) | `Math.trunc(x)` | Exact |
| Peak/valley scans, gap-splitting loops, sorting, filtering | Direct line-by-line JS port | Exact |
| `cv2.rectangle` / `cv2.putText` / `cv2.addWeighted` overlays | Canvas 2D drawing (`strokeRect`, `fillRect` with alpha, `fillText`) | Cosmetic only — zero effect on counts (see quirk Q2) |
| PIL `Image.open` / `Image.fromarray` display | `cv.imshow(canvas, mat)` / canvas rendering | Cosmetic only |
| Streamlit session state, spinner, progress bar | Vanilla JS state object, status line, `<progress>` element, `requestAnimationFrame` yields between lines | Adapted UI |

`§6` checklist from the handoff — all covered above: `cvtColor` ✓, `GaussianBlur` ✓, `adaptiveThreshold` ✓, `dilate` ✓, `findContours` ✓, `boundingRect` ✓, NumPy projection calculations ✓ (rewritten as typed-array loops).

## 4. Operations that cannot be ported directly (and their adaptations)

1. **`cv2.imread` from a file path** — browsers have no filesystem. Adaptation: `<input type="file">` / drag-drop → `Image`/`createImageBitmap` → canvas → `cv.imread`. *This is the one genuine parity risk:* the browser's JPEG decoder may differ from OpenCV's libjpeg by ±1 in a few pixel values, which in edge cases can shift a threshold/contour and change a count slightly. Handoff §8 explicitly anticipates this. Mitigation in §6.
2. **NumPy vectorized math** — no NumPy in the browser. Adaptation: hand-rolled typed-array loops (row/column sums, convolution, max), written to mirror numpy semantics exactly (documented per-op above).
3. **PIL** — used only for display and the inline sample generator. Adaptation: canvas rendering; samples pre-generated and bundled.
4. **`cv2.putText` Hershey fonts** — available in OpenCV.js but overlay text will use Canvas 2D `fillText` instead (crisper, no font tables). Cosmetic only.
5. **Streamlit** — entire UI layer rewritten as static HTML/CSS/JS (no framework).
6. **CLAHE contingency** — CLAHE is in the official opencv.js build whitelist and will be smoke-tested first. If it turned out missing, fallback is a deterministic hand-port of CLAHE (tiled clipped-histogram equalization with bilinear interpolation) — noted here so the plan has no dead end; not expected to be needed.
7. **Tempfiles** — not applicable; everything stays in memory.

## 5. Fidelity quirks — preserved deliberately

- **Q1 — Swapped grayscale weights in Stage 3.** `app.py` passes an **RGB** crop into `extract_word_clusters`, which applies `COLOR_BGR2GRAY`. Result: gray = 0.114·R + 0.587·G + 0.299·B (R/B weights swapped vs. true luminance). This affects thresholds and therefore counts. The port reproduces it bit-exactly by applying `COLOR_BGRA2GRAY` to the RGBA crop. (Stage 1 uses the correct weights in both versions.)
- **Q2 — Overlay colors don't match the UI copy in Python.** The Python app draws BGR-ordered color tuples onto RGB arrays, so the "orange" bands render blue-ish and the "red" word boxes render blue. Counts are unaffected. Decision: the web version draws the colors the UI text names (orange bands, green line boxes, blue raw fragments, red word boxes) — clearer, cosmetic only.
- **Truncation semantics.** Every `int(...)` size/threshold computation uses `Math.trunc` in JS.
- **Bottom-edge padding.** Merged line boxes may extend past the image bottom (Python doesn't clamp height); `app.py` clamps at crop time. Both behaviors ported as-is.
- **All magic numbers** (31/15, 21/10, 0.05, 0.008, 0.06, 0.25, 0.003, 0.15, 255·5, defaults target=31, resize cap 2000, etc.) copied verbatim; no tuning.

## 6. Known divergence risks and mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Browser JPEG decode ≠ libjpeg decode | A few ±1 pixel values → rare contour/threshold flips → small count drift | Compare against Python reference on both bundled samples; if counts differ, diff stage-by-stage (line count, per-line counts, threshold nonzero counts) to locate and confirm the divergence is decode-level, then document it (handoff §8 allows small deltas) |
| FP summation order in convolution | ~1e-15 relative — effectively none | Documented; no action |
| OpenCV version skew (4.x Python vs 4.x js) | None expected for these ops | Pin the opencv.js version; record it in `web/README.md` |

## 7. Architecture decisions (options considered → recommendation)

1. **OpenCV.js delivery**
   - **A (recommended): vendor a pinned official single-file build** (~11 MB, e.g. 4.10.0 from docs.opencv.org) into `web/vendor/opencv.js`. Fully self-contained site, version pinned, no third-party requests at all — strongest match for the privacy story and the "no external dependencies" spirit. Repo grows ~11 MB (fine for GitHub).
   - B: hot-link `https://docs.opencv.org/4.x/opencv.js` — no repo bloat, but an external dependency on a docs server with no CDN SLA and a floating version. Rejected.
   - C: custom slim Emscripten build (~2–3 MB) — smallest payload but requires a whole toolchain; overkill for a POC. Rejected.
2. **Threading** — **main thread with `requestAnimationFrame` yields between pipeline stages/lines (recommended)**. Images are capped at 2000 px wide; total processing is expected in the low seconds. A Web Worker would keep the UI perfectly fluid but adds message-passing complexity a POC doesn't need. Listed as future work.
3. **Run flow** — Python has two buttons (Step 1 lines, Step 2 words). The handoff's UI spec asks for a single **Run Analysis** button. **Recommendation: single button** that runs both stages sequentially with per-stage status text and a per-line progress bar; the debug sections still expose each stage's intermediate output, so nothing is lost.
4. **Sample images** — include two "Try a sample" buttons loading the bundled synthetic demos (`demo_meeting.jpg`, `demo_lecture.jpg`). Mirrors the Python app's sample selector and enables fully automated browser verification (no OS file dialog needed). They are machine-generated images, safe to publish.
5. **Python for reference counts** — no Python runtime exists on this machine (`python`/`py` both absent). To honor the handoff's "compare browser count vs Python count" step: install Python 3 (winget, user scope) plus a project-local `venv/` (git-ignored) with `opencv-python-headless` + `numpy`, run a small headless reference script (kept in scratchpad, not the repo) on both samples, and record `{lineCount, perLineCounts, total}`. Alternative (if you prefer no Python install): skip exact numeric parity and verify behaviorally only — **not recommended**, the handoff explicitly asks for the comparison.

## 8. Web app structure

```text
web/
├── index.html      # single page, semantic sections
├── styles.css      # clean laptop-first layout, no framework
├── app.js          # everything below
├── vendor/
│   └── opencv.js   # pinned official build (version recorded in web/README.md)
├── samples/
│   ├── demo_meeting.jpg
│   └── demo_lecture.jpg
└── README.md       # local testing, architecture, pinned version, parity notes
```

`app.js` internal layout (single file, clearly sectioned — POC scale):
- **OpenCV loader/guard** — async script load, `onRuntimeInitialized`/Promise handling, load timeout → readable error banner; controls disabled until ready ("Loading OpenCV.js…" status).
- **Pipeline port** — pure functions mirroring `cv_utils.py` names: `preprocessImage(matRGBA)`, `extractLineBoundingBoxes(grayMat)`, `extractWordClusters(cropRGBA)`, plus `convolveSame`, row/col sum helpers. Same structure as the Python for line-by-line reviewability.
- **Mat lifecycle** — every stage wrapped in `try/finally`; a small scope helper tracks created Mats/MatVectors and deletes them, so no leaks even on exceptions (explicit handoff requirement).
- **UI state + wiring** — one state object (active image, results), render functions, reset.

UI regions (top to bottom), matching the handoff's list:
1. Title + "Proof of Concept" badge; privacy note: *images are processed locally in your browser and never uploaded*.
2. Input row: file upload (JPG/PNG, incl. drag-drop) + two sample buttons.
3. Config: "Minimum required words" number input (default 31, min 1, step 10).
4. **Run Analysis** button + status line + progress bar; **Reset** button.
5. Results: PASS/FAIL banner, estimated total, detected line count.
6. Previews: original image; line-segmentation overlay (orange bands, blue raw fragments, green numbered line boxes with dimension labels); per-line word-cluster section — for each line: cluster overlay plus collapsible debug pair (pure threshold, dilation mask) and per-line count, mirroring the Python 3-column diagnostics.
7. Footer: POC limitations (handoff §16 list).

Error handling: OpenCV load failure/timeout, unreadable/corrupt image, zero lines detected ("0 master rows" case, mirroring Python), and unexpected runtime errors — all rendered as readable messages in the status area, never a dead console-only failure.

## 9. Verification plan (before any deployment)

1. Smoke test: page loads via local static server, OpenCV.js initializes, CLAHE constructor exists.
2. Python reference: run the reference script on `samples/demo_meeting.jpg` and `samples/demo_lecture.jpg` → record line count, per-line word counts, total.
3. Browser run (automated via the in-app browser): load each sample, Run Analysis, read the displayed counts; verify overlays render; check the console for errors; verify no network requests carry image data.
4. Compare Python vs browser totals per sample; if they differ, stage-by-stage diff (per §6) and fix or document.
5. Handoff §8 checklist: second image, refresh, reset, pass/fail flip via target change.
6. Report both counts, then **pause before any GitHub deployment**.

## 10. Deployment plan (later phases, after separate approval)

- `.github/workflows/deploy-pages.yml`: checkout → `actions/configure-pages` → `actions/upload-pages-artifact` with `path: web` → `actions/deploy-pages`; triggers: push to `main` + `workflow_dispatch`. Written during implementation (inert until pushed), verified in the §9-phase.
- All asset references relative (`./styles.css`, `./vendor/opencv.js`, `./samples/...`) — works at `/inkcount/` and at `http://localhost:8000/`.
- `.gitignore`: `venv/`, `.venv/`, `__pycache__/`, `*.pyc`, personal note images, build artifacts, temp files, backup folder.
- Root `README.md` update: live-demo placeholder, architecture, browser privacy explanation, POC limitations, local web-testing instructions. (Current README is Windows-batch-demo oriented; it gets extended, not rewritten, since Python files must stay usable.)
- Git: repo is not yet initialized — per handoff §11 `git init -b main` happens at publish time, followed by the pre-push audit (no personal images, no secrets, no venv) and push to the user-created GitHub repo.

## 11. Phases and approval gates

| Phase | Contents | Gate |
|---|---|---|
| 1 (this doc) | Audit + mapping + plan | **User approval required before any web code** |
| 2 | Implement `web/`, install Python for reference, local verification, report Python vs browser counts | Pause before deployment |
| 3 | Pages prep (.gitignore, root README, workflow verify), show full file list | User approval before push |
| 4 | git init, commit, push, user enables Pages, validate live URL | Handoff §15 checklist |

## 12. Out of scope

- Any change to `app.py`, `cv_utils.py`, `ocr_utils.py`, or the other Python/batch files.
- TrOCR / any OCR or ML inference (unused by the current app; wouldn't fit a static site).
- Algorithm improvements or parameter tuning — parity is the goal, warts and all.
- Mobile layout (laptop screens per handoff), Web Worker, custom domain setup (documented as optional, handoff §13).

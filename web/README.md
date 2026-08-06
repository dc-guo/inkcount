# InkCount — Browser Version (`web/`)

Fully client-side port of the Python/Streamlit proof of concept in the repository root, deployed to <https://dc-guo.github.io/inkcount/>. Runs entirely in the visitor's browser: HTML + CSS + vanilla JavaScript + OpenCV.js. No server, no backend, no API keys — **uploaded images never leave the browser**.

## Run it locally

From the repository root (any static file server works):

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/web/>. Serving over HTTP is required — opening `index.html` via `file://` blocks the sample images.

## Architecture

| File | Role |
|---|---|
| `index.html` | Single page: uploader, sample buttons, target input, results, debug previews |
| `styles.css` | Laptop-first layout, no framework |
| `app.js` | OpenCV.js loader, pipeline port (`CVPort`), preview renderers, UI wiring |
| `vendor/opencv.js` | Pinned official OpenCV.js **4.9.0** single-file build from `https://docs.opencv.org/4.9.0/opencv.js` |
| `samples/` | Two machine-generated demo images (safe to publish) |

The InkCount pipeline in `app.js` is a line-by-line port of `cv_utils.py` — identical parameters, thresholds, kernels, and control flow. Overlays are drawn with Canvas 2D and are purely cosmetic; counts come only from the ported pipeline. All OpenCV Mats are tracked in a scope and released after every run (`withMats`), including on errors.

## Parity with the Python reference

Verified with the Python implementation (opencv-python-headless **4.9.0.80**, numpy 1.26.4) against the browser build (OpenCV.js **4.9.0**, Chrome 150 headless). Expected counts live in `../tests/fixtures/reference.json`; the automated comparison page is `../tests/parity.html`.

| Sample | Python lines | Python per-line | Python total | Browser total | Match |
|---|---|---|---|---|---|
| `demo_meeting.jpg` | 4 | 3, 8, 10, 9 | **30** | **30** | ✅ exact (incl. box coordinates) |
| `demo_lecture.jpg` | 3 | 3, 6, 7 | **16** | **16** | ✅ exact (incl. box coordinates) |

Notes:

- **Deliberate quirk preserved:** the Python app passes RGB crops into a BGR grayscale conversion in the word-cluster stage (swapped R/B weights). The port reproduces this bit-exactly via `COLOR_BGRA2GRAY` on RGBA data — do not "fix" it without changing the Python reference first.
- Browser JPEG decoding matched Python's exactly on both bundled samples. Other images may decode with ±1 pixel-value differences on some pixels, which can occasionally shift a count slightly — an accepted proof-of-concept limitation.
- PNG images with transparency are flattened differently than in Python (`cv2.imread` drops alpha); use opaque images for comparable results.

## Test pages (repository `tests/`, not deployed)

- `tests/smoke.html` — OpenCV.js loads, CLAHE and required functions exist
- `tests/math.html` — JS convolution vs numpy-generated fixtures (6 cases)
- `tests/parity.html` — full pipeline vs `fixtures/reference.json`, both samples

Each page reports PASS/FAIL in the page body and in the tab title.

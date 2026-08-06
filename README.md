# 🖋️ InkCount — Handwritten Word Counter

**Proof of concept.** InkCount counts handwritten words on a photographed notebook page using pure geometric computer vision (OpenCV) — no OCR, no machine-learning inference, no cloud. It segments the page into handwritten rows, clusters ink into word-sized boxes, and compares the estimated count against a configurable minimum target.

## 🌐 Live Demo (browser version)

**<https://dc-guo.github.io/inkcount/>**

Runs entirely in your browser with OpenCV.js. **Privacy: images are processed locally in your browser and are never uploaded to any server** — there is no backend at all.

## Two implementations, one algorithm

| | Where it runs | Stack |
|---|---|---|
| [`web/`](web/) | Any modern browser (GitHub Pages) | HTML + CSS + JavaScript + OpenCV.js 4.9.0 |
| Repository root (`app.py`, `cv_utils.py`) | Local Python | Python + Streamlit + OpenCV (reference implementation) |

The browser version of InkCount is a verified line-by-line port of `cv_utils.py` — identical parameters and control flow. On both bundled samples it produces **exactly** the same counts and box coordinates as the Python version (details and the parity table in [`web/README.md`](web/README.md)).

### Architecture (browser version)

1. **Preprocess** — grayscale → CLAHE contrast enhancement → unsharp mask
2. **Row segmentation** — adaptive threshold → horizontal ink-projection profile → smoothed peak detection finds each handwritten row
3. **Word clustering** — per row: adaptive threshold → directional dilation → contour bounding boxes, with wide clusters split at whitespace gaps
4. **Verdict** — total cluster count vs. your minimum-words target → PASS / FAIL

Everything happens in page JavaScript; the only files ever fetched are the site's own assets.

## Test the web version locally

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/web/>. (Any static file server works; `file://` won't, because browsers block the sample-image fetches.) Automated verification pages live in [`tests/`](tests/) — smoke, math fixtures, and a full parity comparison against `tests/fixtures/reference.json`.

## Run the Python reference version

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m streamlit run app.py
```

Windows one-click launchers (`INSTALL_DEMO.bat` / `RUN_DEMO.bat`) are also included — see [`PACKAGE_NOTES.md`](PACKAGE_NOTES.md).

## Proof-of-concept limitations

- The count is an **estimate** based on geometric word clustering.
- Unusual cursive spacing may split one word into multiple clusters.
- Very tight handwriting may merge multiple words into one cluster.
- Lighting, page angle, shadows, notebook lines, and image quality can affect results.
- InkCount is a proof of concept, **not** a production handwriting-recognition system.

## Repository layout

```text
├── app.py                  # Streamlit UI (Python reference)
├── cv_utils.py             # The counting pipeline (Python reference)
├── web/                    # Browser version (deployed to GitHub Pages)
│   ├── index.html · styles.css · app.js
│   ├── vendor/opencv.js    # pinned OpenCV.js 4.9.0
│   └── samples/            # machine-generated demo images
├── tests/                  # parity + smoke test pages (not deployed)
├── docs/                   # migration plan / porting documentation
└── .github/workflows/deploy-pages.yml   # Pages deployment
```

Deployment: pushes to `main` publish `web/` via GitHub Actions (Settings → Pages → Source: **GitHub Actions**).

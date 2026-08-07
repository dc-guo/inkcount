# 🖋️ InkCount — Handwritten Word Counter

InkCount counts the words on a photographed page of handwriting. Built for
students with lecture-journal word requirements: snap the page, get the number.

**Live app:** <https://dc-guo.github.io/inkcount/>

- Runs **entirely in the browser** — the photo and the recognition model never
  leave the device. No accounts, no server, no cost.
- Reads the handwriting with an on-device recognition model (TrOCR) and counts
  words in what it read — so connected cursive counts correctly, and you can
  inspect the per-line transcript to judge how much to trust the number.
- Handles phone-photo reality: camera tilt, ruled notebook lines, shadows, and
  HEIC photos straight off an iPhone.
- First use downloads the ~80 MB reader once; the browser caches it after that.

## Repository layout

| Path | What it is |
|---|---|
| [`web/`](web/) | The app — vanilla JS modules + OpenCV.js + transformers.js. See [`web/README.md`](web/README.md) for the pipeline and measured accuracy. |
| [`tests/`](tests/) | Browser test pages (module gates + accuracy regression with committed ground-truth fixtures). Served locally, never deployed. |
| [`tools/`](tools/) | Fixture generator and the transformers.js bundling recipe. |
| `app.py`, `cv_utils.py` | **v1 prototype** (Python/Streamlit, geometric ink-clustering). Kept for reference; superseded by the browser app, which uses a different and substantially more accurate algorithm. |
| [`docs/`](docs/) | Design specs and implementation plans, including the v1→v2 decision record. |

## Accuracy, briefly

The v1 geometric approach collapsed on real photo conditions (−98% on a page
tilted 3.5°). v2 straightens the page, segments lines at the handwriting's own
scale, and reads them with a recognition model: **mean absolute error 3.0%**
across seven ground-truth test pages in-browser (worst case 7.9%), including
an exact count on cursive. Full table and method in
[`web/README.md`](web/README.md).

**Honest caveat:** those pages are rendered with handwriting fonts. Validation
against photographed real handwriting is still pending, and the accuracy
figures should be treated as optimistic until it lands.

## Run locally

```bash
python -m http.server 8000
```

Open <http://localhost:8000/web/>. (Any static server works; `file://` won't.)

To run the v1 Python prototype instead: `pip install -r requirements.txt`,
then `streamlit run app.py`.

## Limitations

- English handwriting only (model limitation).
- One page per photo; heavy crossing-out, diagrams mixed into text, faint
  pencil, or extreme blur can shift the count.
- The count is the model's best reading of the page — the per-line transcript
  in the app is the tool for judging it.

# 🖋️ InkCount — Handwritten Word Counter (Beta)

InkCount counts the words on a photographed page of handwriting. Built for
students with lecture-journal word requirements: snap the page, get the number.

**Live app:** <https://dc-guo.github.io/inkcount/> ·
**Device self-test:** <https://dc-guo.github.io/inkcount/device-test.html>

- Runs **entirely in the browser** — the photo and the recognition model never
  leave the device. No accounts, no server, no cost.
- Reads the handwriting with an on-device recognition model (TrOCR) and counts
  words in what it read — so connected cursive counts correctly, and you can
  inspect the per-line transcript to judge how much to trust the number.
- Handles phone-photo reality: camera tilt, ruled notebook lines, shadows, and
  HEIC photos straight off an iPhone.
- Journal entries can span **multiple pages** — add each page, watch one running total, and remove or review pages individually.
- **Private history**: tap "Save entry" to keep a local log (date, counts, small preview). It lives only in your browser — nothing is uploaded, and photos are never kept.
- First use downloads the ~80 MB reader once; the browser caches it after that.

## Repository layout

| Path | What it is |
|---|---|
| [`web/`](web/) | The app — vanilla JS modules + OpenCV.js + transformers.js. See [`web/README.md`](web/README.md) for the pipeline and measured accuracy. |
| [`tests/`](tests/) | Browser test pages (module gates + accuracy regression with committed ground-truth fixtures). Served locally, never deployed. |
| [`tools/`](tools/) | Fixture generator, the transformers.js bundling recipe, and `tools/ci/` — the verification suite GitHub Actions runs before every deploy. |
| `app.py`, `cv_utils.py` | **v1 prototype** (Python/Streamlit, geometric ink-clustering). Kept for reference; superseded by the browser app, which uses a different and substantially more accurate algorithm. |
| [`docs/`](docs/) | Design specs and implementation plans, including the v1→v2 decision record. |

## Accuracy, honestly

Two kinds of evidence, stated separately:

**Rendered fixtures (9 pages, committed, asserted on every deploy):** mean
absolute error under the CI bound of 5% (recently measured ~1–2%), worst case
under 10%, exact on cursive, exactly 0 on a no-handwriting illustration. Full
table and method in [`web/README.md`](web/README.md).

**Photographed real handwriting:** one validated page so far (all lines
detected; count judged correct by its author after four user-reported issues
were fixed and locked in as fixtures). This column is thin — real pages are
what actually find bugs, and we are actively collecting them:
**[contribute a page](docs/CONTRIBUTING_FIXTURES.md)** (5 minutes, public-repo
privacy rules inside).

Every deploy is gated: GitHub Actions runs all twelve verification gates (unit,
segmentation, recognition, accuracy bounds, accessibility, offline/PWA) plus a
full UI walkthrough in headless Chrome, and a red gate blocks the release.

## Run locally

```bash
python -m http.server 8000
```

Open <http://localhost:8000/web/>. (Any static server works; `file://` won't.)

To run the v1 Python prototype instead: `pip install -r requirements.txt`,
then `streamlit run app.py`.

## Limitations

- English handwriting only (model limitation).
- One page per photo (use "Add another page" for multi-page entries); heavy crossing-out, diagrams mixed into text, faint pencil, or extreme blur can shift the count.
- The count is the model's best reading of the page — the per-line transcript
  in the app is the tool for judging it.

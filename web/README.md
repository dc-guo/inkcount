# InkCount — Browser App (`web/`)

Counts handwritten words on a photographed notebook page, entirely in the
browser. Live at <https://dc-guo.github.io/inkcount/>. No backend, no accounts,
no per-use cost — **the photo and the recognition model both stay on the
device**.

## How it works

```
photo ─▶ decode ─▶ preprocess ─▶ segment ─▶ recognize ─▶ count
        (HEIC/    (deskew,      (line      (TrOCR per   (transcript
         JPEG/     de-rule,      crops)     line,        tokens)
         PNG)      binarize)                on-device)
```

1. **Decode** (`src/decode.js`) — JPG/PNG/WebP natively; HEIC (the iPhone
   default) via bundled libheif-wasm, detected by magic bytes. Long edge capped
   at 2000 px.
2. **Preprocess** (`src/preprocess.js`) — grayscale + CLAHE, adaptive
   threshold, **skew estimation** (projection-variance search over ±6°),
   deskew, **ruled-line removal** (after deskew — order matters), text-height
   measurement.
3. **Segment** (`src/segment.js`) — smoothed horizontal ink projection with
   every threshold scaled to the measured handwriting height; low-ink phantom
   bands rejected.
4. **Recognize** (`src/recognize.js`) — `Xenova/trocr-small-handwritten`
   (q8 ONNX, ~65 MB) through transformers.js, one line crop at a time,
   fully served from this site's own origin.
5. **Count** (`src/count.js`) — whitespace tokens across line transcripts,
   with degenerate-output detection so hallucinated lines are flagged
   (`check` chip) instead of silently trusted.

While the model downloads on first use, a fast geometric estimate
(`src/geometric.js`) shows a clearly-labelled rough count; it is also the
fallback if the model cannot load.

## Measured accuracy

Ground truth: seven generated notebook pages (`tests/fixtures/pages/`,
regenerable with `tools/make_fixtures.py`), 189 words each, exercising ruled
paper, 3.5° camera tilt, shadows, cramped spacing, and cursive-style script.
In headless Chrome (single-threaded WASM):

| Page | v1 (geometric) error | v2 error |
|---|---|---|
| Flat, well-spaced | −1.6% | −0.5% |
| Ruled notebook | −7.9% | +0.5% |
| Tilted 3.5° | **−98.4%** | −0.5% |
| Uneven lighting | −1.6% | −3.2% |
| Tight line spacing | **−98.4%** | +0.5% |
| Cursive script | −15.3% | **0.0%** |
| Ruled + tilt + shadow | **−99.5%** | −1.1% |

**v1 mean |error|: 46.1% → v2: 0.9%** (worst case 99.5% → 3.2%).
`tests/accuracy.html` asserts mean |error| ≤ 5% and worst ≤ 10% on every run.

Two guards worth knowing about: short trailing lines (a two-word "at all.")
are detected via low-threshold hysteresis bands and cropped to their own ink
extent — full-width crops of short lines made the recognizer hallucinate
fluent nonsense on the blank space. And lines whose transcript matches a
hallucination signature (single-char spam or repetition loops) are shown
flagged in the transcript but **excluded from the total**.

> **Caveat:** these pages use handwriting *fonts*, which are more uniform than
> real handwriting — treat the numbers as optimistic until the suite includes
> photographed real pages (planned; blocked on collecting them).

Timing: ~0.7 s per line — 10.3–13.3 s for the fixture pages after the one-time
model download. English only.

## Local development

```bash
python -m http.server 8000
```

then open <http://localhost:8000/web/>. Test pages live in `../tests/`
(smoke, assets, decode, preprocess, segment, count, recognize, accuracy);
each reports PASS/FAIL in its body and tab title.

`vendor/transformers/transformers-bundled.mjs` is prebuilt — see
`../tools/build_transformers_bundle.md` for the exact command and the
version-sensitive workarounds documented in `src/recognize.js`.

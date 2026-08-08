# Contributing real handwriting test pages

InkCount's accuracy numbers are only as honest as its test set. The current
fixtures are mostly *rendered* handwriting fonts; every bug that mattered was
found by a **photographed real page**. Contributing one takes five minutes and
permanently protects your handwriting style from regressions.

## What to send

1. **A photo of one handwritten page** — phone camera, normal conditions
   (slight tilt, ruled paper, imperfect lighting are all *good*: that's what
   the tool must handle). JPG, PNG, or HEIC.
2. **Your hand count** of the words on it.

## How to hand-count (the rules the tool is graded against)

- A word is a whitespace-separated token containing at least one letter or
  digit: "Wow!" is **one** word; a lone "!" or "&" is **zero**; "chapter 4"
  is **two**; hyphenated "state-of-the-art" is **one**.
- Count crossed-out words only if they are still clearly legible words.

## Privacy — read before contributing

Contributed pages are **committed to a public repository** and served on the
public test pages. Never submit private journal content, names, or anything
you wouldn't post publicly. Write a neutral sample passage instead — the
*handwriting* is what we need, not the words' meaning.

## What happens with it

The image lands in `tests/fixtures/pages/` with its expected count in
`expected.json`, and `tests/accuracy.html` starts asserting it on every
single deployment — your page becomes part of the definition of "working."

Open a GitHub issue with the photo attached, or a pull request adding the
file + expected entry directly: <https://github.com/dc-guo/inkcount/issues>

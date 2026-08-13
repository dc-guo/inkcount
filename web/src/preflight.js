/* Pre-flight photo warnings from the fast geometric pass — shown BEFORE the
 * ~15 s model read so a bad photo costs seconds, not the whole wait.
 * Advisory only; the UI never blocks counting on a heuristic (the one hard
 * stop is lines === 0, where there are literally no crops to read).
 *
 * Thresholds are calibrated by tests/preflight.html: every text fixture and
 * the bundled sample must stay warning-free; the no-text fixture must fire
 * exactly `no-lines`. The tilted fixture measures ~3.5°, so TILT_DEG sits
 * above it at 4.5 (the deskew estimator itself caps at ±6). If a threshold
 * ever trips a known-good fixture, move the threshold — not the fixture.
 * DARK_BACKGROUND_MEDIAN = 110: inverted warning fires when median luminance
 * of the image is below this (light text on dark background). Calibrated from
 * gate fixture light-background baseline where all light pages have luminance
 * well above 110. */

export const TILT_DEG = 4.5;
export const MIN_TEXT_HEIGHT_PX = 12;
export const DARK_BACKGROUND_MEDIAN = 110;

/** Median luminance (0-255) of a grayscale image ({data} of bytes — an
 * OpenCV gray Mat qualifies). Pure; histogram-based, O(n). */
export function medianLuminance(grayLike) {
  const data = grayLike.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const half = data.length / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= half) return v; }
  return 255;
}

export function evaluatePreflight({ skewAngle, lines, textHeight, medianLum }) {
  const warnings = [];
  if (typeof medianLum === 'number' && medianLum < DARK_BACKGROUND_MEDIAN) {
    warnings.push({ id: 'inverted', severity: 'warn',
      message: "This looks like light text on a dark background — InkCount reads dark handwriting on light paper (photos of screens and dark-mode pages won't count reliably)." });
  }
  if (lines === 0) {
    warnings.push({ id: 'no-lines', severity: 'warn',
      message: 'No handwritten lines were found. Retake closer and straight on — fill the frame with the page.' });
    return warnings;
  }
  if (lines === 1) {
    warnings.push({ id: 'one-line', severity: 'warn',
      message: 'Only one line was found. If the page has more, retake closer and fill the frame with the page.' });
  }
  if (Math.abs(skewAngle) >= TILT_DEG) {
    warnings.push({ id: 'tilted', severity: 'info',
      message: 'The page looks tilted (' + Math.abs(skewAngle).toFixed(1) + '°). It was straightened automatically, but a straight-on shot reads better.' });
  }
  if (textHeight < MIN_TEXT_HEIGHT_PX) {
    warnings.push({ id: 'small-text', severity: 'info',
      message: 'The writing appears small in this photo — a closer shot reads more accurately.' });
  }
  return warnings;
}

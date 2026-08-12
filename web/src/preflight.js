/* Pre-flight photo warnings from the fast geometric pass — shown BEFORE the
 * ~15 s model read so a bad photo costs seconds, not the whole wait.
 * Advisory only; the UI never blocks counting on a heuristic (the one hard
 * stop is lines === 0, where there are literally no crops to read).
 *
 * Thresholds are calibrated by tests/preflight.html: every text fixture and
 * the bundled sample must stay warning-free; the no-text fixture must fire
 * exactly `no-lines`. The tilted fixture measures ~3.5°, so TILT_DEG sits
 * above it at 4.5 (the deskew estimator itself caps at ±6). If a threshold
 * ever trips a known-good fixture, move the threshold — not the fixture. */

export const TILT_DEG = 4.5;
export const MIN_TEXT_HEIGHT_PX = 12;

export function evaluatePreflight({ skewAngle, lines, textHeight }) {
  if (lines === 0) {
    return [{ id: 'no-lines', severity: 'warn',
      message: 'No handwritten lines were found. Retake closer and straight on — fill the frame with the page.' }];
  }
  const warnings = [];
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

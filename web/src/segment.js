/* Deskewed page → one cropped canvas per handwritten line.
 * All thresholds are expressed in units of the measured text height, so dense
 * and sparse handwriting segment equally well. */
import { requireCV } from './mats.js';

function rowSums(mat) {
  const rows = mat.rows, cols = mat.cols, data = mat.data;
  const out = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    let acc = 0;
    const base = r * cols;
    for (let c = 0; c < cols; c++) acc += data[base + c];
    out[r] = acc;
  }
  return out;
}

function boxSmooth(arr, k) {
  const M = arr.length, s = Math.floor((k - 1) / 2), inv = 1 / k;
  const out = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const lo = Math.max(0, i + s - k + 1), hi = Math.min(M - 1, i + s);
    let acc = 0;
    for (let m = lo; m <= hi; m++) acc += arr[m] * inv;
    out[i] = acc;
  }
  return out;
}

/**
 * segmentLines({ gray, binary, textHeight }, scope)
 *   -> Array<{ canvas: HTMLCanvasElement, rect: {x, y, w, h} }>
 * rect is in deskewed-page coordinates (for the detected-lines overlay).
 */
export function segmentLines({ gray, binary, textHeight }, scope) {
  const cv = requireCV();
  const H = binary.rows, W = binary.cols;

  // 1. Smoothed horizontal ink projection, kernel scaled to the handwriting.
  const proj = rowSums(binary);
  const k = Math.max(3, Math.round(textHeight * 0.6) | 1);
  const sm = boxSmooth(proj, k);
  let peak = 0;
  for (let i = 0; i < sm.length; i++) if (sm[i] > peak) peak = sm[i];
  const thresh = Math.max(peak * 0.10, 255 * 3);

  // 2. Contiguous bands above threshold.
  const bands = [];
  let inBand = false, start = 0;
  for (let i = 0; i < H; i++) {
    if (sm[i] > thresh) {
      if (!inBand) { inBand = true; start = i; }
    } else if (inBand) {
      inBand = false;
      bands.push([start, i]);
    }
  }
  if (inBand) bands.push([start, H]);

  // 3. Horizontal ink extent of the page.
  const colHasInk = new Uint8Array(W);
  const data = binary.data;
  for (let r = 0; r < H; r++) {
    const base = r * W;
    for (let c = 0; c < W; c++) if (data[base + c]) colHasInk[c] = 1;
  }
  let x0 = 0, x1 = W;
  for (let c = 0; c < W; c++) { if (colHasInk[c]) { x0 = Math.max(0, c - 10); break; } }
  for (let c = W - 1; c >= 0; c--) { if (colHasInk[c]) { x1 = Math.min(W, c + 10); break; } }
  if (x1 <= x0) { x0 = 0; x1 = W; }

  // 4. Keep only bands tall enough and with enough ink to be a real text line
  //    (residual rule fragments and noise produce phantom bands the recognizer
  //    then hallucinates words onto).
  const minBandH = Math.max(6, textHeight * 0.55);
  const minInk = 0.9 * textHeight * textHeight;
  const pad = Math.trunc(textHeight * 0.45);
  const out = [];
  for (const [y0, y1] of bands) {
    if (y1 - y0 < minBandH) continue;
    let ink = 0;
    for (let r = y0; r < y1; r++) {
      const base = r * W;
      for (let c = x0; c < x1; c++) ink += data[base + c];
    }
    if (ink / 255 < minInk) continue;

    const yy0 = Math.max(0, y0 - pad), yy1 = Math.min(H, y1 + pad);
    const rect = new cv.Rect(x0, yy0, x1 - x0, yy1 - yy0);
    const roi = gray.roi(rect);
    const crop = roi.clone();
    roi.delete();
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, crop);
    crop.delete();
    out.push({ canvas, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
  }
  return out;
}

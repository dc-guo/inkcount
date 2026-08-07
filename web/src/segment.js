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

  const findBands = (thresh) => {
    const out = [];
    let inBand = false, start = 0;
    for (let i = 0; i < H; i++) {
      if (sm[i] > thresh) {
        if (!inBand) { inBand = true; start = i; }
      } else if (inBand) {
        inBand = false;
        out.push([start, i]);
      }
    }
    if (inBand) out.push([start, H]);
    return out;
  };

  // 2. Hysteresis banding. The 10% threshold gives well-bounded bands for
  // normal lines but silently drops short trailing lines ("at all." carries
  // ~9% of a full line's ink) — a real counting error. Simply lowering the
  // threshold widens EVERY band (edges sit at the threshold crossing), which
  // bled crops into neighboring lines and double-read fragments (+9% counts).
  // So: keep the 10% bands exactly as-is, and additionally admit 4% bands
  // that contain no 10% core — short lines get in, existing edges don't move.
  const floorAbs = 255 * 3;
  const coreBands = findBands(Math.max(peak * 0.10, floorAbs));
  const bands = [...coreBands];
  for (const low of findBands(Math.max(peak * 0.04, floorAbs))) {
    const hasCore = coreBands.some((c) => c[0] < low[1] && c[1] > low[0]);
    if (!hasCore) bands.push(low);
  }
  bands.sort((a, b) => a[0] - b[0]);

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
  // Enough ink for ~2 short words. 0.9×th² (the original value) silently
  // dropped short trailing lines like "at all." — a real counting error;
  // 0.35×th² still rejects residual rule fragments and speckle.
  const minInk = 0.35 * textHeight * textHeight;
  const pad = Math.trunc(textHeight * 0.45);
  const padX = Math.trunc(textHeight * 0.8);
  const out = [];
  for (const [y0, y1] of bands) {
    if (y1 - y0 < minBandH) continue;
    // A text line is about as tall as the handwriting: measured raw bands run
    // 1.3–2.0× textHeight even for cursive. Taller bands are drawings, photos,
    // or merged artwork — recognizing them produces phantom words (a
    // user-submitted illustration read as "5 words").
    if (y1 - y0 > textHeight * 2.5) continue;
    let ink = 0;
    for (let r = y0; r < y1; r++) {
      const base = r * W;
      for (let c = x0; c < x1; c++) ink += data[base + c];
    }
    if (ink / 255 < minInk) continue;

    // Crop to THIS band's ink extent, not the page-wide text extent: a short
    // line cropped to full page width is mostly blank paper, and the
    // recognizer hallucinates fluent nonsense on near-empty images
    // (measured: a 2-word line came back as 17 words).
    let bx0 = -1, bx1 = -1;
    for (let c = x0; c < x1; c++) {
      let has = 0;
      for (let r = y0; r < y1; r++) { if (data[r * W + c]) { has = 1; break; } }
      if (has) { if (bx0 < 0) bx0 = c; bx1 = c; }
    }
    if (bx0 < 0) continue;

    // Handwriting is mostly paper (stroke coverage ~8–20%); solid artwork is
    // not. Reject bands whose tight bounding box is over 40% ink.
    let inkTight = 0;
    for (let r = y0; r < y1; r++) {
      const base = r * W;
      for (let c = bx0; c <= bx1; c++) inkTight += data[base + c];
    }
    const density = (inkTight / 255) / ((y1 - y0) * (bx1 + 1 - bx0));
    if (density > 0.4) continue;

    // A text band is full of letter-sized pieces. Line-art bands pass the
    // density test (drawings are sparse strokes too) but their components are
    // wires, frames and hatching at wildly un-letter-like sizes — measured on
    // an illustration the recognizer then read as "# Jersey" etc. Require a
    // majority of the band's components to be letter-height.
    {
      const roi = binary.roi(new cv.Rect(bx0, y0, bx1 + 1 - bx0, y1 - y0));
      const bandMat = roi.clone();
      roi.delete();
      const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
      const n = cv.connectedComponentsWithStats(bandMat, labels, stats, cents, 8, cv.CV_32S);
      let comps = 0, letterSized = 0;
      for (let i = 1; i < n; i++) {
        const ch = stats.data32S[i * 5 + cv.CC_STAT_HEIGHT];
        const carea = stats.data32S[i * 5 + cv.CC_STAT_AREA];
        if (carea < 12) continue;
        comps++;
        if (ch >= textHeight * 0.35 && ch <= textHeight * 2.0) letterSized++;
      }
      bandMat.delete(); labels.delete(); stats.delete(); cents.delete();
      if (comps < 2 || letterSized / comps < 0.6) continue;
    }
    const cx0 = Math.max(x0, bx0 - padX);
    const cx1 = Math.min(x1, bx1 + 1 + padX);

    const yy0 = Math.max(0, y0 - pad), yy1 = Math.min(H, y1 + pad);
    const rect = new cv.Rect(cx0, yy0, cx1 - cx0, yy1 - yy0);
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

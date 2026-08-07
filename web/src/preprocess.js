/* Canvas → deskewed, de-ruled binary ink mask + deskewed grayscale + text scale.
 *
 * Order is load-bearing (measured, see docs/superpowers/specs/2026-08-06-…):
 * skew must be corrected BEFORE ruled-line removal — on a tilted page the rules
 * are not horizontal, a horizontal kernel misses them, and the leftover
 * fragments become phantom "text lines" that inflate the count by +60%.
 */
import { requireCV } from './mats.js';

/** Rotation angle (degrees) that makes text lines horizontal: the angle whose
 * horizontal ink projection has maximum variance (sharpest peaks/valleys). */
export function estimateSkew(binary, scope, limitDeg = 6.0, stepDeg = 0.25) {
  const cv = requireCV();
  const small = scope.track(new cv.Mat());
  cv.resize(binary, small, new cv.Size(0, 0), 0.35, 0.35, cv.INTER_AREA);
  const h = small.rows, w = small.cols;
  const center = new cv.Point(w / 2, h / 2);
  const rotated = scope.track(new cv.Mat());
  let bestAngle = 0, bestScore = -1;
  for (let a = -limitDeg; a <= limitDeg + 1e-9; a += stepDeg) {
    const M = cv.getRotationMatrix2D(center, a, 1.0);
    cv.warpAffine(small, rotated, M, new cv.Size(w, h), cv.INTER_NEAREST,
      cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    M.delete();
    const data = rotated.data;
    let sum = 0, sumSq = 0;
    for (let r = 0; r < h; r++) {
      let acc = 0;
      const base = r * w;
      for (let c = 0; c < w; c++) acc += data[base + c];
      sum += acc;
      sumSq += acc * acc;
    }
    const mean = sum / h;
    const variance = sumSq / h - mean * mean;
    if (variance > bestScore) { bestScore = variance; bestAngle = a; }
  }
  return Math.round(bestAngle * 100) / 100;
}

function rotate(mat, angleDeg, scope, interpolation, borderMode, borderValue) {
  const cv = requireCV();
  const out = scope.track(new cv.Mat());
  const M = cv.getRotationMatrix2D(new cv.Point(mat.cols / 2, mat.rows / 2), angleDeg, 1.0);
  cv.warpAffine(mat, out, M, new cv.Size(mat.cols, mat.rows), interpolation, borderMode, borderValue);
  M.delete();
  return out;
}

/** Remove long straight printed rules (notebook lines, margin lines) from a
 * deskewed binary mask, keeping the handwriting. */
export function removeRuledLines(binary, scope) {
  const cv = requireCV();
  const w = binary.cols, h = binary.rows;
  const horizK = scope.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(30, Math.trunc(w / 12)), 1)));
  const vertK = scope.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(30, Math.trunc(h / 12)))));
  const horiz = scope.track(new cv.Mat());
  const vert = scope.track(new cv.Mat());
  cv.morphologyEx(binary, horiz, cv.MORPH_OPEN, horizK);
  cv.morphologyEx(binary, vert, cv.MORPH_OPEN, vertK);
  const rules = scope.track(new cv.Mat());
  cv.bitwise_or(horiz, vert, rules);
  const dilK = scope.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  const rulesFat = scope.track(new cv.Mat());
  cv.dilate(rules, rulesFat, dilK);
  const out = scope.track(new cv.Mat());
  cv.subtract(binary, rulesFat, out);
  return out;
}

/** Median height of ink components ≈ the handwriting's x-height. Every later
 * threshold is expressed in this unit so the pipeline is scale-invariant. */
export function estimateTextHeight(binary) {
  const cv = requireCV();
  const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
  const n = cv.connectedComponentsWithStats(binary, labels, stats, centroids, 8, cv.CV_32S);
  const maxH = binary.rows * 0.1;
  const heights = [];
  for (let i = 1; i < n; i++) {
    const h = stats.data32S[i * 5 + cv.CC_STAT_HEIGHT];
    const area = stats.data32S[i * 5 + cv.CC_STAT_AREA];
    if (h >= 3 && h <= maxH && area >= 12) heights.push(h);
  }
  labels.delete(); stats.delete(); centroids.delete();
  if (heights.length === 0) return Math.max(8, binary.rows * 0.01);
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)];
}

/**
 * Full preprocessing: grayscale+CLAHE → binarize → estimate skew → deskew both
 * planes → remove ruled lines → measure text height.
 * Returns { gray, binary, textHeight, skewAngle }; Mats tracked by scope.
 */
export function preprocess(canvas, scope) {
  const cv = requireCV();
  const src = scope.track(cv.imread(canvas)); // RGBA

  let gray = scope.track(new cv.Mat());
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const enhanced = scope.track(new cv.Mat());
  clahe.apply(gray, enhanced);
  clahe.delete();
  gray = enhanced;

  const blur = scope.track(new cv.Mat());
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  let binary = scope.track(new cv.Mat());
  cv.adaptiveThreshold(blur, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 15);

  const skewAngle = estimateSkew(binary, scope);
  if (Math.abs(skewAngle) > 0.1) {
    binary = rotate(binary, skewAngle, scope, cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    gray = rotate(gray, skewAngle, scope, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  }

  binary = removeRuledLines(binary, scope);
  const textHeight = estimateTextHeight(binary);

  return { gray, binary, textHeight, skewAngle };
}

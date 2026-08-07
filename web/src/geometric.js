/* Fast geometric word-count estimate: dilate ink into word blobs and count
 * them. Deliberately approximate — it exists to give an instant number while
 * the recognition model downloads, and as the fallback if the model fails.
 * The accurate count always comes from recognize.js + count.js. */
import { requireCV } from './mats.js';

/**
 * estimateWordCount({ binary, textHeight }, bands) -> number
 * bands: Array<{ rect: {x, y, w, h} }> from segmentLines.
 */
export function estimateWordCount({ binary, textHeight }, bands) {
  const cv = requireCV();
  const kw = Math.max(2, Math.trunc(textHeight * 0.62));
  const kh = Math.max(1, Math.trunc(textHeight * 0.25));
  const minW = textHeight * 0.42;
  const minH = textHeight * 0.42;
  const minArea = textHeight * textHeight * 0.12;

  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kw, kh));
  let total = 0;
  for (const { rect } of bands) {
    const roi = binary.roi(new cv.Rect(rect.x, rect.y, rect.w, rect.h));
    const band = roi.clone();
    roi.delete();
    const merged = new cv.Mat();
    cv.dilate(band, merged, kernel);
    const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
    const n = cv.connectedComponentsWithStats(merged, labels, stats, centroids, 8, cv.CV_32S);
    for (let i = 1; i < n; i++) {
      const w = stats.data32S[i * 5 + cv.CC_STAT_WIDTH];
      const h = stats.data32S[i * 5 + cv.CC_STAT_HEIGHT];
      const area = stats.data32S[i * 5 + cv.CC_STAT_AREA];
      if (w >= minW && h >= minH && area >= minArea) total++;
    }
    band.delete(); merged.delete(); labels.delete(); stats.delete(); centroids.delete();
  }
  kernel.delete();
  return total;
}

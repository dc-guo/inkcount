/* On-device handwriting recognition: TrOCR-small-handwritten (q8) through
 * transformers.js, everything served from this site's own origin. */
/* transformers-bundled.mjs is transformers.js + onnxruntime-web prebundled
 * into one self-contained ESM file (tools/README note) — the stock .web build
 * has bare "onnxruntime-web" imports browsers cannot resolve without a bundler. */
import { pipeline, env, AutoProcessor, AutoTokenizer } from '../vendor/transformers/transformers-bundled.mjs';

// Fully local: never contact HuggingFace, load model + WASM from our vendor tree.
// (The browser build defaults allowLocalModels to false, so set it explicitly.)
env.allowRemoteModels = false;
env.allowLocalModels = true;
// PATHNAME, not full URL: transformers.js 4.2.0's file-metadata helper skips
// its local-files branch whenever localModelPath parses as an http(s) URL
// (get_file_metadata.js `if (!isURL)`), which silently drops the tokenizer and
// processor. A root-relative path passes that check and still resolves
// correctly from any page on the site, locally and under /inkcount/ on Pages.
env.localModelPath = new URL('../vendor/models/', import.meta.url).pathname;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
// GitHub Pages cannot send COOP/COEP headers, so SharedArrayBuffer (threads)
// is unavailable; single-threaded WASM is the reliable baseline everywhere.
env.backends.onnx.wasm.numThreads = 1;

const MODEL_ID = 'Xenova/trocr-small-handwritten';

let modelPromise = null;
let ready = false;
let currentProgress = null;

/**
 * loadModel(onProgress) — memoized; safe to call repeatedly.
 * onProgress receives transformers.js progress events:
 *   { status: 'progress', file, progress (0-100), loaded, total } during fetch,
 *   { status: 'ready' } at the end.
 * A non-null onProgress on any call (even when the load is already in flight)
 * replaces the live progress callback — a Count pressed mid-prefetch takes
 * over the progress UI.
 */
export function loadModel(onProgress) {
  if (onProgress) currentProgress = onProgress;
  if (!modelPromise) {
    modelPromise = (async () => {
      const p = await pipeline('image-to-text', MODEL_ID, {
        dtype: 'q8',
        progress_callback: (ev) => { try { currentProgress && currentProgress(ev); } catch (_) {} },
      });
      // transformers.js 4.2.0's pipeline() leaves BOTH .processor and
      // .tokenizer null for this legacy Xenova model conversion, though the
      // Auto* loaders handle it fine (DeiTFeatureExtractor + XLMRoberta
      // tokenizer). Patch them in or inference throws "this.processor is not
      // a function" / "null.batch_decode".
      if (typeof p.processor !== 'function') {
        p.processor = await AutoProcessor.from_pretrained(MODEL_ID);
      }
      if (!p.tokenizer) {
        p.tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      }
      ready = true;
      return p;
    })();
    modelPromise.catch(() => { modelPromise = null; }); // allow retry after failure
  }
  return modelPromise.then(() => undefined);
}

export function isModelReady() {
  return ready;
}

/** Last per-line recognition error, for diagnostics ('' lines in the output). */
export let lastError = null;

/** Longest sensible generation for one handwritten line (~5-12 words).
 * Far above any real line, far below a runaway repetition loop — bounds both
 * latency and the per-line wasm memory spike that kills iOS tabs. */
export const MAX_NEW_TOKENS = 48;

/**
 * recognizeLines(crops, onLine, prior) -> transcripts (one string per crop,
 * '' on a per-line failure — a single bad crop must not sink the page).
 * prior: transcripts from an interrupted read; those lines are reused, not
 * re-read. Consumed crop slots are nulled so a long page never holds every
 * line canvas at once (iOS memory kills). onLine(i, n, text) fires only for
 * freshly-read lines.
 */
export async function recognizeLines(crops, onLine, prior = []) {
  const ocr = await modelPromise;
  if (!ocr) throw new Error('Model not loaded — call loadModel() first.');
  const out = [];
  for (let i = 0; i < crops.length; i++) {
    if (i < prior.length) {
      out.push(prior[i]);
      crops[i] = null;
      continue;
    }
    let text = '';
    try {
      // Data URLs are the pipeline's most portable image input across
      // transformers.js versions; the PNG encode is a few ms per line.
      const result = await ocr(crops[i].toDataURL('image/png'), { max_new_tokens: MAX_NEW_TOKENS });
      text = (result?.[0]?.generated_text ?? '').trim();
    } catch (e) {
      lastError = e;
      text = '';
    }
    crops[i] = null; // release the consumed canvas immediately
    out.push(text);
    try { onLine && onLine(i, crops.length, text); } catch (_) {}
    await new Promise((r) => setTimeout(r, 0)); // let Safari's GC breathe
  }
  return out;
}

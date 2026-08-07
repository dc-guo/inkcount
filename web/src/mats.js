/* OpenCV.js runtime loading and Mat lifecycle. */

let initPromise = null;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' timed out after ' + Math.round(ms / 1000) + 's')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Load the vendored OpenCV.js build; resolves when the runtime is usable. */
export function loadOpenCV(timeoutMs = 60000) {
  if (!initPromise) {
    const url = new URL('../vendor/opencv.js', import.meta.url).href;
    initPromise = (async () => {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not fetch OpenCV.js from ' + url));
        document.head.appendChild(s);
      });
      const mod = window.cv;
      if (!mod) throw new Error('OpenCV.js script loaded but did not define "cv".');
      if (!mod.Mat) {
        // Emscripten MODULARIZE builds expose `cv` as a thenable that resolves
        // with ITSELF, so `await cv` (promise adoption) recurses forever and
        // never settles. Wait via a callback and resolve with undefined.
        await withTimeout(new Promise((resolve) => {
          const done = (m) => { if (m && m.Mat) window.cv = m; resolve(); };
          if (typeof mod.then === 'function') mod.then(done);
          else mod.onRuntimeInitialized = () => done(mod);
        }), timeoutMs, 'OpenCV.js runtime initialization');
      }
      if (!(window.cv && window.cv.Mat)) throw new Error('OpenCV.js loaded but its runtime is unavailable.');
    })();
  }
  return initPromise;
}

/** The cv global, or a readable error if it is not ready yet. */
export function requireCV() {
  if (!(window.cv && window.cv.Mat)) throw new Error('OpenCV.js is not loaded yet.');
  return window.cv;
}

/**
 * Run fn with a scope that tracks Mats/MatVectors; everything tracked is
 * released when fn settles, even on exceptions.
 */
export async function withMats(fn) {
  const scope = {
    tracked: [],
    track(m) { this.tracked.push(m); return m; },
  };
  try {
    return await fn(scope);
  } finally {
    for (const m of scope.tracked) {
      try { m.delete(); } catch (_) { /* already deleted */ }
    }
  }
}

/** Yield to the event loop so the UI can paint between pipeline stages. */
export function yieldUI() {
  return new Promise((r) => setTimeout(r, 0));
}

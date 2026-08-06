/*
 * InkCount — client-side port of cv_utils.py / app.py.
 *
 * Parity contract: every parameter and control-flow decision below mirrors the
 * Python reference implementation in this repository (cv_utils.py, app.py).
 * Do not tune values here without changing the Python reference first.
 * OpenCV.js build: 4.9.0 (vendored at ./vendor/opencv.js).
 *
 * Structure: analyzeCore() is pure pipeline (no DOM) and also runs under Node
 * for headless parity tests; analyzeCanvas() wraps it with canvas I/O and
 * preview rendering for the browser UI.
 */
(function () {
  'use strict';

  const GLOBAL = (typeof window !== 'undefined') ? window : globalThis;

  let initPromise = null;

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(label + ' timed out after ' + Math.round(ms / 1000) + 's')), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  function init(opencvUrl, timeoutMs) {
    if (!initPromise) {
      const url = opencvUrl || './vendor/opencv.js';
      const limit = timeoutMs || 45000;
      initPromise = (async () => {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = url;
          s.async = true;
          s.onload = resolve;
          s.onerror = () => reject(new Error('Could not fetch OpenCV.js from ' + url));
          document.head.appendChild(s);
        });
        const mod = GLOBAL.cv;
        if (!mod) throw new Error('OpenCV.js script loaded but did not define "cv".');
        if (!mod.Mat) {
          // Emscripten MODULARIZE builds expose `cv` as a thenable that resolves
          // with ITSELF, so `await cv` (promise adoption) recurses forever and
          // never settles. Wait via a callback and resolve with undefined instead.
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('OpenCV.js runtime initialization timed out after ' + Math.round(limit / 1000) + 's')), limit);
            const done = (m) => {
              clearTimeout(t);
              if (m && m.Mat) GLOBAL.cv = m; // real-Promise builds resolve with the module
              resolve();
            };
            if (typeof mod.then === 'function') mod.then(done);
            else mod.onRuntimeInitialized = () => done(mod);
          });
        }
        if (!(GLOBAL.cv && GLOBAL.cv.Mat)) throw new Error('OpenCV.js loaded but its runtime is unavailable.');
      })();
    }
    return initPromise;
  }

  function requireCV() {
    if (!(GLOBAL.cv && GLOBAL.cv.Mat)) throw new Error('OpenCV.js is not loaded yet.');
    return GLOBAL.cv;
  }

  // ---------------------------------------------------------------
  // Mat lifecycle: every pipeline run happens inside withMats(); all
  // tracked Mats/MatVectors are released even when a stage throws.
  // ---------------------------------------------------------------
  async function withMats(fn) {
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

  function yieldUI() {
    return new Promise((r) => setTimeout(r, 0));
  }

  async function loadImageToCanvas(source) {
    let blob = source;
    if (typeof source === 'string') {
      const resp = await fetch(source);
      if (!resp.ok) throw new Error('Could not fetch image: ' + source + ' (HTTP ' + resp.status + ')');
      blob = await resp.blob();
    }
    let bmp;
    try {
      bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    } catch (_) {
      bmp = await createImageBitmap(blob);
    }
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return canvas;
  }

  // ---------------------------------------------------------------
  // NumPy equivalents (typed-array loops)
  // ---------------------------------------------------------------

  function convolveSame(arr, k) {
    // np.convolve(arr, np.ones(k)/k, 'same') for arr.length >= k.
    // For arr.length < k the line detector provably yields 0 lines either way
    // (min peak height is >= 15), so same-length output is safe there too.
    const M = arr.length;
    const s = Math.floor((k - 1) / 2);
    const inv = 1 / k;
    const out = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const lo = Math.max(0, i + s - k + 1);
      const hi = Math.min(M - 1, i + s);
      let acc = 0;
      for (let m = lo; m <= hi; m++) acc += arr[m] * inv;
      out[i] = acc;
    }
    return out;
  }

  function rowSums(mat) {
    if (!mat.isContinuous()) throw new Error('rowSums requires a continuous Mat');
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

  function roiColSums(mat, x, y, w, h) {
    if (!mat.isContinuous()) throw new Error('roiColSums requires a continuous Mat');
    const cols = mat.cols, data = mat.data;
    const out = new Float64Array(w);
    for (let r = 0; r < h; r++) {
      const base = (y + r) * cols + x;
      for (let c = 0; c < w; c++) out[c] += data[base + c];
    }
    return out;
  }

  // ---------------------------------------------------------------
  // Pipeline port (mirrors cv_utils.py)
  // ---------------------------------------------------------------

  function preprocessFromRGBA(srcRGBA, scope) {
    const cv = requireCV();
    const gray = scope.track(new cv.Mat());
    cv.cvtColor(srcRGBA, gray, cv.COLOR_RGBA2GRAY); // true-luminance weights, same as Python stage 1
    const enhanced = scope.track(new cv.Mat());
    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(gray, enhanced);
    clahe.delete();
    const blur = scope.track(new cv.Mat());
    cv.GaussianBlur(enhanced, blur, new cv.Size(9, 9), 10.0);
    const sharpened = scope.track(new cv.Mat());
    cv.addWeighted(enhanced, 1.5, blur, -0.5, 0, sharpened);
    return sharpened;
  }

  function extractLineBoundingBoxes(preGray, scope) {
    const cv = requireCV();
    const imgH = preGray.rows, imgW = preGray.cols;

    const blur = scope.track(new cv.Mat());
    cv.GaussianBlur(preGray, blur, new cv.Size(5, 5), 0);
    const thresh = scope.track(new cv.Mat());
    cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 15);

    // Contour engine: feeds the blue debug fragments and the global x-margins only.
    const kernel = scope.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(
      Math.max(10, Math.trunc(imgW * 0.05)), Math.max(2, Math.trunc(imgH * 0.002)))));
    const dilated = scope.track(new cv.Mat());
    cv.dilate(thresh, dilated, kernel, new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    const contours = scope.track(new cv.MatVector());
    const hierarchy = scope.track(new cv.Mat());
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const rawBoxes = [];
    const minH = Math.max(3, Math.trunc(imgH * 0.001));
    const minW = Math.max(10, Math.trunc(imgW * 0.005));
    const rawContourCount = contours.size();
    for (let i = 0; i < rawContourCount; i++) {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      c.delete();
      if (r.width >= minW && r.height >= minH) rawBoxes.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
    rawBoxes.sort((a, b) => a.y - b.y);

    // Full-page horizontal projection over the UN-dilated threshold.
    const hProj = rowSums(thresh);
    const smoothed = convolveSame(hProj, Math.max(5, Math.trunc(imgH * 0.015)));
    let maxSm = 0;
    for (let i = 0; i < smoothed.length; i++) if (smoothed[i] > maxSm) maxSm = smoothed[i];
    const noiseThresh = Math.max(maxSm * 0.05, 255 * 5);

    const peaks = [];
    let inPeak = false, peakStart = 0;
    for (let row = 0; row < imgH; row++) {
      if (smoothed[row] > noiseThresh) {
        if (!inPeak) { inPeak = true; peakStart = row; }
      } else if (inPeak) {
        inPeak = false;
        peaks.push([peakStart, row]);
      }
    }
    if (inPeak) peaks.push([peakStart, imgH]);

    let gxMin = 5, gxMax = imgW - 5;
    if (rawBoxes.length > 0) {
      gxMin = Math.min.apply(null, rawBoxes.map((b) => b.x));
      gxMax = Math.max.apply(null, rawBoxes.map((b) => b.x + b.w));
    }
    const gW = gxMax - gxMin;

    const mergedBoxes = [], originalBands = [];
    const minPeakH = Math.max(15, Math.trunc(imgH * 0.005));
    for (const peak of peaks) {
      const pStart = peak[0], pEnd = peak[1];
      const h = pEnd - pStart;
      if (h < minPeakH) continue;
      originalBands.push({ x: gxMin, y: pStart, w: gW, h: h });
      const padY = Math.max(4, Math.trunc(h * 0.15));
      mergedBoxes.push({ x: gxMin, y: Math.max(0, pStart - padY), w: gW, h: h + padY * 2 });
    }

    return { mergedBoxes, rawBoxes, originalBands, rawContourCount, thresh, dilated };
  }

  function extractWordClusters(cropRGBA, scope) {
    const cv = requireCV();
    const cropH = cropRGBA.rows, cropW = cropRGBA.cols;
    if (cropH === 0 || cropW === 0) return { wordBoxes: [], thresh: null, dilated: null };

    // QUIRK Q1 (deliberate, bit-exact parity with the Python app): app.py feeds an
    // RGB crop into cv2.COLOR_BGR2GRAY, swapping the R/B weights. COLOR_BGRA2GRAY
    // on our RGBA crop reproduces exactly that. Do NOT "fix" to COLOR_RGBA2GRAY.
    const gray = scope.track(new cv.Mat());
    cv.cvtColor(cropRGBA, gray, cv.COLOR_BGRA2GRAY);

    const blur = scope.track(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const thresh = scope.track(new cv.Mat());
    cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 10);

    const kernel = scope.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(
      Math.max(6, Math.trunc(cropW * 0.008)), Math.max(2, Math.trunc(cropH * 0.06)))));
    const dilated = scope.track(new cv.Mat());
    cv.dilate(thresh, dilated, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    const contours = scope.track(new cv.MatVector());
    const hierarchy = scope.track(new cv.Mat());
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const wordBoxes = [];
    const minW = Math.max(4, Math.trunc(cropH * 0.1));
    const minH = Math.max(4, Math.trunc(cropH * 0.15));
    const minGap = Math.max(3, Math.trunc(cropW * 0.003));

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      c.delete();
      const xc = r.x, yc = r.y, wc = r.width, hc = r.height;
      if (wc < minW || hc < minH) continue;

      if (wc > cropW * 0.25) {
        const vProj = roiColSums(thresh, xc, yc, wc, hc);
        const splits = [];
        let inGap = false, gapStart = 0;
        for (let col = 0; col < wc; col++) {
          if (vProj[col] === 0) {
            if (!inGap) { inGap = true; gapStart = col; }
          } else if (inGap) {
            inGap = false;
            const gapWidth = col - gapStart;
            if (gapWidth >= minGap) splits.push(gapStart + Math.trunc(gapWidth / 2));
          }
        }
        if (splits.length > 0) {
          let currentX = 0;
          for (const split of splits) {
            const subW = split - currentX;
            if (subW >= minW) wordBoxes.push({ x: xc + currentX, y: yc, w: subW, h: hc });
            currentX = split;
          }
          const tailW = wc - currentX;
          if (tailW >= minW) wordBoxes.push({ x: xc + currentX, y: yc, w: tailW, h: hc });
          continue;
        }
      }
      wordBoxes.push({ x: xc, y: yc, w: wc, h: hc });
    }

    wordBoxes.sort((a, b) => a.x - b.x);
    return { wordBoxes, thresh, dilated };
  }

  // ---------------------------------------------------------------
  // Core orchestrator — pure pipeline, no DOM. Mirrors app.py's
  // two-step driver as one pass. Runs in browser AND Node.
  // Caller owns srcRGBA; everything created here is scope-tracked.
  // ---------------------------------------------------------------

  async function analyzeCore(srcRGBA, scope, onProgress) {
    const cv = requireCV();
    const progress = onProgress || (() => {});

    progress('preprocess', 0, 1);
    let resized = srcRGBA;
    if (resized.cols > 2000) {
      const ratio = 2000 / resized.cols;
      const r = scope.track(new cv.Mat());
      cv.resize(resized, r, new cv.Size(2000, Math.trunc(resized.rows * ratio)), 0, 0, cv.INTER_AREA);
      resized = r;
    }
    const sharpened = preprocessFromRGBA(resized, scope);
    await yieldUI();

    progress('lines', 0, 1);
    const seg = extractLineBoundingBoxes(sharpened, scope);
    await yieldUI();

    const H = resized.rows, W = resized.cols;
    const perLine = [], lineRuns = [];
    let total = 0;
    for (let idx = 0; idx < seg.mergedBoxes.length; idx++) {
      progress('words', idx, seg.mergedBoxes.length);
      const b = seg.mergedBoxes[idx];
      const y1 = Math.max(0, b.y), y2 = Math.min(H, b.y + b.h);
      const x1 = Math.max(0, b.x), x2 = Math.min(W, b.x + b.w);
      const cw = x2 - x1, ch = y2 - y1;
      let words = { wordBoxes: [], thresh: null, dilated: null };
      let crop = null;
      if (cw > 0 && ch > 0) {
        const roi = resized.roi(new cv.Rect(x1, y1, cw, ch));
        crop = scope.track(roi.clone());
        roi.delete();
        words = extractWordClusters(crop, scope);
      }
      total += words.wordBoxes.length;
      perLine.push(words.wordBoxes.length);
      lineRuns.push({ crop, words, width: cw, height: ch });
      await yieldUI();
    }
    progress('done', 1, 1);

    return {
      resized, seg, lineRuns,
      width: W, height: H,
      lines: seg.mergedBoxes.length,
      rawContourCount: seg.rawContourCount,
      perLine, total,
      mergedBoxes: seg.mergedBoxes.map((b) => [b.x, b.y, b.w, b.h]),
    };
  }

  // ---------------------------------------------------------------
  // Preview renderers (Canvas 2D — cosmetic only; counts come solely
  // from the pipeline above). Browser-only.
  // ---------------------------------------------------------------

  function matToCanvas(mat) {
    const cv = requireCV();
    const c = document.createElement('canvas');
    cv.imshow(c, mat);
    return c;
  }

  function drawSegmentationPreview(resized, seg) {
    const c = matToCanvas(resized);
    const ctx = c.getContext('2d');
    const H = resized.rows, W = resized.cols;
    const thickness = Math.max(2, Math.trunc(H * 0.003));
    ctx.fillStyle = 'rgba(255, 150, 0, 0.2)';
    for (const b of seg.originalBands) ctx.fillRect(0, b.y, W, b.h);
    ctx.strokeStyle = '#1e6fd9';
    ctx.lineWidth = Math.max(1, Math.trunc(thickness / 2));
    for (const b of seg.rawBoxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = '#18a34a';
    ctx.fillStyle = '#18a34a';
    ctx.lineWidth = thickness * 2;
    ctx.font = 'bold ' + Math.max(16, thickness * 8) + 'px system-ui, sans-serif';
    seg.mergedBoxes.forEach((b, i) => {
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.fillText('Line ' + (i + 1) + ' (' + b.w + 'px x ' + b.h + 'px)', b.x, Math.max(15, b.y - Math.max(5, thickness * 2)));
    });
    return c;
  }

  function drawWordOverlay(cropMat, boxes, cropH) {
    const c = matToCanvas(cropMat);
    const ctx = c.getContext('2d');
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = Math.max(1, Math.trunc(cropH * 0.03));
    for (const b of boxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
    return c;
  }

  // Browser wrapper: canvas in, previews out.
  async function analyzeCanvas(canvas, onProgress) {
    const cv = requireCV();
    return withMats(async (scope) => {
      const src = scope.track(cv.imread(canvas)); // CV_8UC4 RGBA
      const core = await analyzeCore(src, scope, onProgress);
      return {
        width: core.width, height: core.height,
        lines: core.lines, rawContourCount: core.rawContourCount,
        perLine: core.perLine, total: core.total, mergedBoxes: core.mergedBoxes,
        originalCanvas: matToCanvas(core.resized),
        segmentationCanvas: drawSegmentationPreview(core.resized, core.seg),
        threshCanvas: matToCanvas(core.seg.thresh),
        dilatedCanvas: matToCanvas(core.seg.dilated),
        lineDetails: core.lineRuns.map((run) => ({
          count: run.words.wordBoxes.length, width: run.width, height: run.height,
          overlayCanvas: run.crop ? drawWordOverlay(run.crop, run.words.wordBoxes, run.height) : null,
          threshCanvas: run.words.thresh ? matToCanvas(run.words.thresh) : null,
          dilatedCanvas: run.words.dilated ? matToCanvas(run.words.dilated) : null,
        })),
      };
    });
  }

  GLOBAL.CVPort = {
    init, requireCV, withMats, yieldUI, loadImageToCanvas,
    convolveSame, rowSums, roiColSums,
    preprocessFromRGBA, extractLineBoundingBoxes, extractWordClusters,
    analyzeCore, analyzeCanvas,
    matToCanvas, drawSegmentationPreview, drawWordOverlay,
  };

  // ---------------------------------------------------------------
  // UI layer — active only on the real app page (#app present), so
  // test pages can load this file without side effects.
  // ---------------------------------------------------------------

  function initUI() {
    const $ = (id) => document.getElementById(id);
    const els = {
      fileInput: $('file-input'), dropZone: $('drop-zone'),
      sampleMeeting: $('btn-sample-meeting'), sampleLecture: $('btn-sample-lecture'),
      target: $('target-input'), run: $('btn-run'), reset: $('btn-reset'),
      status: $('status-text'), progress: $('progress'), error: $('error-banner'),
      activeLabel: $('active-image-label'),
      original: $('canvas-original'), segmentation: $('canvas-segmentation'),
      results: $('results-section'), banner: $('result-banner'),
      total: $('result-total'), lines: $('result-lines'), lineResults: $('line-results'),
      previews: $('previews-section'),
    };

    const state = { canvas: null, name: null, source: null, result: null, running: false, loading: false, cvReady: false };

    function setStatus(text) { els.status.textContent = text; }

    function showError(message) {
      els.error.textContent = message;
      els.error.hidden = false;
    }

    function hideError() { els.error.hidden = true; }

    function slot(container, canvas) {
      container.replaceChildren(canvas);
    }

    function updateRunEnabled() {
      // `loading` matters: without it, Run stays enabled while a newly chosen
      // image is still being fetched and would analyze the previous image.
      els.run.disabled = !(state.cvReady && state.canvas && !state.running && !state.loading);
    }

    function clearResults() {
      state.result = null;
      els.results.hidden = true;
      els.previews.hidden = true;
      els.segmentation.replaceChildren();
      els.lineResults.replaceChildren();
      els.progress.hidden = true;
    }

    function setActiveImage(canvas, name, source) {
      state.canvas = canvas;
      state.name = name;
      state.source = source;
      clearResults();
      hideError();
      slot(els.original, canvas);
      els.activeLabel.textContent = source + ' — ' + name + ' (' + canvas.width + ' × ' + canvas.height + ' px)';
      setStatus(state.cvReady ? 'Ready — press Run Analysis.' : 'Image loaded. Waiting for OpenCV.js…');
      updateRunEnabled();
    }

    function targetValue() {
      const v = parseInt(els.target.value, 10);
      return Number.isFinite(v) && v >= 1 ? v : 1;
    }

    function updateBanner() {
      if (!state.result) return;
      const t = targetValue();
      const n = state.result.total;
      const pass = n >= t;
      els.banner.className = 'banner ' + (pass ? 'banner-pass' : 'banner-fail');
      els.banner.textContent = (pass ? 'PASS' : 'FAIL') + ' — target ' + t + ' words · tracked ' + n + ' distinct clusters';
    }

    function renderResult(result, elapsedS) {
      state.result = result;
      if (result.lines === 0) {
        showError('0 document rows detected on this image. Try a clearer photo with distinct handwritten lines.');
        setStatus('Done in ' + elapsedS + 's — no rows found.');
        return;
      }
      els.results.hidden = false;
      els.previews.hidden = false;
      updateBanner();
      els.total.textContent = String(result.total);
      els.lines.textContent = String(result.lines);
      slot(els.original, result.originalCanvas);
      slot(els.segmentation, result.segmentationCanvas);

      els.lineResults.replaceChildren();
      result.lineDetails.forEach((line, i) => {
        const block = document.createElement('div');
        block.className = 'line-block';
        const h = document.createElement('h4');
        h.textContent = 'Line ' + (i + 1) + ' — ' + line.count + ' clusters (' + line.width + ' × ' + line.height + ' px)';
        block.appendChild(h);
        if (line.overlayCanvas) {
          const fig = document.createElement('figure');
          fig.appendChild(line.overlayCanvas);
          const cap = document.createElement('figcaption');
          cap.textContent = 'Word clusters (red boxes)';
          fig.appendChild(cap);
          block.appendChild(fig);
        }
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = 'Debug: threshold + dilation mask';
        det.appendChild(sum);
        if (line.threshCanvas) {
          const f1 = document.createElement('figure');
          f1.appendChild(line.threshCanvas);
          const c1 = document.createElement('figcaption');
          c1.textContent = '1. Pure threshold';
          f1.appendChild(c1);
          det.appendChild(f1);
        }
        if (line.dilatedCanvas) {
          const f2 = document.createElement('figure');
          f2.appendChild(line.dilatedCanvas);
          const c2 = document.createElement('figcaption');
          c2.textContent = '2. Dilation mask';
          f2.appendChild(c2);
          det.appendChild(f2);
        }
        block.appendChild(det);
        els.lineResults.appendChild(block);
      });
      setStatus('Done in ' + elapsedS + 's.');
    }

    async function run() {
      if (state.running || !state.canvas) return;
      state.running = true;
      hideError();
      clearResults();
      updateRunEnabled();
      els.reset.disabled = true;
      const t0 = performance.now();
      try {
        const result = await CVPort.analyzeCanvas(state.canvas, (stage, i, n) => {
          if (stage === 'preprocess') setStatus('Preprocessing image…');
          else if (stage === 'lines') setStatus('Segmenting document rows…');
          else if (stage === 'words') {
            setStatus('Analyzing line ' + (i + 1) + ' of ' + n + '…');
            els.progress.hidden = false;
            els.progress.max = n;
            els.progress.value = i;
          } else if (stage === 'done') {
            els.progress.hidden = true;
          }
        });
        const elapsedS = ((performance.now() - t0) / 1000).toFixed(2);
        renderResult(result, elapsedS);
      } catch (e) {
        showError('Analysis failed: ' + (e && e.message ? e.message : String(e)));
        setStatus('Error.');
      } finally {
        state.running = false;
        els.reset.disabled = false;
        updateRunEnabled();
      }
    }

    function reset() {
      state.canvas = null;
      state.name = null;
      state.source = null;
      state.loading = false;
      clearResults();
      hideError();
      els.fileInput.value = '';
      els.original.replaceChildren();
      els.activeLabel.textContent = 'No image loaded.';
      setStatus(state.cvReady ? 'Ready — load an image.' : 'Loading OpenCV.js…');
      updateRunEnabled();
    }

    async function loadInto(source, name, label, loadingMessage) {
      state.loading = true;
      updateRunEnabled();
      setStatus(loadingMessage);
      try {
        const canvas = await CVPort.loadImageToCanvas(source);
        state.loading = false;
        setActiveImage(canvas, name, label);
      } catch (e) {
        state.loading = false;
        updateRunEnabled();
        setStatus('Ready — load an image.');
        showError('Could not load that image: ' + (e && e.message ? e.message : String(e)));
      }
    }

    function useFile(file) {
      if (!file) return;
      if (!/\.(jpe?g|png)$/i.test(file.name) && !/^image\/(jpeg|png)$/.test(file.type)) {
        showError('Unsupported file type. Please choose a JPG or PNG image.');
        return;
      }
      return loadInto(file, file.name, 'Uploaded file', 'Reading image…');
    }

    function useSample(name) {
      return loadInto('./samples/' + name, name, 'Built-in sample', 'Loading sample image…');
    }

    els.fileInput.addEventListener('change', () => useFile(els.fileInput.files[0]));
    els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('dragging'); });
    els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragging'));
    els.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('dragging');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) useFile(e.dataTransfer.files[0]);
    });
    els.sampleMeeting.addEventListener('click', () => useSample('demo_meeting.jpg'));
    els.sampleLecture.addEventListener('click', () => useSample('demo_lecture.jpg'));
    els.run.addEventListener('click', run);
    els.reset.addEventListener('click', reset);
    els.target.addEventListener('input', updateBanner);

    setStatus('Loading OpenCV.js…');
    updateRunEnabled();
    init('./vendor/opencv.js').then(() => {
      state.cvReady = true;
      if (!/ — Ready$/.test(document.title)) document.title += ' — Ready';
      setStatus(state.canvas ? 'Ready — press Run Analysis.' : 'Ready — load an image.');
      updateRunEnabled();
    }).catch((e) => {
      showError('OpenCV.js failed to load: ' + (e && e.message ? e.message : String(e)) +
        ' — the analyzer cannot run. Check your connection to this site and reload the page.');
      setStatus('OpenCV.js unavailable.');
    });
  }

  if (typeof document !== 'undefined') {
    const boot = () => { if (document.getElementById('app')) initUI(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();

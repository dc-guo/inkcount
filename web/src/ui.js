/* UI wiring: decode → preprocess → segment → instant geometric estimate →
 * recognition model → accurate count, with the transcript as the trust surface. */
import { loadOpenCV, requireCV, withMats } from './mats.js';
import { decodeToCanvas } from './decode.js';
import { preprocess } from './preprocess.js';
import { segmentLines } from './segment.js';
import { estimateWords } from './geometric.js';
import { loadModel, recognizeLines } from './recognize.js';
import { countWords } from './count.js';

export function initUI() {
  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $('file-input'), dropZone: $('drop-zone'), sample: $('btn-sample'),
    run: $('btn-run'), reset: $('btn-reset'),
    status: $('status-text'), progress: $('progress'), error: $('error-banner'),
    label: $('active-image-label'), imageSlot: $('image-slot'),
    total: $('result-total'), sub: $('result-sub'),
    transcriptCard: $('transcript-card'), transcriptList: $('transcript-list'),
    overlayCard: $('overlay-card'), overlaySlot: $('overlay-slot'), overlayCaption: $('overlay-caption'),
  };

  const state = { canvas: null, name: null, running: false, loading: false, cvReady: false };

  const setStatus = (t) => { els.status.textContent = t; };
  const showError = (m) => { els.error.textContent = m; els.error.hidden = false; };
  const hideError = () => { els.error.hidden = true; };

  function updateRunEnabled() {
    els.run.disabled = !(state.cvReady && state.canvas && !state.running && !state.loading);
  }

  function clearResults() {
    els.total.textContent = '—';
    els.sub.textContent = 'Choose a page and press Count.';
    els.transcriptCard.hidden = true;
    els.overlayCard.hidden = true;
    els.transcriptList.replaceChildren();
    els.overlaySlot.replaceChildren();
    els.progress.hidden = true;
  }

  function showCount(n, sub) {
    els.total.textContent = String(n);
    els.sub.textContent = sub;
  }

  async function loadInto(source, name, loadingMessage) {
    state.loading = true;
    updateRunEnabled();
    setStatus(loadingMessage);
    hideError();
    try {
      const canvas = await decodeToCanvas(source);
      state.canvas = canvas;
      state.name = name;
      clearResults();
      els.imageSlot.replaceChildren(canvas);
      els.label.textContent = name + ' · ' + canvas.width + ' × ' + canvas.height + ' px';
      state.loading = false;
      setStatus(state.cvReady ? 'Ready — press Count words.' : 'Image loaded. Preparing the analyzer…');
    } catch (e) {
      state.loading = false;
      setStatus('Ready.');
      showError(e && e.message ? e.message : String(e));
    }
    updateRunEnabled();
  }

  function drawOverlay(grayMat, lineRects, wordBoxes) {
    const cv = requireCV();
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, grayMat);
    const ctx = canvas.getContext('2d');
    // Word blobs first (fill + thin warm stroke), line boxes on top (bold violet
    // with a translucent wash) so both read clearly even on busy photos.
    ctx.fillStyle = 'rgba(246, 155, 60, 0.18)';
    ctx.strokeStyle = 'rgba(214, 116, 15, 0.9)';
    ctx.lineWidth = Math.max(1, Math.round(canvas.height * 0.0012));
    for (const b of wordBoxes || []) {
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    ctx.fillStyle = 'rgba(124, 92, 224, 0.07)';
    ctx.strokeStyle = '#6a45d8';
    ctx.lineWidth = Math.max(3, Math.round(canvas.height * 0.0035));
    for (const r of lineRects) {
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    return canvas;
  }

  function renderTranscript(transcripts, perLine, lowConfidence) {
    els.transcriptList.replaceChildren();
    transcripts.forEach((text, i) => {
      const li = document.createElement('li');
      if (text) {
        li.textContent = text;
      } else {
        const span = document.createElement('span');
        span.className = 't-empty';
        span.textContent = '(nothing readable)';
        li.appendChild(span);
      }
      const count = document.createElement('span');
      count.className = 't-count';
      count.textContent = '· ' + perLine[i] + (perLine[i] === 1 ? ' word' : ' words') +
        (lowConfidence[i] ? ' · not counted' : '');
      li.appendChild(count);
      if (lowConfidence[i]) {
        const warn = document.createElement('span');
        warn.className = 'chip chip-warn';
        warn.textContent = 'check';
        warn.style.marginLeft = '0.4rem';
        li.appendChild(warn);
      }
      els.transcriptList.appendChild(li);
    });
    els.transcriptCard.hidden = false;
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
      // Stage 1: straighten and segment. (Geometry is used for the overlay's
      // word boxes only — never for a displayed count: rough estimates were
      // wildly wrong on non-handwriting images, e.g. 230 on an illustration.)
      setStatus('Straightening and reading the page layout…');
      const staged = await withMats(async (scope) => {
        const pre = preprocess(state.canvas, scope);
        const segs = segmentLines(pre, scope);
        const est = estimateWords(pre, segs);
        const overlay = drawOverlay(pre.gray, segs.map((s) => s.rect), est.boxes);
        return { crops: segs.map((s) => s.canvas), overlay, skew: pre.skewAngle, lines: segs.length };
      });

      els.overlaySlot.replaceChildren(staged.overlay);
      staged.overlay.title = 'Open full size';
      staged.overlay.addEventListener('click', () => {
        staged.overlay.toBlob((blob) => {
          if (blob) window.open(URL.createObjectURL(blob), '_blank');
        }, 'image/png');
      });
      els.overlayCaption.textContent = staged.lines === 0
        ? 'No handwritten lines were found on this image — nothing is boxed. InkCount looks for rows of English handwriting; drawings, printed pages, and non-English text won\'t register.'
        : staged.lines + ' line' + (staged.lines > 1 ? 's' : '') + ' detected on the straightened page — violet boxes are counted lines, amber patches are the ink clusters inside them.';
      els.overlayCard.hidden = false;

      if (staged.lines === 0) {
        showCount(0, 'No handwritten lines were detected on this image.');
        showError('InkCount could not find any handwritten lines. Try a clearer, closer photo of a handwritten page (English only).');
        setStatus('Done.');
        return;
      }

      els.sub.textContent = staged.lines + ' line' + (staged.lines > 1 ? 's' : '') + ' found — reading them now…';

      // Stage 2: recognition model (downloads once, then cached by the browser).
      setStatus('Loading the handwriting reader…');
      els.progress.hidden = false;
      els.progress.removeAttribute('max');
      els.progress.removeAttribute('value');
      await loadModel((p) => {
        if (p && p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
          els.progress.max = 100;
          els.progress.value = Math.round(p.progress || 0);
          setStatus('Downloading the handwriting reader (one-time)… ' + Math.round(p.progress || 0) + '%');
        }
      });

      // Stage 3: read every line, streaming the running count with the same
      // hallucination-exclusion rules as the final tally.
      els.progress.max = staged.crops.length;
      els.progress.value = 0;
      const seen = [];
      const transcripts = await recognizeLines(staged.crops, (i, n, text) => {
        seen.push(text);
        els.progress.value = i + 1;
        setStatus('Reading line ' + (i + 1) + ' of ' + n + '…');
        showCount(countWords(seen).total, 'so far — reading line ' + (i + 1) + ' of ' + n + '…');
      });

      const { total, perLine, lowConfidence } = countWords(transcripts);
      const flagged = lowConfidence.filter(Boolean).length;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      showCount(total,
        'words on this page · ' + staged.lines + ' line' + (staged.lines > 1 ? 's' : '') + ' · ' + secs + 's' +
        (flagged ? ' · ' + flagged + ' line' + (flagged > 1 ? 's' : '') + ' not counted' : ''));
      renderTranscript(transcripts, perLine, lowConfidence);
      els.progress.hidden = true;
      setStatus('Done in ' + secs + 's.');
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      showError('Analysis failed: ' + msg);
      setStatus('Error.');
      showCount('—', 'Something went wrong.');
      els.progress.hidden = true;
    } finally {
      state.running = false;
      els.reset.disabled = false;
      updateRunEnabled();
    }
  }

  function reset() {
    state.canvas = null;
    state.name = null;
    state.loading = false;
    clearResults();
    hideError();
    els.fileInput.value = '';
    els.imageSlot.replaceChildren();
    els.label.textContent = 'No image loaded.';
    setStatus(state.cvReady ? 'Ready — add a page.' : 'Preparing the analyzer…');
    updateRunEnabled();
  }

  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files[0];
    if (f) loadInto(f, f.name, 'Reading image…');
  });
  els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('dragging'); });
  els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragging'));
  els.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('dragging');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadInto(f, f.name, 'Reading image…');
  });
  els.sample.addEventListener('click', async () => {
    try {
      const resp = await fetch('./samples/sample_page.jpg');
      if (!resp.ok) throw new Error('sample missing (HTTP ' + resp.status + ')');
      await loadInto(await resp.blob(), 'sample_page.jpg', 'Loading sample…');
    } catch (e) {
      showError('Could not load the sample: ' + (e && e.message ? e.message : String(e)));
    }
  });
  els.run.addEventListener('click', run);
  els.reset.addEventListener('click', reset);

  setStatus('Preparing the analyzer…');
  updateRunEnabled();
  loadOpenCV().then(() => {
    state.cvReady = true;
    if (!/ — Ready$/.test(document.title)) document.title += ' — Ready';
    setStatus(state.canvas ? 'Ready — press Count words.' : 'Ready — add a page.');
    updateRunEnabled();
  }).catch((e) => {
    showError('The analyzer failed to load: ' + (e && e.message ? e.message : String(e)) + ' — reload the page to retry.');
    setStatus('Analyzer unavailable.');
  });
}

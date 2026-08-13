/* UI wiring: decode → preprocess → segment → instant geometric estimate →
 * recognition model → accurate count, with the transcript as the trust surface. */
import { loadOpenCV, requireCV, withMats } from './mats.js';
import { decodeToCanvas } from './decode.js';
import { preprocess } from './preprocess.js';
import { segmentLines } from './segment.js';
import { estimateWords } from './geometric.js';
import { loadModel, recognizeLines } from './recognize.js';
import { countWords } from './count.js';
import { newEntry, loadEntry, saveEntry, clearEntry, entryTotal, makeThumb, loadHistory, saveToHistory, deleteHistoryRow, clearHistory, isEntrySaved, storageAvailable } from './store.js';
import { evaluatePreflight, medianLuminance } from './preflight.js';
import { renderHistory } from './history.js';

/* Bumped together with the <meta name="inkcount-version"> in index.html on
 * every release. GitHub Pages caches assets for ~10 minutes, so right after a
 * deploy a browser can pair fresh HTML with stale JS (or vice versa) — which
 * crashed with "Cannot set properties of null" when this code addressed an
 * element the other version didn't have. Detect the mismatch and self-heal. */
const APP_VERSION = '8';

export function initUI() {
  const $ = (id) => document.getElementById(id);

  const htmlVersion = (document.querySelector('meta[name="inkcount-version"]') || {}).content;
  if (htmlVersion !== APP_VERSION) {
    const KEY = 'inkcount-version-reload';
    if (sessionStorage.getItem(KEY) !== APP_VERSION + '/' + htmlVersion) {
      sessionStorage.setItem(KEY, APP_VERSION + '/' + htmlVersion);
      location.reload();
      return;
    }
    // Reload didn't clear it — ask the user for a hard refresh instead of
    // limping along and crashing with a cryptic null error.
    const err = $('error-banner');
    if (err) {
      err.textContent = 'InkCount just updated and your browser is mixing old and new files. ' +
        'Please hard-refresh this page (Ctrl+Shift+R, or hold Reload on mobile).';
      err.hidden = false;
    }
    return;
  }
  const els = {
    fileInput: $('file-input'), cameraInput: $('camera-input'), dropZone: $('drop-zone'), sample: $('btn-sample'),
    run: $('btn-run'), reset: $('btn-reset'), newEntryBtn: $('btn-new-entry'),
    status: $('status-text'), progress: $('progress'), error: $('error-banner'),
    label: $('active-image-label'), imageSlot: $('image-slot'), inputTitle: $('input-title'),
    warnings: $('preflight-warnings'), pagesStrip: $('pages-strip'),
    total: $('result-total'), sub: $('result-sub'),
    transcriptCard: $('transcript-card'), transcriptList: $('transcript-list'),
    overlayCard: $('overlay-card'), overlaySlot: $('overlay-slot'), overlayCaption: $('overlay-caption'),
    saveEntryBtn: $('btn-save-entry'), historyCard: $('history-card'), historyList: $('history-list'), clearHistoryBtn: $('btn-clear-history'),
  };

  const state = { entry: null, selectedPage: -1, photo: null, running: false, loading: false, cvReady: false, memoryOnly: false };
  // photo, mid-decode: { canvas, name, crops: null, fromStash } | null
  // photo, staged (post analyzePhoto): { name, crops, lines, skewAngle, textHeight, rejectedCount,
  //   thumb, overlayJpeg, preview, fromStash } — no canvas fields. analyzePhoto() snapshots the
  //   JPEGs the rest of the flow needs and drops the full-res canvas, because during the model
  //   read the only pixel data allowed to stay alive is the line crops (released one by one).

  const setStatus = (t) => { els.status.textContent = t; };
  const showError = (m) => { els.error.textContent = m; els.error.hidden = false; };
  const hideError = () => { els.error.hidden = true; };

  // Raw JS internals ("Cannot set properties of null") must never be the whole
  // message a student sees. Give context, and when the error smells like
  // stale-cache version skew, say what actually fixes it.
  function humanError(context, e) {
    const raw = e && e.message ? e.message : String(e);
    if (/Cannot (set|read) propert/i.test(raw)) {
      return context + ' because the app\'s files are out of sync — this can happen for a few ' +
        'minutes right after InkCount updates. Hard-refresh the page (Ctrl+Shift+R) to clear it.';
    }
    return context + '. Details: ' + raw;
  }

  const DEBUG = new URLSearchParams(location.search).has('debug');

  function updateRunEnabled() {
    els.run.disabled = !(state.cvReady && state.photo && state.photo.crops &&
      state.photo.lines > 0 && !state.running && !state.loading);
  }

  function inlineConfirm(trigger, onYes) {
    const next = trigger.nextElementSibling;
    if (next && next.classList.contains('confirm-pair')) return;
    const pair = document.createElement('span');
    pair.className = 'confirm-pair';
    const label = document.createElement('span');
    label.className = 'confirm-label';
    label.textContent = 'Really?';
    const yes = document.createElement('button');
    yes.type = 'button'; yes.className = 'pill-button pill-dark confirm-yes'; yes.textContent = 'Yes';
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'pill-button pill-ghost confirm-no'; no.textContent = 'No';
    const cancel = () => { pair.remove(); trigger.hidden = false; trigger.focus(); };
    yes.addEventListener('click', () => {
      pair.remove(); trigger.hidden = false; onYes();
      if (!document.contains(trigger) || trigger.disabled || trigger.hidden || !trigger.offsetParent) {
        const s = document.getElementById('status-text');
        if (s) { s.tabIndex = -1; s.focus(); }
      }
    });
    no.addEventListener('click', cancel);
    pair.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(); });
    pair.append(label, yes, no);
    trigger.hidden = true;
    trigger.after(pair);
    yes.focus();
  }

  function persistEntry() {
    if (!state.entry || state.entry.pages.length === 0) { clearEntry(); return; }
    const mode = saveEntry(state.entry);
    if (mode === 'memory' && !state.memoryOnly) {
      state.memoryOnly = true;
      showError("This device's storage is full — this entry can't be kept across refreshes. Counting still works normally.");
    }
  }

  // Crash stash: iOS can kill the tab mid-read. While a photo is staged or
  // being read, sessionStorage holds enough to resume on next boot — the
  // staged photo's bytes, plus (once reading starts) how far the read got.
  const STASH_PHOTO_KEY = 'inkcount-stash-photo-v1';
  const STASH_PROGRESS_KEY = 'inkcount-stash-progress-v1';

  function writeStashPhoto(name, dataUrl) {
    try { sessionStorage.setItem(STASH_PHOTO_KEY, JSON.stringify({ name, dataUrl })); } catch (_) {}
  }
  function writeStashProgress(total, transcripts) {
    try { sessionStorage.setItem(STASH_PROGRESS_KEY, JSON.stringify({ total, transcripts })); } catch (_) {}
  }
  function clearStashProgress() {
    try { sessionStorage.removeItem(STASH_PROGRESS_KEY); } catch (_) {}
  }
  function clearStash() {
    try { sessionStorage.removeItem(STASH_PHOTO_KEY); } catch (_) {}
    clearStashProgress();
  }
  function readStash() {
    try {
      const photo = JSON.parse(sessionStorage.getItem(STASH_PHOTO_KEY));
      if (!photo || typeof photo.dataUrl !== 'string' || typeof photo.name !== 'string') return null;
      let progress = null;
      try { progress = JSON.parse(sessionStorage.getItem(STASH_PROGRESS_KEY)); } catch (_) {}
      if (progress && (!Array.isArray(progress.transcripts) || typeof progress.total !== 'number')) progress = null;
      return { photo, progress };
    } catch (_) { return null; }
  }

  function showCount(n, sub) {
    els.total.textContent = String(n);
    els.sub.textContent = sub;
  }

  function drawOverlay(grayMat, lineRects, wordBoxes, rejectedBands) {
    const cv = requireCV();
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, grayMat);
    const ctx = canvas.getContext('2d');
    if (DEBUG && rejectedBands && rejectedBands.length) {
      ctx.strokeStyle = '#d32f2f';
      ctx.fillStyle = '#d32f2f';
      ctx.lineWidth = Math.max(2, Math.round(canvas.height * 0.002));
      ctx.setLineDash([10, 6]);
      ctx.font = 'bold ' + Math.max(18, Math.round(canvas.height * 0.014)) + 'px system-ui, sans-serif';
      for (const r of rejectedBands) {
        ctx.strokeRect(4, r.y0, canvas.width - 8, r.y1 - r.y0);
        ctx.fillText('rejected: ' + r.reason + ' (' + r.detail + ')', 12, Math.max(20, r.y0 - 6));
      }
      ctx.setLineDash([]);
    }
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

  function renderWarnings(warns) {
    els.warnings.replaceChildren();
    for (const w of warns) {
      const li = document.createElement('li');
      if (w.severity === 'info') li.className = 'preflight-info';
      li.textContent = w.message;
      els.warnings.appendChild(li);
    }
  }

  const pageLabel = (i, p) => 'Page ' + (i + 1) + ' · ' + p.count + (p.count === 1 ? ' word' : ' words');

  function renderEntry() {
    const pages = state.entry ? state.entry.pages : [];
    els.pagesStrip.replaceChildren();
    pages.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'page-card';
      const sel = document.createElement('button');
      sel.type = 'button'; sel.className = 'page-select';
      sel.setAttribute('aria-label', pageLabel(i, p) + ' — show details');
      if (i === state.selectedPage) sel.setAttribute('aria-current', 'true');
      const img = document.createElement('img');
      img.src = p.thumb; img.alt = '';
      const cap = document.createElement('span');
      cap.textContent = pageLabel(i, p);
      sel.append(img, cap);
      sel.addEventListener('click', () => { state.selectedPage = i; renderEntry(); renderSelectedPage(); });
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'page-remove';
      rm.textContent = '✕';
      rm.setAttribute('aria-label', 'Remove page ' + (i + 1) + ', ' + p.count + ' words');
      rm.addEventListener('click', () => inlineConfirm(rm, () => removePage(i)));
      li.append(sel, rm);
      els.pagesStrip.appendChild(li);
    });
    els.inputTitle.textContent = pages.length ? 'Add another page' : 'Add a page';
    els.newEntryBtn.disabled = pages.length === 0 && !state.photo;
    renderSaveButton();
    if (state.running) return; // the streaming counter owns the hero mid-read
    const total = pages.reduce((s, p) => s + p.count, 0);
    if (pages.length === 0) {
      els.total.textContent = '—';
      els.sub.textContent = state.photo ? 'Photo loaded — press Count words.' : 'Choose a page and press Count.';
    } else {
      els.total.textContent = String(total);
      els.sub.textContent = pages.length + (pages.length === 1 ? ' page' : ' pages') + ' · ' + total +
        ' words' + (state.photo ? ' — new photo staged' : '');
    }
  }

  function renderSelectedPage() {
    const pages = state.entry ? state.entry.pages : [];
    const p = pages[state.selectedPage];
    if (!p) return;
    renderTranscript(p.transcript, p.perLine, p.lowConfidence);
    els.overlaySlot.replaceChildren();
    if (p.overlay) {
      const img = document.createElement('img');
      img.src = p.overlay;
      img.alt = 'The straightened page with ' + p.lines + ' detected line' + (p.lines === 1 ? '' : 's') + ' boxed';
      img.title = 'Open full size';
      img.addEventListener('click', async () => {
        const blob = await (await fetch(p.overlay)).blob();
        window.open(URL.createObjectURL(blob), '_blank');
      });
      els.overlaySlot.appendChild(img);
      els.overlayCaption.textContent = 'Page ' + (state.selectedPage + 1) + ' — ' + p.lines +
        ' line' + (p.lines === 1 ? '' : 's') + ' detected on the straightened page.';
    } else {
      els.overlayCaption.textContent = 'Page ' + (state.selectedPage + 1) +
        " — the overlay image couldn't be kept for this page (device storage was full).";
    }
    els.overlayCard.hidden = false;
  }

  function removePage(i) {
    state.entry.pages.splice(i, 1);
    if (state.entry.pages.length === 0) {
      state.entry = null;
      state.selectedPage = -1;
      clearEntry();
      els.transcriptCard.hidden = true;
      els.overlayCard.hidden = true;
      els.transcriptList.replaceChildren();
      els.overlaySlot.replaceChildren();
      setStatus('Entry is empty again — add a page.');
    } else {
      if (state.selectedPage === i) state.selectedPage = Math.min(i, state.entry.pages.length - 1);
      else if (state.selectedPage > i) state.selectedPage -= 1;
      persistEntry();
      renderSelectedPage();
      setStatus('Page removed.');
    }
    renderEntry();
  }

  function showStagedOverlay(ph) {
    const img = document.createElement('img');
    img.src = ph.overlayJpeg;
    img.alt = ph.lines === 0 ? 'The straightened page — no handwritten lines found'
      : 'The straightened page with ' + ph.lines + ' detected line' + (ph.lines > 1 ? 's' : '') + ' boxed';
    img.title = 'Open full size';
    img.addEventListener('click', async () => {
      const blob = await (await fetch(ph.overlayJpeg)).blob();
      window.open(URL.createObjectURL(blob), '_blank');
    });
    els.overlaySlot.replaceChildren(img);
    els.overlayCaption.textContent = (ph.lines === 0
      ? "No handwritten lines were found on this photo — nothing is boxed. InkCount looks for rows of English handwriting; drawings, printed pages, and non-English text won't register."
      : 'New photo — ' + ph.lines + ' line' + (ph.lines > 1 ? 's' : '') + ' detected on the straightened page. Press Count words to read them.')
      + (DEBUG && ph.rejectedCount ? ' [debug: ' + ph.rejectedCount + ' rejected band' + (ph.rejectedCount > 1 ? 's' : '') + ' in red]' : '');
    els.overlayCard.hidden = false;
  }

  async function analyzePhoto() {
    // Stage 1 of the old run(), moved to load time: warnings and the overlay
    // appear in ~2-3 s, BEFORE the ~15 s model read.
    const mine = state.photo;
    setStatus('Straightening and reading the page layout…');
    const staged = await withMats(async (scope) => {
      const pre = preprocess(mine.canvas, scope);
      const segs = segmentLines(pre, scope);
      const est = estimateWords(pre, segs);
      const overlay = drawOverlay(pre.gray, segs.map((s) => s.rect), est.boxes, segs.rejected);
      if (DEBUG && segs.rejected) console.log('[inkcount debug] rejected bands:', JSON.stringify(segs.rejected));
      return { crops: segs.map((s) => s.canvas), overlayCanvas: overlay, skewAngle: pre.skewAngle,
        textHeight: pre.textHeight, lines: segs.length, rejectedCount: (segs.rejected || []).length, medianLum: medianLuminance(pre.gray) };
    });
    if (state.photo !== mine) return;
    // Snapshot every JPEG the rest of the flow needs, stash the photo for
    // crash resume, then DROP the big canvases — during the model read the
    // only pixel data alive is the line crops (released one by one).
    mine.thumb = makeThumb(mine.canvas, 160, 0.7);
    mine.overlayJpeg = makeThumb(staged.overlayCanvas, 1000, 0.75);
    mine.preview = makeThumb(mine.canvas, 800, 0.8);
    if (!mine.fromStash) { clearStashProgress(); writeStashPhoto(mine.name, makeThumb(mine.canvas, 2000, 0.8)); }
    mine.crops = staged.crops;
    mine.skewAngle = staged.skewAngle;
    mine.textHeight = staged.textHeight;
    mine.lines = staged.lines;
    mine.rejectedCount = staged.rejectedCount;
    mine.canvas = null;
    showPreviewImage(mine);
    showStagedOverlay(mine);
    renderWarnings(evaluatePreflight(staged));
    setStatus(staged.lines === 0 ? 'No handwriting found in this photo — try another.' : 'Ready — press Count words.');
    updateRunEnabled();
  }

  function showPreviewImage(ph) {
    const img = document.createElement('img');
    img.src = ph.preview;
    img.alt = 'Photo of your page: ' + ph.name;
    els.imageSlot.replaceChildren(img);
  }

  async function loadInto(source, name, loadingMessage, { fromStash = false } = {}) {
    state.loading = true;
    updateRunEnabled();
    setStatus(loadingMessage);
    hideError();
    if (!fromStash) clearStash(); // a manually staged photo invalidates any old stash
    try {
      const canvas = await decodeToCanvas(source);
      state.photo = { canvas, name, crops: null, fromStash };
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Photo of your page: ' + name);
      els.imageSlot.replaceChildren(canvas);
      els.label.textContent = name + ' · ' + canvas.width + ' × ' + canvas.height + ' px';
      renderWarnings([]);
      state.loading = false;
      renderEntry();
      if (state.cvReady) await analyzePhoto();
      else setStatus('Image loaded. Preparing the analyzer…');
    } catch (e) {
      state.loading = false;
      state.photo = null;
      setStatus('Ready.');
      showError(humanError('That image could not be opened', e));
      renderEntry();
    }
    updateRunEnabled();
  }

  async function countCurrentPhoto(prior = []) {
    if (state.running || !state.photo || !state.photo.crops || state.photo.lines === 0) return;
    state.running = true;
    hideError();
    els.reset.disabled = true;
    els.newEntryBtn.disabled = true;
    els.saveEntryBtn.disabled = true;
    updateRunEnabled();
    const t0 = performance.now();
    const ph = state.photo; // captured now — loadInto can replace state.photo while this awaits
    const baseTotal = state.entry ? entryTotal(state.entry) : 0;
    const pageNo = (state.entry ? state.entry.pages.length : 0) + 1;
    try {
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
      els.progress.max = ph.crops.length;
      els.progress.value = prior.length;
      if (state.photo === ph) writeStashProgress(ph.crops.length, prior);
      const seen = prior.slice();
      const transcripts = await recognizeLines(ph.crops, (i, n, text) => {
        seen.push(text);
        if (state.photo === ph) writeStashProgress(n, seen);
        els.progress.value = i + 1;
        setStatus('Reading line ' + (i + 1) + ' of ' + n + ' on page ' + pageNo + '…');
        showCount(baseTotal + countWords(seen).total, 'so far — reading line ' + (i + 1) + ' of ' + n + '…');
      }, prior);
      const { total, perLine, lowConfidence } = countWords(transcripts);
      const flagged = lowConfidence.filter(Boolean).length;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (!state.entry) state.entry = newEntry();
      state.entry.pages.push({
        name: ph.name, count: total, lines: ph.lines, secs: Number(secs),
        transcript: transcripts, perLine, lowConfidence,
        thumb: ph.thumb,
        overlay: ph.overlayJpeg,
      });
      state.selectedPage = state.entry.pages.length - 1;
      persistEntry();
      clearStashProgress();
      if (state.photo === ph) { // still ours — a newer staged photo must survive untouched
        clearStash();
        state.photo = null; // canvas, crops, and the overlay canvas were already released progressively — this drops the last reference
        els.imageSlot.replaceChildren();
        els.label.textContent = 'No image loaded.';
        els.fileInput.value = '';
        els.cameraInput.value = '';
        renderWarnings([]);
      }
      els.progress.hidden = true;
      state.running = false;
      renderEntry();
      renderSelectedPage();
      setStatus('Page ' + pageNo + ' done in ' + secs + 's — ' + total + ' word' + (total === 1 ? '' : 's') +
        (flagged ? ' (' + flagged + ' line' + (flagged > 1 ? 's' : '') + ' not counted)' : '') +
        '. Entry total: ' + entryTotal(state.entry) + '.');
    } catch (e) {
      state.running = false;
      showError(humanError('Counting failed', e));
      setStatus('Error.');
      els.progress.hidden = true;
      renderEntry();
      clearStashProgress();
      // The crops are partially consumed — this photo can't be re-counted
      // as-is. Re-stage it from the stash (no auto-count: a persistent
      // failure must not loop).
      if (state.photo === ph) {
        const stash = readStash();
        state.photo = null;
        if (stash) {
          try {
            const blob = await (await fetch(stash.photo.dataUrl)).blob();
            await loadInto(blob, stash.photo.name, 'Re-preparing the photo…', { fromStash: true });
          } catch (_) {}
        }
      }
    } finally {
      state.running = false;
      els.reset.disabled = false;
      els.newEntryBtn.disabled = false;
      renderSaveButton();
      updateRunEnabled();
    }
  }

  async function resumeFromStash(stash) {
    const doneLines = stash.progress ? stash.progress.transcripts.length : 0;
    if (stash.progress) {
      setStatus('Your last read was interrupted at line ' + Math.min(doneLines + 1, stash.progress.total) +
        ' of ' + stash.progress.total + ' — this device ran low on memory. Resuming…');
    }
    try {
      const blob = await (await fetch(stash.photo.dataUrl)).blob();
      await loadInto(blob, stash.photo.name, 'Restoring your photo…', { fromStash: true });
      if (stash.progress && state.photo && state.photo.crops) {
        if (state.photo.crops.length === stash.progress.total) {
          await countCurrentPhoto(stash.progress.transcripts);
        } else {
          // The restored photo segmented differently — prior lines don't map.
          clearStashProgress();
          setStatus('Photo restored — press Count words to read it from the start.');
        }
      }
    } catch (e) {
      clearStash();
      showError(humanError('Your interrupted photo could not be restored', e));
    }
  }

  function clearPhoto() {
    state.photo = null;
    state.loading = false;
    els.fileInput.value = '';
    els.cameraInput.value = '';
    els.imageSlot.replaceChildren();
    els.label.textContent = 'No image loaded.';
    renderWarnings([]);
    clearStash();
    els.progress.hidden = true;
    hideError();
    if (state.selectedPage >= 0 && state.entry) renderSelectedPage();
    else { els.transcriptCard.hidden = true; els.overlayCard.hidden = true; els.transcriptList.replaceChildren(); els.overlaySlot.replaceChildren(); }
    renderEntry();
    setStatus(state.cvReady ? (state.entry ? 'Ready — add another page.' : 'Ready — add a page.') : 'Preparing the analyzer…');
    updateRunEnabled();
  }

  function startNewEntry() {
    if (state.running) { setStatus('Finish the current count first.'); return; }
    state.entry = null;
    state.selectedPage = -1;
    state.photo = null;
    clearEntry();
    els.fileInput.value = '';
    els.cameraInput.value = '';
    els.imageSlot.replaceChildren();
    els.label.textContent = 'No image loaded.';
    renderWarnings([]);
    clearStash();
    els.transcriptCard.hidden = true;
    els.overlayCard.hidden = true;
    els.transcriptList.replaceChildren();
    els.overlaySlot.replaceChildren();
    els.progress.hidden = true;
    hideError();
    renderEntry();
    setStatus('New entry started — add a page.');
    updateRunEnabled();
  }

  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files[0];
    if (f) loadInto(f, f.name, 'Reading image…');
  });
  els.cameraInput.addEventListener('change', () => {
    const f = els.cameraInput.files[0];
    if (f) loadInto(f, f.name, 'Reading photo…');
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
      showError(humanError('The sample page could not be loaded', e));
    }
  });
  els.run.addEventListener('click', () => countCurrentPhoto());
  els.reset.addEventListener('click', clearPhoto);
  els.newEntryBtn.addEventListener('click', () => {
    if (state.running) return;
    const unsaved = state.entry && state.entry.pages.length > 0 && !isEntrySaved(state.entry);
    if (unsaved) inlineConfirm(els.newEntryBtn, startNewEntry);
    else startNewEntry();
  });

  function renderHistoryCard() {
    const rows = loadHistory();
    els.historyCard.hidden = rows.length === 0;
    renderHistory(els.historyList, rows, {
      onDelete: (row, btn) => inlineConfirm(btn, () => { deleteHistoryRow(row.id); renderHistoryCard(); renderSaveButton(); setStatus('Entry deleted from history.'); }),
    });
  }

  function renderSaveButton() {
    const pages = state.entry ? state.entry.pages.length : 0;
    if (pages === 0) {
      els.saveEntryBtn.disabled = true;
      els.saveEntryBtn.textContent = 'Save entry';
      return;
    }
    const saved = isEntrySaved(state.entry);
    els.saveEntryBtn.disabled = state.running || saved;
    els.saveEntryBtn.textContent = saved ? 'Saved ✓' : 'Save entry';
  }

  els.saveEntryBtn.addEventListener('click', () => {
    if (!state.entry || state.entry.pages.length === 0) return;
    if (!storageAvailable()) {
      showError("Couldn't save — this browser is blocking local storage (private mode?). The count still works; it just can't be kept.");
      return;
    }
    const row = saveToHistory(state.entry);
    if (!row) {
      showError("Couldn't save — this device's storage is full.");
      return;
    }
    renderHistoryCard();
    renderSaveButton();
    setStatus('Entry saved to this device.');
  });
  els.clearHistoryBtn.addEventListener('click', () => {
    inlineConfirm(els.clearHistoryBtn, () => { clearHistory(); renderHistoryCard(); renderSaveButton(); setStatus('History cleared.'); });
  });

  // Ask the browser not to evict our ~80 MB cached model under storage
  // pressure (iOS especially). Fire-and-forget; denial is fine.
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'SW_UPDATED') {
        showError('InkCount updated in the background — reload this page to get the newest version.');
      }
    });
  }

  state.entry = loadEntry();
  if (state.entry && state.entry.pages.length) {
    state.selectedPage = state.entry.pages.length - 1;
    renderEntry();
    renderSelectedPage();
    setStatus('Restored your in-progress entry. Preparing the analyzer…');
  } else {
    state.entry = null;
    renderEntry();
    setStatus('Preparing the analyzer…');
  }
  renderHistoryCard();
  updateRunEnabled();
  loadOpenCV().then(async () => {
    state.cvReady = true;
    if (!/ — Ready$/.test(document.title)) document.title += ' — Ready';
    if (state.photo && !state.photo.crops) {
      // A photo loaded before OpenCV finished — analyze it now. Errors here
      // must not become unhandled rejections (the suite fails on page errors).
      try { await analyzePhoto(); }
      catch (e) { showError(humanError('That photo could not be analyzed', e)); setStatus('Ready.'); }
    } else {
      setStatus(state.photo ? 'Ready — press Count words.' : (state.entry ? 'Ready — add another page.' : 'Ready — add a page.'));
    }
    updateRunEnabled();
    const stash = readStash();
    if (stash && !state.photo) await resumeFromStash(stash);
  }).catch((e) => {
    showError('The analyzer failed to load: ' + (e && e.message ? e.message : String(e)) + ' — reload the page to retry.');
    setStatus('Analyzer unavailable.');
  });
}

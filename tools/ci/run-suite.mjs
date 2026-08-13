/* InkCount verification suite — runs every test gate plus a full UI walkthrough
 * in headless Chrome over the DevTools protocol. Zero npm dependencies.
 *
 * Usage:  node tools/ci/run-suite.mjs
 * Env:    CHROME_BIN  chrome executable (default: google-chrome, or Windows Chrome)
 *         PORT        static server port (default 8000)
 *         GATES       comma list to override gate pages; "none" = walkthrough only
 *
 * Hard-won rules encoded here (do not "simplify" them away):
 *  - NEVER call Runtime.evaluate while a page is inside the monolithic
 *    opencv.js eval — it permanently wedges the CDP session. Pages signal
 *    readiness via document.title; poll titles through GET /json/list.
 *  - Page-only CDP sessions (no Runtime/Log/Network domains) for the same
 *    reason; errors are captured by an injected in-page hook instead.
 *  - Runtime.evaluate top-level `const` persists across calls — wrap in IIFEs.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startServer } from './static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 8000);
const BASE = `http://localhost:${PORT}`;
const CDP_PORT = PORT + 1222;
const PROFILE = path.join(os.tmpdir(), `inkcount-ci-profile-${process.pid}`);
const REPORT = path.join(ROOT, 'tools', 'ci', 'report.json');

const DEFAULT_GATES = 'smoke,assets,count,store,preflight,vendorstore,decode,preprocess,segment,recognize,accuracy,a11y,pwa';
const GATES = (process.env.GATES || DEFAULT_GATES).split(',').filter((g) => g && g !== 'none');

function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === 'win32') {
    const win = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (existsSync(win)) return win;
  }
  return 'google-chrome';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

let chrome = null;
let server = null;

async function cleanup() {
  try { if (chrome && !chrome.killed) chrome.kill('SIGKILL'); } catch {}
  try { if (server) server.close(); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}

const hardTimeout = setTimeout(async () => {
  console.error('SUITE: ERROR — hard timeout (30 min)');
  await cleanup();
  process.exit(3);
}, 30 * 60 * 1000);

async function http(pathname, opts) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, { ...opts, signal: AbortSignal.timeout(10000) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('ws connect timeout')), 20000);
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => clearTimeout(bail), { once: true });
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = nextId++;
          const t = setTimeout(() => { pending.delete(id); rej(new Error('CDP command timed out: ' + method)); }, 30000);
          pending.set(id, {
            res: (v) => { clearTimeout(t); res(v); },
            rej: (e) => { clearTimeout(t); rej(e); },
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { try { ws.close(); } catch {} },
    }));
    ws.addEventListener('error', () => { clearTimeout(bail); reject(new Error('ws error')); });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error('CDP: ' + JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  });
}

async function evalJS(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('page eval failed: ' + JSON.stringify(
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function pollEval(cdp, expression, testFn, timeoutMs, label) {
  const t0 = Date.now();
  let last, lastErr;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await evalJS(cdp, expression);
      lastErr = null;
      if (testFn(last)) return last;
    } catch (e) { lastErr = e.message; }
    await sleep(500);
  }
  throw new Error(`poll timeout (${label}): last=${JSON.stringify(last)} err=${lastErr}`);
}

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(10000) });
  return r.json();
}

async function pollTitle(targetId, testFn, timeoutMs, label) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const t = (await listTargets()).find((x) => x.id === targetId);
      last = t ? t.title : '(target gone)';
      if (testFn(last)) return last;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`title poll timeout (${label}): last="${last}"`);
}

async function newPage() {
  const info = await http('/json/new?url=about:blank', { method: 'PUT' });
  let cdp;
  try { cdp = await connect(info.webSocketDebuggerUrl); }
  catch { await sleep(2000); cdp = await connect(info.webSocketDebuggerUrl); }
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errors = [];
addEventListener('error', (e) => window.__errors.push('onerror: ' + e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));
addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + ((e.reason && e.reason.message) || String(e.reason))));
(function () { const ce = console.error.bind(console); console.error = function () { try { window.__errors.push('console.error: ' + Array.prototype.map.call(arguments, String).join(' ')); } catch {} ce.apply(null, arguments); }; })();`,
  });
  return {
    id: info.id, cdp,
    async collectAudit() {
      return JSON.parse(await evalJS(cdp, `JSON.stringify({
        errors: window.__errors || ['__errors hook missing'],
        resources: performance.getEntriesByType('resource').map((r) => r.name),
      })`));
    },
    async goto(url) { await cdp.send('Page.navigate', { url }); },
    async close() { cdp.close(); try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${info.id}`, { signal: AbortSignal.timeout(10000) }); } catch {} },
  };
}

const GATE_BUDGET_MS = { recognize: 360000, accuracy: 1200000, pwa: 300000, a11y: 600000, preflight: 240000 };

async function runGate(name) {
  const page = await newPage();
  const out = { gate: name };
  try {
    await page.goto(`${BASE}/tests/${name}.html`);
    const budget = GATE_BUDGET_MS[name] || 120000;
    const title = await pollTitle(page.id, (t) => /(PASS|FAIL|ERROR)/.test(t || ''), budget, name);
    out.title = title;
    out.verdict = await evalJS(page.cdp, `(document.getElementById('verdict')||{}).textContent || ''`);
    out.log = await evalJS(page.cdp, `((document.getElementById('log')||{}).textContent || '').slice(0, 4000)`);
    if (!/PASS/.test(title) && out.log) log(out.log);
    if (name === 'accuracy') {
      try { out.table = JSON.parse(await evalJS(page.cdp, `document.getElementById('json').textContent || '[]'`)); } catch {}
    }
    const audit = await page.collectAudit();
    out.consoleErrors = audit.errors;
    out.externalRequests = audit.resources.filter((u) => !u.startsWith(BASE + '/'));
    out.pass = /PASS/.test(title) && out.consoleErrors.length === 0 && out.externalRequests.length === 0;
  } catch (e) {
    out.pass = false;
    out.error = e.message;
    try {
      out.pageState = await evalJS(page.cdp, `JSON.stringify({title: document.title, log: (document.getElementById('log')||{}).textContent})`);
    } catch {}
  } finally { await page.close(); }
  log(`[gate] ${name}: ${out.pass ? 'PASS' : 'FAIL'} ${out.title || out.error || ''}`);
  return out;
}

/* The pwa gate is not a tests/*.html page: it exercises the service worker by
 * loading the app, confirming SW control, then STOPPING the static server and
 * proving the app still reaches Ready entirely from cache (shell + the 80 MB
 * vendor runtime). The server is restarted afterwards for later stages. */
async function runPwaGate() {
  const page = await newPage();
  const out = { gate: 'pwa', pass: false };
  const freshReady = async (originBefore, label) => pollEval(page.cdp,
    `String(performance.timeOrigin) + '|' + (document.title.endsWith(' — Ready') ? '1' : '0')`,
    (v) => { const p = String(v).split('|'); return Number(p[0]) !== originBefore && p[1] === '1'; },
    300000, label);
  try {
    await page.goto(`${BASE}/web/index.html`);
    await pollTitle(page.id, (t) => / — Ready$/.test(t || ''), 300000, 'pwa first ready');
    await pollEval(page.cdp,
      `!!(navigator.serviceWorker && navigator.serviceWorker.controller)`,
      (v) => v === true, 60000, 'sw controlling');

    // Second load warms the vendor cache under SW control.
    let origin = await evalJS(page.cdp, 'performance.timeOrigin');
    await page.goto(`${BASE}/web/index.html?swwarm=1`);
    await freshReady(origin, 'pwa warm reload');

    // Offline: no server at all. Shell precache + vendor cache must carry a
    // full boot to Ready.
    origin = await evalJS(page.cdp, 'performance.timeOrigin');
    // server.close() alone waits for keep-alive sockets from earlier gates and
    // can wait forever — destroy them so close resolves immediately.
    server.closeAllConnections?.();
    await Promise.race([
      new Promise((res) => server.close(res)),
      sleep(5000),
    ]);
    server = null;
    await page.goto(`${BASE}/web/index.html?offline=1`);
    await freshReady(origin, 'pwa offline boot');
    out.pass = true;
  } catch (e) {
    out.error = e.message;
  } finally {
    await page.close();
    if (!server) server = await startServer(PORT, ROOT);
  }
  log(`[gate] pwa: ${out.pass ? 'PASS' : 'FAIL'} ${out.error || 'offline boot reached Ready'}`);
  return out;
}

async function runUI() {
  const page = await newPage();
  const out = { gate: 'ui-walkthrough', steps: [], pass: false };
  const step = (label, ok, detail) => {
    out.steps.push({ label, ok: !!ok, detail });
    log(`[ui] ${label}: ${ok ? 'ok' : 'FAILED ' + JSON.stringify(detail)}`);
    if (!ok) throw new Error('UI step failed: ' + label);
  };
  const freshReady = async (originBefore, label) => pollEval(page.cdp,
    `String(performance.timeOrigin) + '|' + (document.title.endsWith(' — Ready') ? '1' : '0')`,
    (v) => { const p = String(v).split('|'); return Number(p[0]) !== originBefore && p[1] === '1'; },
    300000, label);
  // Load the sample and count it. expectPage pins the status regex to the page
  // number so a stale "Page N done" from the PREVIOUS count can't false-pass.
  const loadSampleAndCount = async (expectPage, label) => {
    await evalJS(page.cdp, `document.getElementById('btn-sample').click()`);
    await pollEval(page.cdp, `document.getElementById('btn-run').disabled`, (d) => d === false, 120000, label + ' run enabled');
    await evalJS(page.cdp, `document.getElementById('btn-run').click()`);
    await pollEval(page.cdp, `document.getElementById('status-text').textContent`,
      (s) => new RegExp('^Page ' + expectPage + ' done').test(s || ''), 600000, label + ' done');
  };
  try {
    // Clean boot: gates share this origin's localStorage, so wipe and reload
    // before asserting anything (cross-gate storage bleed is a known hazard).
    await page.goto(`${BASE}/web/index.html`);
    await pollTitle(page.id, (t) => / — Ready$/.test(t || ''), 300000, 'cv ready');
    await evalJS(page.cdp, `localStorage.clear()`);
    let origin = await evalJS(page.cdp, 'performance.timeOrigin');
    await page.goto(`${BASE}/web/index.html?clean=1`);
    await freshReady(origin, 'clean boot ready');
    step('opencv-ready', true, null);

    // Sample loads -> stage-1 analysis at load time: overlay already visible,
    // zero pre-flight warnings on the known-good sample.
    await evalJS(page.cdp, `document.getElementById('btn-sample').click()`);
    await pollEval(page.cdp, `document.getElementById('active-image-label').textContent`, (s) => /sample_page\.jpg/.test(s || ''), 60000, 'sample label');
    await pollEval(page.cdp, `document.getElementById('btn-run').disabled`, (d) => d === false, 120000, 'run enabled');
    const stagedState = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      overlayShown: !document.getElementById('overlay-card').hidden,
      overlayImgs: document.querySelectorAll('#overlay-slot img').length,
      warnings: document.querySelectorAll('#preflight-warnings li').length,
    })`));
    step('analyze-on-load', stagedState.overlayShown === true && stagedState.overlayImgs === 1 && stagedState.warnings === 0, stagedState);

    await evalJS(page.cdp, `document.getElementById('btn-run').click()`);
    await pollEval(page.cdp, `document.getElementById('status-text').textContent`, (s) => /^Page 1 done/.test(s || ''), 600000, 'page 1 done');
    const final = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      total: document.getElementById('result-total').textContent,
      estimateChipGone: document.getElementById('estimate-chip') === null,
      transcriptItems: document.querySelectorAll('#transcript-list li').length,
      overlayEls: document.querySelectorAll('#overlay-slot canvas, #overlay-slot img').length,
      errorHidden: document.getElementById('error-banner').hidden,
      pageCards: document.querySelectorAll('#pages-strip .page-card').length,
    })`));
    out.final = final;
    const total1 = parseInt(final.total, 10);
    step('count-plausible', total1 >= 170 && total1 <= 200, final);
    step('estimate-chip-removed', final.estimateChipGone === true, final);
    step('transcript-rendered', final.transcriptItems === 16, final);
    step('overlay-rendered', final.overlayEls === 1, final);
    step('no-error-banner', final.errorHidden === true, final);
    step('page-card-added', final.pageCards === 1, final);

    // Second page — and while it is being read, stage the NEXT photo. The
    // count must complete on the captured photo and leave the new one staged.
    await evalJS(page.cdp, `document.getElementById('btn-sample').click()`);
    await pollEval(page.cdp, `document.getElementById('btn-run').disabled`, (d) => d === false, 120000, 'page 2 run enabled');
    await evalJS(page.cdp, `document.getElementById('btn-run').click()`);
    await evalJS(page.cdp, `document.getElementById('btn-sample').click()`);
    // Poll the strip, not the status line — the staged photo's analyzer can
    // overwrite the "Page 2 done" status within a poll interval.
    await pollEval(page.cdp, `document.querySelectorAll('#pages-strip .page-card').length`, (n) => n === 2, 600000, 'page 2 counted');
    await pollEval(page.cdp, `document.getElementById('btn-run').disabled`, (d) => d === false, 120000, 'staged photo run enabled');
    const midStage = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      label: document.getElementById('active-image-label').textContent,
    })`));
    step('stage-photo-mid-count', /sample_page\.jpg/.test(midStage.label), midStage);

    const multi = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      total: parseInt(document.getElementById('result-total').textContent, 10),
      pageCards: document.querySelectorAll('#pages-strip .page-card').length,
      perPage: Array.from(document.querySelectorAll('#pages-strip .page-select')).map(
        (b) => parseInt((b.textContent.match(/(\\d+) words?/) || [])[1], 10)),
    })`));
    step('two-pages', multi.pageCards === 2 && multi.total >= 340 && multi.total <= 400 &&
      multi.perPage.length === 2 && multi.perPage.every((n) => n >= 170 && n <= 200), multi);

    // Selecting page 1 shows page 1's details.
    await evalJS(page.cdp, `document.querySelectorAll('#pages-strip .page-select')[0].click()`);
    const sel = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      current: document.querySelectorAll('#pages-strip .page-select')[0].getAttribute('aria-current'),
      caption: document.getElementById('overlay-caption').textContent,
      transcriptItems: document.querySelectorAll('#transcript-list li').length,
    })`));
    step('select-page-1', sel.current === 'true' && /^Page 1/.test(sel.caption) && sel.transcriptItems === 16, sel);

    // Save the 2-page entry -> one history row, button flips to Saved.
    await evalJS(page.cdp, `document.getElementById('btn-save-entry').click()`);
    const saved1 = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      cardShown: !document.getElementById('history-card').hidden,
      rows: document.querySelectorAll('#history-list li').length,
      btnText: document.getElementById('btn-save-entry').textContent,
      btnDisabled: document.getElementById('btn-save-entry').disabled,
    })`));
    step('save-entry', saved1.cardShown === true && saved1.rows === 1 && /Saved/.test(saved1.btnText) && saved1.btnDisabled === true, saved1);

    // Remove page 2 through the inline confirm.
    await evalJS(page.cdp, `document.querySelectorAll('#pages-strip .page-remove')[1].click()`);
    await pollEval(page.cdp, `!!document.querySelector('#pages-strip .confirm-yes')`, (v) => v === true, 10000, 'remove confirm shown');
    await evalJS(page.cdp, `document.querySelector('#pages-strip .confirm-yes').click()`);
    const afterRemove = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      pageCards: document.querySelectorAll('#pages-strip .page-card').length,
      total: parseInt(document.getElementById('result-total').textContent, 10),
      currentFirst: (document.querySelectorAll('#pages-strip .page-select')[0] || { getAttribute: () => null }).getAttribute('aria-current'),
    })`));
    step('remove-page', afterRemove.pageCards === 1 && afterRemove.total >= 170 && afterRemove.total <= 200 &&
      afterRemove.currentFirst === 'true', afterRemove);

    // The entry changed, so Save re-arms; saving again UPDATES the same row.
    const rearmed = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      btnText: document.getElementById('btn-save-entry').textContent,
      btnDisabled: document.getElementById('btn-save-entry').disabled,
    })`));
    step('save-rearmed', /Save entry/.test(rearmed.btnText) && rearmed.btnDisabled === false, rearmed);
    await evalJS(page.cdp, `document.getElementById('btn-save-entry').click()`);
    const saved2 = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      rows: document.querySelectorAll('#history-list li').length,
      counts: (document.querySelector('#history-list .history-counts') || {}).textContent,
    })`));
    step('save-upsert', saved2.rows === 1 && /1 page\b/.test(saved2.counts || ''), saved2);

    // Refresh: the in-progress entry survives (real navigation, not a mock).
    origin = await evalJS(page.cdp, 'performance.timeOrigin');
    await page.goto(`${BASE}/web/index.html?reload=1`);
    await freshReady(origin, 'ready after refresh');
    const restored = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      pageCards: document.querySelectorAll('#pages-strip .page-card').length,
      total: parseInt(document.getElementById('result-total').textContent, 10),
      historyRows: document.querySelectorAll('#history-list li').length,
      savedBtn: document.getElementById('btn-save-entry').textContent,
    })`));
    step('entry-restored', restored.pageCards === 1 && restored.total >= 170 && restored.total <= 200 &&
      restored.historyRows === 1 && /Saved/.test(restored.savedBtn), restored);

    // New entry: the entry is saved, so it clears without a confirm.
    await evalJS(page.cdp, `document.getElementById('btn-new-entry').click()`);
    const cleared = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      pageCards: document.querySelectorAll('#pages-strip .page-card').length,
      total: document.getElementById('result-total').textContent,
      historyRows: document.querySelectorAll('#history-list li').length,
    })`));
    step('new-entry', cleared.pageCards === 0 && cleared.total === '—' && cleared.historyRows === 1, cleared);

    // Counting still works after the refresh + new-entry cycle.
    await loadSampleAndCount(1, 'post-refresh');
    const totalAfter = await evalJS(page.cdp, `document.getElementById('result-total').textContent`);
    step('refresh-then-run', parseInt(totalAfter, 10) >= 170 && parseInt(totalAfter, 10) <= 200, totalAfter);

    // The unsaved-entry guard: New entry must ask before discarding work.
    await evalJS(page.cdp, `document.getElementById('btn-new-entry').click()`);
    await pollEval(page.cdp, `!!document.querySelector('.hero-actions .confirm-pair')`, (v) => v === true, 10000, 'unsaved new-entry confirm shown');
    await evalJS(page.cdp, `document.querySelector('.hero-actions .confirm-no').click()`);
    const kept = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      pageCards: document.querySelectorAll('#pages-strip .page-card').length,
      pairGone: document.querySelector('.hero-actions .confirm-pair') === null,
    })`));
    step('unsaved-new-entry-confirms', kept.pageCards === 1 && kept.pairGone === true, kept);

    await evalJS(page.cdp, `document.getElementById('btn-reset').click()`);
    const reset = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      label: document.getElementById('active-image-label').textContent,
    })`));
    step('clear-photo', /No image loaded/.test(reset.label), reset);

    // Delete the saved row through its inline confirm -> card hides.
    await evalJS(page.cdp, `document.querySelector('#history-list .history-delete').click()`);
    await pollEval(page.cdp, `!!document.querySelector('#history-list .confirm-yes')`, (v) => v === true, 10000, 'delete confirm shown');
    await evalJS(page.cdp, `document.querySelector('#history-list .confirm-yes').click()`);
    const afterDelete = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      rows: document.querySelectorAll('#history-list li').length,
      cardHidden: document.getElementById('history-card').hidden,
    })`));
    step('delete-history-row', afterDelete.rows === 0 && afterDelete.cardHidden === true, afterDelete);

    // Crash-resume: seed a stash as if a read was killed after 2 lines,
    // reload, and the app must restore the photo and finish the read alone,
    // REUSING the seeded transcripts rather than re-reading those lines —
    // proven by the first rendered line being the seeded text verbatim
    // (a silent restart-from-scratch would show the sample's real first line
    // instead, which is why an empty seed wouldn't distinguish the two).
    await evalJS(page.cdp, `(function () {
      window.__stashSeeded = false;
      fetch('./samples/sample_page.jpg').then((r) => r.blob()).then((b) => new Promise((res) => {
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b);
      })).then((dataUrl) => {
        sessionStorage.setItem('inkcount-stash-photo-v1', JSON.stringify({ name: 'sample_page.jpg', dataUrl: dataUrl }));
        sessionStorage.setItem('inkcount-stash-progress-v1', JSON.stringify({ total: 16, transcripts: ['hello world', 'two words'] }));
        window.__stashSeeded = true;
      });
    })()`);
    await pollEval(page.cdp, `window.__stashSeeded === true`, (v) => v === true, 30000, 'stash seeded');
    origin = await evalJS(page.cdp, 'performance.timeOrigin');
    await page.goto(`${BASE}/web/index.html?resume=1`);
    await freshReady(origin, 'ready for resume');
    await pollEval(page.cdp, `document.querySelectorAll('#pages-strip .page-card').length`, (n) => n === 2, 600000, 'resume completed');
    const resumed = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      total: parseInt(document.getElementById('result-total').textContent, 10),
      firstLine: (document.querySelector('#transcript-list li') || {}).textContent || '',
      stashPhotoCleared: sessionStorage.getItem('inkcount-stash-photo-v1') === null,
      stashProgressCleared: sessionStorage.getItem('inkcount-stash-progress-v1') === null,
    })`));
    step('crash-resume', resumed.total >= 320 && resumed.total <= 400 &&
      resumed.firstLine.includes('hello world') &&
      resumed.stashPhotoCleared === true && resumed.stashProgressCleared === true, resumed);

    const camera = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      exists: !!document.getElementById('camera-input'),
      capture: document.getElementById('camera-input') ? document.getElementById('camera-input').getAttribute('capture') : null,
      labelHiddenOnDesktop: getComputedStyle(document.getElementById('camera-label')).display === 'none',
      tipHiddenOnDesktop: getComputedStyle(document.querySelector('.framing-tip')).display === 'none',
    })`));
    step('camera-first-markup', camera.exists && camera.capture === 'environment' &&
      camera.labelHiddenOnDesktop === true && camera.tipHiddenOnDesktop === true, camera);

    const audit = await page.collectAudit();
    out.consoleErrors = audit.errors;
    out.externalRequests = audit.resources.filter((u) => !u.startsWith(BASE + '/'));
    step('no-page-errors', audit.errors.length === 0, audit.errors);
    step('no-external-requests', out.externalRequests.length === 0, out.externalRequests);
    out.pass = true;
  } catch (e) {
    out.error = out.error || e.message;
    out.pass = false;
    try {
      out.pageState = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
        status: (document.getElementById('status-text')||{}).textContent,
        errorText: (document.getElementById('error-banner')||{}).textContent,
        pageErrors: window.__errors || [],
      })`));
      log('[ui] failure page state: ' + JSON.stringify(out.pageState));
    } catch {}
  } finally { await page.close(); }
  return out;
}

(async () => {
  log(`[boot] root=${ROOT}`);
  server = await startServer(PORT, ROOT);
  log(`[boot] static server on :${PORT}`);

  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const args = [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  ];
  if (process.env.CI) args.push('--no-sandbox', '--disable-dev-shm-usage');
  args.push('about:blank');
  chrome = spawn(chromeBin(), args, { stdio: 'ignore' });
  chrome.on('error', (e) => { console.error('chrome spawn failed:', e.message); process.exit(2); });
  log(`[boot] chrome pid=${chrome.pid} (${chromeBin()})`);

  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { await http('/json/version'); up = true; } catch { await sleep(500); }
  }
  if (!up) throw new Error('devtools endpoint never came up');
  log('[boot] endpoint up');

  const results = [];
  for (const g of GATES) results.push(g === 'pwa' ? await runPwaGate() : await runGate(g));
  results.push(await runUI());

  const allPass = results.every((r) => r.pass);
  writeFileSync(REPORT, JSON.stringify(results, null, 2));
  log(`report: ${REPORT}`);
  log(allPass ? 'SUITE: PASS' : 'SUITE: FAIL');
  clearTimeout(hardTimeout);
  await cleanup();
  process.exit(allPass ? 0 : 1);
})().catch(async (e) => {
  console.error('SUITE: ERROR —', e && e.stack || e);
  clearTimeout(hardTimeout);
  await cleanup();
  process.exit(2);
});

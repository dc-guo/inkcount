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

const DEFAULT_GATES = 'smoke,assets,count,decode,preprocess,segment,recognize,accuracy,a11y,pwa';
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

const GATE_BUDGET_MS = { recognize: 360000, accuracy: 1200000, pwa: 300000, a11y: 600000 };

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
  try {
    await page.goto(`${BASE}/web/index.html`);
    const readyTitle = await pollTitle(page.id, (t) => / — Ready$/.test(t || ''), 300000, 'cv ready');
    step('opencv-ready', true, readyTitle);

    await evalJS(page.cdp, `document.getElementById('btn-sample').click()`);
    await pollEval(page.cdp, `document.getElementById('active-image-label').textContent`, (s) => /sample_page\.jpg/.test(s || ''), 60000, 'sample label');
    await pollEval(page.cdp, `document.getElementById('btn-run').disabled`, (d) => d === false, 60000, 'run enabled');
    step('sample-loaded', true, null);

    await evalJS(page.cdp, `document.getElementById('btn-run').click()`);
    await pollEval(page.cdp, `document.getElementById('status-text').textContent`, (s) => /^Done/.test(s || ''), 600000, 'run done');
    const final = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      total: document.getElementById('result-total').textContent,
      estimateChipGone: document.getElementById('estimate-chip') === null,
      transcriptItems: document.querySelectorAll('#transcript-list li').length,
      overlayCanvases: document.querySelectorAll('#overlay-slot canvas').length,
      errorHidden: document.getElementById('error-banner').hidden,
    })`));
    out.final = final;
    const total = parseInt(final.total, 10);
    step('count-plausible', total >= 170 && total <= 200, final);
    step('estimate-chip-removed', final.estimateChipGone === true, final);
    step('transcript-rendered', final.transcriptItems === 16, final);
    step('overlay-rendered', final.overlayCanvases === 1, final);
    step('no-error-banner', final.errorHidden === true, final);

    await evalJS(page.cdp, `document.getElementById('btn-reset').click()`);
    const reset = JSON.parse(await evalJS(page.cdp, `JSON.stringify({
      label: document.getElementById('active-image-label').textContent,
      hidden: document.getElementById('results-section') ? document.getElementById('results-section').hidden : true,
    })`));
    step('reset', /No image loaded/.test(reset.label), reset);

    // The old title ends in " — Ready", and /json/list keeps reporting it for
    // a beat after Page.navigate — a bare title poll passes instantly and the
    // sample click lands on a page whose listeners aren't attached yet (the
    // thrice-observed "refresh flake"). Require the NEW load (timeOrigin
    // changed) AND its Ready title.
    const originBefore = await evalJS(page.cdp, 'performance.timeOrigin');
    await page.goto(`${BASE}/web/index.html?reload=1`);
    await pollEval(page.cdp,
      `String(performance.timeOrigin) + '|' + (document.title.endsWith(' — Ready') ? '1' : '0')`,
      (v) => { const parts = String(v).split('|'); return Number(parts[0]) !== originBefore && parts[1] === '1'; },
      300000, 'ready after refresh');
    await evalJS(page.cdp, `document.getElementById('btn-sample').click()`);
    await pollEval(page.cdp, `document.getElementById('btn-run').disabled`, (d) => d === false, 120000, 'run enabled 2');
    await evalJS(page.cdp, `document.getElementById('btn-run').click()`);
    await pollEval(page.cdp, `document.getElementById('status-text').textContent`, (s) => /^Done/.test(s || ''), 600000, 'run after refresh');
    const totalAfter = await evalJS(page.cdp, `document.getElementById('result-total').textContent`);
    step('refresh-then-run', parseInt(totalAfter, 10) >= 170 && parseInt(totalAfter, 10) <= 200, totalAfter);

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

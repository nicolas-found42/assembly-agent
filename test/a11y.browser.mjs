// test/a11y.browser.mjs — browser harness for the ASM::AGENT chat UI.
//
// Runs against a real Chrome and covers:
//   1. axe-core scan (wcag2a/2aa/21a/21aa/22aa) of the default view and every
//      dialog (chats, assistants, model, settings) at 1280x800 — fails on any
//      critical/serious violation, logs the lower-impact ones.
//   2. Keyboard: header buttons are reachable by Tab; each dialog opens with
//      Enter; 20x Tab (and 10x Shift+Tab) stay inside the dialog; Escape closes
//      it and returns focus to #b-input.
//   3. Viewports 375x667 / 320x568: header buttons and #b-send are >= 24x24
//      (44 is logged), the status strip wraps instead of clipping, the page
//      never overflows horizontally.
//   4. Composer: Shift+Enter inserts a newline without sending; Enter sends and
//      flips #b-send to Stop; the running turn is then stopped (or, when the
//      network is unavailable, the offline error row with Retry / Change model
//      is asserted instead — both outcomes are valid and the branch is logged).
//   5. No terminal / diagnostics affordances ("guest@asm", "TOK/S", "MEM",
//      ":mem", "command suggestions", "terminal") in the header, status strip,
//      composer or the served DOM, and the aria labels carry chat copy.
//   6. 200% zoom (640x475): the composer stays usable, overflowing content
//      stays scrollable, no horizontal overflow.
//
// Requires puppeteer-core + Chrome + axe-core. Skips gracefully (exit 0) when
// puppeteer or Chrome is missing. The static app is served over HTTP: a server
// already listening on :8123 is reused, otherwise `python3 -m http.server` is
// started on a free port, otherwise an in-process static server is used.
//
// Run: node test/a11y.browser.mjs     (CHROME_PATH overrides the Chrome binary)
// Static fallback: node test/a11y.mjs runs without a browser.

import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── dependencies ─────────────────────────────────────────────────────────
let puppeteer = null;
let puppeteerSource = null;
const require = createRequire(import.meta.url);
for (const cand of ['/tmp/pptr/node_modules/puppeteer-core', 'puppeteer-core', 'puppeteer']) {
  try {
    puppeteer = require(cand);
    puppeteerSource = cand;
    break;
  } catch { /* try the next candidate */ }
}
if (!puppeteer) {
  console.log('=== a11y browser harness (ASM::AGENT chat UI) ===');
  console.log('SKIP: puppeteer-core not found (tried /tmp/pptr, puppeteer-core, puppeteer).');
  console.log('Install: mkdir -p /tmp/pptr && cd /tmp/pptr && npm init -y && npm i puppeteer-core axe-core');
  console.log('Static harness still passes: node test/a11y.mjs');
  process.exit(0);
}

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const out = execSync('which google-chrome || which chromium-browser || which chromium || which chrome', { encoding: 'utf8' }).trim();
    if (out && existsSync(out.split('\n')[0].trim())) return out.split('\n')[0].trim();
  } catch { /* no browser on PATH */ }
  return null;
}
const chromePath = findChrome();
if (!chromePath) {
  console.log('=== a11y browser harness (ASM::AGENT chat UI) ===');
  console.log('SKIP: Chrome executable not found (set CHROME_PATH).');
  process.exit(0);
}

const axeLocalCandidates = [
  '/tmp/pptr/node_modules/axe-core/axe.min.js',
  join(root, 'node_modules/axe-core/axe.min.js'),
  join(root, '../pptr/node_modules/axe-core/axe.min.js'),
];
let axeSrc = null;
for (const p of axeLocalCandidates) {
  if (existsSync(p)) { axeSrc = readFileSync(p, 'utf8'); break; }
}
const axeCdnUrl = 'https://cdn.jsdelivr.net/npm/axe-core@4.9.1/axe.min.js';

console.log('=== a11y browser harness (ASM::AGENT chat UI) ===');
console.log(`Using Chrome: ${chromePath} via ${puppeteerSource}`);
console.log(axeSrc
  ? `Using local axe-core (${(axeSrc.length / 1024).toFixed(1)}KB)`
  : `Using CDN axe-core: ${axeCdnUrl}`);

// ── static server ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function serveFile(filePath, res) {
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}
function startFallbackServer() {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const fsPath = join(root, urlPath.slice(1));
    if (!fsPath.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    serveFile(fsPath, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
async function servesApp(base) {
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const html = await r.text();
    return html.includes('b-transcript') && html.includes('ASM');
  } catch { return false; }
}
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

let serverOwner = null;   // spawned python3 process, when we own the server
let nodeServer = null;    // in-process fallback, when nothing else serves
let base = null;
{
  const reusePort = Number(process.env.A11Y_PORT || 8123);
  const reuseBase = `http://127.0.0.1:${reusePort}/`;
  if (await servesApp(reuseBase)) {
    base = reuseBase;
    console.log(`Server: ${base} (reused the app already served on :${reusePort})`);
  } else {
    const port = await freePort();
    const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
    child.on('error', () => { /* handled by the readiness probe below */ });
    const tryBase = `http://127.0.0.1:${port}/`;
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(200);
      up = await servesApp(tryBase);
    }
    if (up) {
      serverOwner = child;
      base = tryBase;
      console.log(`Server: ${base} (started python3 -m http.server ${port})`);
    } else {
      child.kill('SIGTERM');
      nodeServer = await startFallbackServer();
      base = `http://127.0.0.1:${nodeServer.address().port}/`;
      console.log(`Server: ${base} (python3 unavailable; in-process static server)`);
    }
  }
}
const stopServer = () => {
  try { serverOwner?.kill('SIGTERM'); } catch { /* already gone */ }
  try { nodeServer?.close(); } catch { /* already closed */ }
};
process.on('exit', stopServer);

// ── harness helpers ──────────────────────────────────────────────────────
const PASS = [];
const FAIL = [];
const NOTES = [];
const ok = (name, cond, detail = '') => {
  if (cond) PASS.push(name);
  else FAIL.push(`${name} — ${detail}`);
};
const note = (msg) => { NOTES.push(msg); console.log(`note: ${msg}`); };
const axeCritical = (violations) => violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');

async function injectAxe(page) {
  if (axeSrc) {
    await page.evaluate(axeSrc);
  } else {
    await page.addScriptTag({ url: axeCdnUrl });
  }
  await page.waitForFunction(() => typeof window.axe !== 'undefined', { timeout: 8000 }).catch(() => {});
}

async function runAxe(page) {
  await injectAxe(page);
  return page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    resultTypes: ['violations'],
  }));
}

/** The app loads its model catalog at boot: "Ready" is the settled state,
 *  "No model list" / "Not available" are the offline states. All are valid
 *  starting points here. */
async function bootWait(page) {
  await page.waitForSelector('#b-transcript', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('#a11y-status', { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(
    () => (document.getElementById('b-st-progress')?.textContent || '').trim() !== 'Starting…',
    { timeout: 20000 },
  ).catch(() => {});
  await sleep(600);
}

const newPage = async (browser, w, h) => {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
  page.pageErrors = errors;
  return page;
};

const progressText = (page) => page.$eval('#b-st-progress', (e) => e.textContent.trim()).catch(() => '');
const sendState = (page) => page.$eval('#b-send', (e) => ({
  text: e.textContent.trim(),
  aria: e.getAttribute('aria-label'),
})).catch(() => ({ text: '', aria: null }));

/** Focus an element and activate it with the keyboard. */
async function keyboardActivate(page, id) {
  await page.evaluate((sel) => document.getElementById(sel).focus(), id);
  await page.keyboard.press('Enter');
}

async function waitForDialog(page, id, want = true, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const open = await page.evaluate((sel) => !!document.getElementById(sel)?.open, id).catch(() => false);
    if (open === want) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

// ── browser ──────────────────────────────────────────────────────────────
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--no-first-run'],
  });
} catch (e) {
  console.error('Failed to launch Chrome:', e.message);
  stopServer();
  process.exit(1);
}

const DIALOGS = [
  { button: 'b-chats', dialog: 'b-dlg-chats' },
  { button: 'b-assist', dialog: 'b-dlg-assistants' },
  { button: 'b-model', dialog: 'b-dlg-model' },
  { button: 'b-settings', dialog: 'b-dlg-settings' },
];

// ── 1. axe scans ─────────────────────────────────────────────────────────
console.log('\n=== axe scans (1280x800, wcag2a/2aa/21a/21aa/22aa) ===');
{
  const states = [{ name: 'default', open: null }].concat(DIALOGS.map((d) => ({
    name: `dialog ${d.dialog}`,
    open: async (page) => {
      await keyboardActivate(page, d.button);
      await waitForDialog(page, d.dialog, true, 4000);
      await sleep(400);
    },
  })));
  for (const st of states) {
    const page = await newPage(browser, 1280, 800);
    await bootWait(page);
    if (st.open) {
      try { await st.open(page); } catch (e) { console.log(`warn ${st.name} open failed: ${e.message}`); }
    }
    await sleep(300);
    let result;
    try {
      result = await runAxe(page);
    } catch (e) {
      ok(`axe ${st.name}`, false, `axe run failed: ${e.message}`);
      await page.close().catch(() => {});
      continue;
    }
    const crit = axeCritical(result.violations);
    const others = result.violations.length - crit.length;
    if (crit.length === 0) {
      ok(`axe ${st.name}: zero critical+serious`, true);
      console.log(`ok  : axe ${st.name} — 0 critical+serious (${others} lower-impact violation(s))`);
    } else {
      ok(`axe ${st.name}: zero critical+serious`, false,
        `${crit.length} critical/serious: ${crit.map((v) => `${v.id}(${v.impact})`).join(', ')}`);
      console.log(`FAIL: axe ${st.name} — ${crit.length} critical/serious`);
      for (const v of crit) {
        console.log(`  - ${v.id} [${v.impact}] ${v.description}`);
        console.log(`    help: ${v.helpUrl}`);
        for (const n of v.nodes.slice(0, 2)) console.log(`    ${n.target} :: ${n.html.slice(0, 140)}`);
      }
    }
    if (others) console.log(`  (lower-impact: ${result.violations.filter((v) => !crit.includes(v)).map((v) => `${v.id}(${v.impact})`).join(', ')})`);
    await page.close().catch(() => {});
  }
}

// ── 2. keyboard harness ──────────────────────────────────────────────────
console.log('\n=== keyboard harness (1280x800) ===');
{
  const page = await newPage(browser, 1280, 800);
  await bootWait(page);

  // Tab must reach every header button, in document order. The walk starts
  // wherever the document currently is (the app focuses #b-input on boot) and
  // runs long enough to wrap past the end of the tab sequence (Chrome parks
  // focus on <body> once at the wrap point).
  const HEADER_IDS = ['b-new', 'b-chats', 'b-assist', 'b-model', 'b-settings'];
  await page.evaluate(() => document.activeElement?.blur());
  const walk = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    await sleep(40);
    walk.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || ''));
  }
  const headerWalk = walk.filter((id) => HEADER_IDS.includes(id));
  ok('Tab reaches every header button in order', headerWalk.join(',') === HEADER_IDS.join(','),
    `walk ${walk.join(',')}`);
  console.log(`  tab walk: ${walk.join(' → ')}`);

  // each dialog: open with Enter, 20x Tab / 10x Shift+Tab stay inside, Escape closes + refocuses
  for (const d of DIALOGS) {
    await keyboardActivate(page, d.button);
    const opened = await waitForDialog(page, d.dialog, true, 4000);
    ok(`${d.dialog} opens with Enter`, opened, 'dialog did not open');
    if (!opened) continue;
    await sleep(400);

    let trap = true;
    let trapDetail = '';
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      await sleep(25);
      const inside = await page.evaluate((sel) => !!document.getElementById(sel)?.contains(document.activeElement), d.dialog);
      if (!inside) {
        trap = false;
        trapDetail = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120) || 'null');
        break;
      }
    }
    ok(`${d.dialog} Tab 20x stays inside`, trap, trapDetail || 'focus leaked outside the dialog');

    let shiftTrap = true;
    for (let i = 0; i < 10; i++) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      await sleep(25);
      const inside = await page.evaluate((sel) => !!document.getElementById(sel)?.contains(document.activeElement), d.dialog);
      if (!inside) { shiftTrap = false; break; }
    }
    ok(`${d.dialog} Shift+Tab 10x stays inside`, shiftTrap, 'shift-tab leaked outside the dialog');

    await page.keyboard.press('Escape');
    const closed = await waitForDialog(page, d.dialog, false, 3000);
    ok(`${d.dialog} Escape closes`, closed, 'dialog still open');
    await sleep(250);
    const focus = await page.evaluate(() => document.activeElement?.id || '');
    ok(`${d.dialog} Escape returns focus to #b-input`, focus === 'b-input', `focus on #${focus}`);
  }
  await page.close();
}

// ── 3. touch targets + reflow at phone widths ────────────────────────────
console.log('\n=== rects & reflow (375x667, 320x568) ===');
for (const vp of [{ w: 375, h: 667 }, { w: 320, h: 568 }]) {
  const page = await newPage(browser, vp.w, vp.h);
  await bootWait(page);
  await sleep(300);

  const measured = await page.evaluate(() => {
    const out = { targets: [], strip: null, overflow: null };
    for (const sel of ['.b-act', '#b-send']) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) continue;
        out.targets.push({ sel, id: el.id || el.className, w: r.width, h: r.height });
      }
    }
    const strip = document.getElementById('b-status');
    const stripKids = [...strip.children].filter((c) => c.getClientRects().length);
    out.strip = {
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      wrap: getComputedStyle(strip).flexWrap,
      clipped: stripKids.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.id || c.className),
      rows: new Set(stripKids.map((c) => Math.round(c.getBoundingClientRect().top))).size,
      items: stripKids.map((c) => ({ id: c.id || c.className, right: c.getBoundingClientRect().right, left: c.getBoundingClientRect().left })),
      text: strip.textContent.replace(/\s+/g, ' ').trim(),
    };
    const doc = document.scrollingElement;
    const t = document.getElementById('b-transcript');
    out.overflow = {
      vw: window.innerWidth,
      docScrollWidth: doc.scrollWidth,
      transcriptOverflowY: getComputedStyle(t).overflowY,
      transcriptClientWidth: t.clientWidth,
      transcriptScrollWidth: t.scrollWidth,
      headerHeight: document.querySelector('.b-header').getBoundingClientRect().height,
      composerVisible: (() => {
        const r = document.getElementById('b-composer').getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0 && r.width > 0;
      })(),
    };
    return out;
  });

  const worst = measured.targets.map((t) => Math.min(t.w, t.h));
  const minTarget = Math.min(...worst);
  const small = measured.targets.filter((t) => t.w < 24 || t.h < 24);
  ok(`touch targets ${vp.w}px: header buttons + #b-send all >= 24x24`, small.length === 0,
    small.map((t) => `${t.id} ${t.w.toFixed(0)}x${t.h.toFixed(0)}`).join(', '));
  const below44 = measured.targets.filter((t) => t.w < 44 || t.h < 44);
  console.log(`  ${vp.w}px targets: min ${minTarget.toFixed(0)}px, ` +
    `${measured.targets.length} measured, sizes ${measured.targets.map((t) => `${t.id}:${t.w.toFixed(0)}x${t.h.toFixed(0)}`).join(' ')}`);
  if (below44.length) console.log(`  (below the 44px ideal: ${below44.map((t) => t.id).join(', ')})`);

  ok(`status strip ${vp.w}px wraps instead of clipping`,
    measured.strip.wrap === 'wrap'
      && measured.strip.clipped.length === 0
      && measured.strip.scrollWidth <= measured.strip.clientWidth + 2
      && measured.strip.items.every((i) => i.left >= -1 && i.right <= measured.overflow.vw + 1),
    `flex-wrap=${measured.strip.wrap}, clipped [${measured.strip.clipped.join(', ')}], ` +
    `scrollWidth ${measured.strip.scrollWidth} vs client ${measured.strip.clientWidth}`);
  console.log(`  ${vp.w}px status: ${measured.strip.rows} row(s), "${measured.strip.text}"`);

  ok(`no horizontal overflow ${vp.w}px`, measured.overflow.docScrollWidth <= measured.overflow.vw + 1,
    `document scrollWidth ${measured.overflow.docScrollWidth} > viewport ${measured.overflow.vw}`);
  ok(`transcript is the scroll container at ${vp.w}px`,
    measured.overflow.transcriptOverflowY === 'auto' || measured.overflow.transcriptOverflowY === 'scroll',
    `overflow-y = ${measured.overflow.transcriptOverflowY}`);
  ok(`composer visible at ${vp.w}px`, measured.overflow.composerVisible, 'composer outside the viewport');
  await page.close();
}

// ── 4. composer: newline, send, stop / offline error ─────────────────────
console.log('\n=== composer turn ===');
{
  const page = await newPage(browser, 1280, 800);
  await bootWait(page);
  const idle = await sendState(page);
  const startProgress = await progressText(page);
  const modelId = (await page.$eval('#b-st-model', (e) => e.textContent.trim()).catch(() => '')).trim();
  console.log(`  boot: progress "${startProgress}", model "${modelId}", send "${idle.text}" / "${idle.aria}"`);

  // Shift+Enter inserts a newline without sending
  await page.click('#b-input');
  await page.keyboard.type('line one');
  const rowsBefore = await page.evaluate(() => document.getElementById('b-transcript').children.length);
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await sleep(250);
  const afterShift = await page.evaluate(() => ({
    value: document.getElementById('b-input').value,
    send: document.getElementById('b-send').textContent.trim(),
    progress: document.getElementById('b-st-progress').textContent.trim(),
    rows: document.getElementById('b-transcript').children.length,
  }));
  ok('Shift+Enter inserts a newline', afterShift.value.includes('\n'), `value ${JSON.stringify(afterShift.value)}`);
  ok('Shift+Enter does not send',
    afterShift.send === 'Send' && afterShift.rows === rowsBefore && afterShift.progress === startProgress,
    `send "${afterShift.send}", transcript rows ${afterShift.rows} (was ${rowsBefore}), progress "${afterShift.progress}"`);

  if (modelId === 'no model') {
    // Offline boot: the catalog never loaded, so there is no chat or model to
    // run a turn with. The app must surface a recoverable notice, and Enter must
    // not pretend to start a turn.
    const offline = await page.evaluate(() => ({
      progress: document.getElementById('b-st-progress').textContent.trim(),
      alertRow: !!document.querySelector('#b-transcript .b-error[role="alert"]'),
      buttons: [...document.querySelectorAll('#b-transcript .b-error button')].map((b) => b.textContent.trim()),
    }));
    ok('no catalog: boot surfaces an alert row offering Try again',
      offline.alertRow && offline.buttons.some((t) => /try again/i.test(t)),
      `alertRow=${offline.alertRow}, buttons ${offline.buttons.join(', ') || 'none'}`);
    await page.keyboard.type('line two');
    await page.keyboard.press('Enter');
    await sleep(800);
    const afterSend = await page.evaluate(() => ({
      send: document.getElementById('b-send').textContent.trim(),
      dialog: document.querySelector('dialog[open]')?.id || null,
    }));
    ok('no catalog: Enter starts no turn', afterSend.send === 'Send' && !afterSend.dialog,
      `send "${afterSend.send}", dialog ${afterSend.dialog}`);
    note(`catalog unavailable ("no model") — live turn and Stop not exercised; asserted the offline notice instead ` +
      `(progress "${offline.progress}", buttons: ${offline.buttons.join(' / ') || 'none'})`);
  } else {
    // Enter sends: the send button flips to Stop and progress leaves its idle text
    await page.keyboard.type('line two');
    await page.keyboard.press('Enter');
    let flipped = null;
    let flippedAria = null;
    let progressDuring = '';
    for (let i = 0; i < 120; i++) {
      const s = await sendState(page);
      if (s.text === 'Stop') { flipped = s.text; flippedAria = s.aria; progressDuring = await progressText(page); break; }
      await sleep(50);
    }
    ok('Enter starts a turn (#b-send becomes Stop)', flipped === 'Stop', 'send button never read "Stop"');
    ok('busy send button re-labels to Stop', flippedAria === 'Stop', `aria-label ${flippedAria}`);
    ok('progress leaves its idle text while a turn runs', progressDuring !== startProgress,
      `progress still "${progressDuring}"`);

    // wait for the search phase or the offline error row
    let branch = 'completed';
    let errButtons = [];
    let lastProgress = progressDuring;
    for (let i = 0; i < 400; i++) {
      const s = await page.evaluate(() => ({
        progress: document.getElementById('b-st-progress').textContent.trim(),
        send: document.getElementById('b-send').textContent.trim(),
        err: !!document.querySelector('#b-transcript .b-error'),
        errButtons: [...document.querySelectorAll('#b-transcript .b-error button')].map((b) => b.textContent.trim()),
      }));
      lastProgress = s.progress;
      if (s.progress.includes('Searching the web')) { branch = 'searching'; break; }
      if (s.err) { branch = 'error'; errButtons = s.errButtons; break; }
      if (s.send === 'Send' && !s.err) { branch = 'completed'; break; }
      await sleep(50);
    }

    if (branch === 'searching') {
      const during = await sendState(page);
      console.log(`  branch: search phase observed (progress "${lastProgress}", send "${during.text}")`);
      ok('send button stays Stop through the search phase', during.text === 'Stop', `send "${during.text}"`);
      // stop the running turn
      await page.click('#b-send');
      let backToSend = null;
      for (let i = 0; i < 120; i++) {
        const s = await sendState(page);
        if (s.text === 'Send') { backToSend = s; break; }
        await sleep(50);
      }
      ok('Stop returns #b-send to Send', backToSend?.text === 'Send', 'send button never returned to "Send"');
      ok('Stop restores the Send aria-label', backToSend?.aria === 'Send message', `aria-label ${backToSend?.aria}`);
      let settled = '';
      for (let i = 0; i < 120; i++) {
        settled = await progressText(page);
        if (!/Searching the web|Stopping/.test(settled)) break;
        await sleep(50);
      }
      ok('progress settles after Stop', !/Searching the web|Stopping/.test(settled), `progress "${settled}"`);
      console.log(`  after Stop: progress "${settled}", send "${backToSend?.text}"`);
      note('composer stop path: search phase observed, turn stopped via #b-send');
    } else if (branch === 'error') {
      console.log(`  branch: offline/error path (progress "${lastProgress}", error buttons: ${errButtons.join(' / ') || 'none'})`);
      ok('offline error row offers Retry', errButtons.some((t) => /retry/i.test(t)), `buttons ${errButtons.join(', ') || 'none'}`);
      ok('offline error row offers Change model', errButtons.some((t) => /change model/i.test(t)),
        `buttons ${errButtons.join(', ') || 'none'}`);
      const after = await sendState(page);
      ok('send button returns to Send after the error', after.text === 'Send', `send "${after.text}"`);
      note(`composer error path: turn failed (offline) — Retry / Change model row asserted instead of Stop; buttons: ${errButtons.join(' / ')}`);
    } else {
      const after = await sendState(page);
      console.log(`  branch: turn completed before the search phase was observed (progress "${lastProgress}", send "${after.text}")`);
      ok('turn settles back to Send', after.text === 'Send', `send "${after.text}"`);
      note('composer: the turn finished before the search phase was sampled — label flip verified, Stop not exercised');
    }
  }
  if (page.pageErrors.length) console.log(`  page errors: ${page.pageErrors.join(' | ')}`);
  await page.close();
}

// ── 5. no terminal / diagnostics affordances ─────────────────────────────
console.log('\n=== diagnostics affordances ===');
{
  const page = await newPage(browser, 1280, 800);
  await bootWait(page);
  const forbidden = ['guest@asm', 'tok/s', 'mem', ':mem', 'command suggestions', 'terminal'];
  const scan = await page.evaluate((patterns) => {
    const model = document.getElementById('b-st-model');
    const modelText = model ? model.textContent : '';
    const bodyText = document.body.innerText.replace(modelText, '');
    const attrs = [];
    for (const el of document.body.querySelectorAll('*')) {
      for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute?.(name);
        if (v) attrs.push(`${name}="${v}"`);
      }
    }
    const surfaces = {
      header: document.querySelector('.b-header')?.textContent || '',
      status: document.getElementById('b-status')?.textContent || '',
      composer: document.getElementById('b-composer')?.textContent || '',
      document: bodyText,
      attributes: attrs.join('\n'),
    };
    const hits = [];
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const p of patterns) {
        const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const m = re.exec(text);
        if (m) hits.push(`${surface}: "${p}" → …${text.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')}…`);
      }
    }
    const labels = {
      nav: document.querySelector('.b-acts')?.getAttribute('aria-label'),
      input: document.getElementById('b-input')?.getAttribute('aria-label'),
      placeholder: document.getElementById('b-input')?.getAttribute('placeholder'),
      transcript: document.getElementById('b-transcript')?.getAttribute('aria-label'),
      transcriptRole: document.getElementById('b-transcript')?.getAttribute('role'),
      status: document.getElementById('b-status')?.getAttribute('aria-label'),
      statusRole: document.getElementById('b-status')?.getAttribute('role'),
      send: document.getElementById('b-send')?.getAttribute('aria-label'),
      a11yStatus: document.getElementById('a11y-status')?.getAttribute('aria-live'),
    };
    return { hits, labels };
  }, forbidden);
  ok('no terminal/diagnostics strings in header, status, composer or DOM', scan.hits.length === 0, scan.hits.join(' | '));
  if (scan.hits.length) for (const h of scan.hits) console.log(`  hit: ${h}`);
  const l = scan.labels;
  ok('aria labels use chat copy',
    l.nav === 'App' && l.input === 'Message' && l.placeholder === 'Ask a question'
      && l.transcript === 'Chat history' && l.transcriptRole === 'log'
      && l.status === 'Status' && l.statusRole === 'group' && l.send === 'Send message',
    JSON.stringify(l));
  console.log(`  labels: ${JSON.stringify(l)}`);
  await page.close();
}

// ── 6. 200% zoom / reflow (640x475) ──────────────────────────────────────
console.log('\n=== zoom / reflow 200% (640x475) ===');
{
  const page = await newPage(browser, 640, 475);
  await bootWait(page);
  await sleep(300);
  const zoom = await page.evaluate(() => {
    const doc = document.scrollingElement;
    const t = document.getElementById('b-transcript');
    const input = document.getElementById('b-input');
    const send = document.getElementById('b-send');
    const iRect = input.getBoundingClientRect();
    const sRect = send.getBoundingClientRect();
    const docOverflow = doc.scrollHeight - doc.clientHeight;
    let scrollMoved = false;
    if (docOverflow > 0) {
      doc.scrollTop = doc.scrollHeight;
      scrollMoved = doc.scrollTop > 0;
      doc.scrollTop = 0;
    } else {
      // the shell is fixed-height by design; the transcript must scroll instead
      const probe = document.createElement('div');
      probe.style.height = '1200px';
      t.append(probe);
      t.scrollTop = 99999;
      scrollMoved = t.scrollTop > 0;
      probe.remove();
      t.scrollTop = 0;
    }
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      docScrollWidth: doc.scrollWidth,
      docOverflow,
      transcriptOverflowY: getComputedStyle(t).overflowY,
      scrollMoved,
      inputInView: iRect.top >= 0 && iRect.bottom <= window.innerHeight && iRect.width > 0,
      inputWidth: iRect.width,
      inputHeight: iRect.height,
      sendInView: sRect.top >= 0 && sRect.bottom <= window.innerHeight,
      sendW: sRect.width,
      sendH: sRect.height,
    };
  });
  ok('zoom: input stays in the viewport', zoom.inputInView,
    `input ${zoom.inputWidth.toFixed(0)}x${zoom.inputHeight.toFixed(0)}`);
  ok('zoom: send stays in the viewport and >= 24x24', zoom.sendInView && zoom.sendW >= 24 && zoom.sendH >= 24,
    `send ${zoom.sendW.toFixed(0)}x${zoom.sendH.toFixed(0)} inView=${zoom.sendInView}`);
  ok('zoom: overflowing content stays scrollable',
    zoom.scrollMoved && (zoom.transcriptOverflowY === 'auto' || zoom.transcriptOverflowY === 'scroll'),
    `scrollMoved=${zoom.scrollMoved}, transcript overflow-y=${zoom.transcriptOverflowY}, doc overflow=${zoom.docOverflow}`);
  ok('zoom: no horizontal overflow', zoom.docScrollWidth <= zoom.vw + 1,
    `document scrollWidth ${zoom.docScrollWidth} > viewport ${zoom.vw}`);

  // the composer still works at this size
  await page.click('#b-input');
  await page.keyboard.type('zoom check');
  const typed = await page.$eval('#b-input', (e) => e.value);
  ok('zoom: composer accepts typing', typed === 'zoom check', `value ${JSON.stringify(typed)}`);
  const composerVisible = await page.evaluate(() => {
    const r = document.getElementById('b-composer').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
  });
  ok('zoom: composer fully visible', composerVisible, 'composer clipped by the viewport');
  await page.evaluate(() => { document.getElementById('b-input').value = ''; });
  console.log(`  zoom metrics: ${JSON.stringify(zoom)}`);
  await page.close();
}

// ── summary ──────────────────────────────────────────────────────────────
console.log('\n=== summary ===');
console.log(`PASS ${PASS.length} / ${PASS.length + FAIL.length}`);
for (const p of PASS) console.log(`ok  : ${p}`);
for (const f of FAIL) console.log(`FAIL: ${f}`);
if (NOTES.length) {
  console.log('\nnotes');
  for (const n of NOTES) console.log(`  - ${n}`);
}

await browser.close().catch(() => {});
stopServer();
if (FAIL.length) {
  console.error(`\n${FAIL.length} failure(s)`);
  process.exit(1);
} else {
  console.log('\nALL BROWSER A11Y PASS');
  process.exit(0);
}

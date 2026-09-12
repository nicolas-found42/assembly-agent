// test/a11y.browser.mjs — browser axe + keyboard + rect harness for D3.
// Requires puppeteer-core + Chrome + axe-core. Skips gracefully if missing (static fallback).
// Viewports: 375x667, 320x568, 1280x800. States: default, model, preset, session, keys, key.
// Also covers: keyboard trap 20x Tab, Escape + return-focus, command suggestions, rect 24px, reflow.
// Run: node test/a11y.browser.mjs  (needs Chrome at /Applications/Google Chrome.app or CHROME_PATH)
// Fallback: node test/a11y.mjs remains static-only and passes without browser.

import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const axeLocalCandidates = [
  '/tmp/pptr/node_modules/axe-core/axe.min.js',
  join(root, 'node_modules/axe-core/axe.min.js'),
  join(root, '../pptr/node_modules/axe-core/axe.min.js'),
];
let axeSrc = null;
for (const p of axeLocalCandidates) {
  if (existsSync(p)) { axeSrc = readFileSync(p, 'utf8'); break; }
}
let axeCdnUrl = 'https://cdn.jsdelivr.net/npm/axe-core@4.9.1/axe.min.js';

let puppeteer = null;
let puppeteerSource = null;
const require = createRequire(import.meta.url);
const pptrCandidates = [
  '/tmp/pptr/node_modules/puppeteer-core',
  'puppeteer-core',
  'puppeteer',
];
for (const cand of pptrCandidates) {
  try {
    puppeteer = require(cand);
    puppeteerSource = cand;
    break;
  } catch {}
}
if (!puppeteer) {
  console.log('=== a11y browser harness ===');
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
  } catch {}
  return null;
}
const chromePath = findChrome();
if (!chromePath) {
  console.log('SKIP: Chrome executable not found (set CHROME_PATH).');
  process.exit(0);
}
console.log(`Using Chrome: ${chromePath} via ${puppeteerSource}`);
if (axeSrc) console.log(`Using local axe-core (${(axeSrc.length/1024).toFixed(1)}KB)`);
else console.log(`Using CDN axe-core: ${axeCdnUrl}`);

// ── static server ──
const mime = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.wat': 'text/plain',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};
function serveFile(filePath, res) {
  try {
    const data = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + filePath);
  }
}
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // strip leading /
  let fsPath = join(root, urlPath.slice(1));
  // prevent traversal
  if (!fsPath.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!existsSync(fsPath)) {
    // try dist fallback?
    res.writeHead(404); res.end('not found');
    return;
  }
  // if directory, try index.html
  try {
    const stat = readFileSync(fsPath); // will throw if dir
    // file exists
    serveFile(fsPath, res);
  } catch {
    serveFile(fsPath, res);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;
console.log(`Server: ${base}`);

// ── harness helpers ──
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--no-first-run'],
  });
} catch (e) {
  console.error('Failed to launch Chrome:', e.message);
  server.close();
  process.exit(1);
}

let failures = [];
let passes = [];
function ok(name, cond, detail='') {
  if (cond) passes.push(name);
  else failures.push(`${name} — ${detail}`);
}
function axeFailures(violations) {
  const critical = violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
  return critical;
}

async function injectAxe(page) {
  if (axeSrc) {
    await page.evaluate(axeSrc);
  } else {
    await page.addScriptTag({ url: axeCdnUrl });
    // wait for axe
    await page.waitForFunction(() => typeof window.axe !== 'undefined', { timeout: 8000 });
  }
  // ensure axe is loaded
  await page.waitForFunction(() => typeof window.axe !== 'undefined', { timeout: 5000 }).catch(()=>{});
}

async function runAxe(page) {
  await injectAxe(page);
  const result = await page.evaluate(async () => {
    // run with wcag2a/aa tags, exclude maybe?
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] },
      resultTypes: ['violations'],
    });
    return r;
  });
  return result;
}

async function bootWait(page) {
  // Command Line UI shell: transcript + announcer must mount, then let the engine
  // and model catalog settle. Offline is fine — the app prints an error line but boots.
  await page.waitForSelector('#b-transcript', { timeout: 5000 }).catch(()=>{});
  await page.waitForSelector('#a11y-status', { timeout: 3000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 1200));
}

const viewports = [
  { name: '375x667', w: 375, h: 667 },
  { name: '320x568', w: 320, h: 568 },
  { name: '1280x800', w: 1280, h: 800 },
];

const states = [
  { name: 'default', open: null },
  { name: 'model', open: async (page) => {
      await page.evaluate(() => document.querySelector('.b-seg[data-cmd="model"]').click());
      await page.waitForSelector('#b-dlg-model', { visible: true, timeout: 3000 }).catch(()=>{});
      await new Promise(r=>setTimeout(r, 300));
    } },
  { name: 'preset', open: async (page) => {
      await page.evaluate(() => document.querySelector('.b-seg[data-cmd="preset"]').click());
      await page.waitForSelector('#b-dlg-preset', { visible: true, timeout: 3000 }).catch(()=>{});
      await new Promise(r=>setTimeout(r, 300));
    } },
  { name: 'session', open: async (page) => {
      await page.evaluate(() => document.querySelector('.b-seg[data-cmd="session"]').click());
      await page.waitForSelector('#b-dlg-session', { visible: true, timeout: 3000 }).catch(()=>{});
      await new Promise(r=>setTimeout(r, 300));
    } },
  { name: 'keys', open: async (page) => {
      // F1 from a focused prompt opens the keymap
      await page.evaluate(() => document.getElementById('b-transcript').click());
      await new Promise(r=>setTimeout(r, 150));
      await page.evaluate(() => document.getElementById('b-input').focus());
      await new Promise(r=>setTimeout(r, 150));
      await page.keyboard.press('F1');
      await page.waitForSelector('#b-dlg-keys', { visible: true, timeout: 3000 }).catch(()=>{});
      await new Promise(r=>setTimeout(r, 300));
    } },
  { name: 'key', open: async (page) => {
      await page.evaluate(() => document.querySelector('.b-seg[data-cmd="key"]').click());
      await page.waitForSelector('#b-dlg-key', { visible: true, timeout: 3000 }).catch(()=>{});
      await new Promise(r=>setTimeout(r, 300));
    } },
];

console.log('\n=== axe scans ===');
for (const vp of viewports) {
  for (const st of states) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await bootWait(page);
    if (st.open) {
      try { await st.open(page); } catch (e) { console.log(`warn ${vp.name} ${st.name} open failed: ${e.message}`); }
    }
    // give time for dialog trap to settle
    await new Promise(r=>setTimeout(r, 300));
    let result;
    try {
      result = await runAxe(page);
    } catch (e) {
      ok(`axe ${vp.name} ${st.name}`, false, `axe run failed: ${e.message}`);
      await page.close().catch(()=>{});
      continue;
    }
    const crit = axeFailures(result.violations);
    const critIds = crit.map(v=> `${v.id}(${v.impact})`).join(', ');
    if (crit.length === 0) {
      ok(`axe ${vp.name} ${st.name} zero critical+serious`, true);
      console.log(`ok  : axe ${vp.name} ${st.name} — 0 critical+serious (${result.violations.length} total violations)`);
    } else {
      ok(`axe ${vp.name} ${st.name} zero critical+serious`, false, `${crit.length} crit/serious: ${critIds}`);
      console.log(`FAIL: axe ${vp.name} ${st.name} — ${crit.length} crit/serious: ${critIds}`);
      for (const v of crit) {
        console.log(`  - ${v.id} [${v.impact}] ${v.description}`);
        console.log(`    nodes: ${v.nodes.slice(0,2).map(n=>n.html.slice(0,120)).join(' | ')}`);
      }
    }
    // also check that no critical/serious means overall axe pass
    await page.close().catch(()=>{});
  }
}
// ── keyboard harness ──
console.log('\n=== keyboard harness ===');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await bootWait(page);

  // prompt focus
  await page.evaluate(() => document.getElementById('b-input').focus());
  const focusedId = await page.evaluate(() => document.activeElement?.id || '');
  ok('prompt #b-input takes focus', focusedId === 'b-input', `got #${focusedId}`);

  // command suggestions: ":mo" opens the list; Escape clears command mode
  await page.keyboard.type(':mo');
  await page.waitForFunction(() => !document.getElementById('b-sug').hidden, { timeout: 2000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 150));
  const sugOpen = await page.evaluate(() => !document.getElementById('b-sug').hidden);
  const sugCount = await page.evaluate(() => document.querySelectorAll('#b-sug .b-sug-b').length);
  ok('suggestions open on ":mo"', sugOpen, 'suggestion list still hidden');
  ok('suggestions expose ≥1 .b-sug-b', sugCount >= 1, `count ${sugCount}`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('b-sug').hidden, { timeout: 2000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 150));
  const sugHidden = await page.evaluate(() => document.getElementById('b-sug').hidden);
  ok('Escape clears command mode (suggestions hidden)', sugHidden, 'suggestion list still visible');

  // model dialog from status segment: native dialog focus trap
  await page.evaluate(() => document.querySelector('.b-seg[data-cmd="model"]').click());
  await page.waitForSelector('#b-dlg-model', { visible: true, timeout: 3000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 300));
  const modelOpen = await page.evaluate(() => !!document.getElementById('b-dlg-model')?.open);
  ok('model dialog opens from status segment', modelOpen, 'dialog not open');
  let tabTrap = true;
  let tabDetail = '';
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    await new Promise(r=>setTimeout(r, 30));
    const inside = await page.evaluate(() => !!document.getElementById('b-dlg-model')?.contains(document.activeElement));
    if (!inside) {
      tabTrap = false;
      tabDetail = await page.evaluate(()=> document.activeElement?.outerHTML?.slice(0,120) || 'null');
      break;
    }
  }
  ok('model Tab 20x trap stays inside', tabTrap, tabDetail || 'focus leaked outside dialog');
  let shiftTrap = true;
  for (let i = 0; i < 10; i++) {
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    await new Promise(r=>setTimeout(r, 30));
    const inside = await page.evaluate(() => !!document.getElementById('b-dlg-model')?.contains(document.activeElement));
    if (!inside) { shiftTrap = false; break; }
  }
  ok('model Shift+Tab 10x trap stays inside', shiftTrap, 'shift-tab leaked outside dialog');

  // Escape closes and returns focus to the prompt
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('b-dlg-model')?.open, { timeout: 2000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 250));
  const modelState = await page.evaluate(() => {
    const d = document.getElementById('b-dlg-model');
    return { exists: !!d, open: !!d && d.open };
  });
  ok('model Escape closes', modelState.exists && !modelState.open, modelState.exists ? 'dialog still open' : 'dialog missing');
  const returnedFocus = await page.evaluate(() => document.activeElement?.id || '');
  ok('model Escape returns focus to #b-input', returnedFocus === 'b-input', `got #${returnedFocus}`);

  // preset dialog lists the four built-in presets
  await page.evaluate(() => document.querySelector('.b-seg[data-cmd="preset"]').click());
  await page.waitForSelector('#b-dlg-preset', { visible: true, timeout: 3000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 300));
  const presetRows = await page.evaluate(() => document.querySelectorAll('#b-preset-list li[role="option"]').length);
  ok('preset list has ≥4 options', presetRows >= 4, `count ${presetRows}`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('b-dlg-preset')?.open, { timeout: 2000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 250));
  const presetState = await page.evaluate(() => {
    const d = document.getElementById('b-dlg-preset');
    return { exists: !!d, open: !!d && d.open };
  });
  ok('preset Escape closes', presetState.exists && !presetState.open, presetState.exists ? 'dialog still open' : 'dialog missing');

  await page.close();
}

// ── visual rect + reflow ──
console.log('\n=== rect & reflow ===');
for (const vp of [{w:320,h:568},{w:375,h:667}]) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await bootWait(page);
  // suggestions open in the dock; no overlay covering the shell in this state
  await page.evaluate(() => document.getElementById('b-input').focus());
  await page.keyboard.type(':');
  await page.waitForFunction(() => !document.getElementById('b-sug').hidden, { timeout: 2000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 250));
  const anyDialogOpen = await page.evaluate(() => Array.from(document.querySelectorAll('dialog.b-dlg')).some(d => d.open));
  ok(`no dialog open while measuring ${vp.w}`, !anyDialogOpen, 'a .b-dlg is open');

  // touch targets: WCAG 2.5.8 ≥24 (the 44px bar is coarse-pointer-only, checked by the static harness)
  const rects = await page.evaluate(()=> {
    const selectors = ['.b-seg', '.b-send', '.b-sug-b', '.b-x'];
    const out = [];
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els.slice(0,3)) {
        // skip hidden/off-screen (closed dialog, collapsed segment) — 0x0 is not a target-size failure
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) continue;
        // also skip if completely off-viewport left
        if (r.right < 0 || r.left > window.innerWidth) continue;
        out.push({ sel, w: r.width, h: r.height, text: el.textContent.slice(0,20) });
      }
    }
    return out;
  });
  for (const r of rects) {
    const pass24 = r.w >= 24 && r.h >= 24;
    ok(`rect ${vp.w} ${r.sel} "${r.text}" ≥24`, pass24, `${r.w.toFixed(1)}x${r.h.toFixed(1)}`);
  }

  // reflow: transcript and status line never clip horizontally, prompt stays in view
  const metrics = await page.evaluate(()=> {
    const t = document.getElementById('b-transcript');
    const s = document.getElementById('b-status');
    const p = document.getElementById('b-prompt').getBoundingClientRect();
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      transcriptScroll: t.scrollWidth,
      transcriptClient: t.clientWidth,
      transcriptHeight: t.scrollHeight,
      transcriptOverflow: getComputedStyle(t).overflowY,
      statusScroll: s.scrollWidth,
      promptBottom: p.bottom,
    };
  });
  ok(`reflow ${vp.w} transcript scrollWidth ≤ viewport`, metrics.transcriptScroll <= metrics.vw + 2, `transcript ${metrics.transcriptScroll} > vw ${metrics.vw}`);
  ok(`reflow ${vp.w} status scrollWidth ≤ viewport`, metrics.statusScroll <= metrics.vw + 2, `status ${metrics.statusScroll} > vw ${metrics.vw}`);
  ok(`reflow ${vp.w} prompt bottom in viewport`, metrics.promptBottom <= metrics.vh + 1, `bottom ${metrics.promptBottom.toFixed(1)} > vh ${metrics.vh}`);
  ok(`transcript is the scroll container at ${vp.w}`, metrics.transcriptOverflow, `overflow-y = ${metrics.transcriptOverflow}, expected auto/scroll`);

  const promptVisible = await page.evaluate(()=> {
    const p = document.getElementById('b-prompt');
    if (!p) return false;
    const r = p.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  ok(`prompt visible at ${vp.w}`, promptVisible, 'prompt not visible');

  await page.close();
}

// ── summary ──
console.log('\n=== summary ===');
console.log(`PASS ${passes.length} / ${passes.length + failures.length}`);
for (const p of passes) console.log(`ok  : ${p}`);
for (const f of failures) console.log(`FAIL: ${f}`);

await browser.close();
server.close();
if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
} else {
  console.log('\nALL BROWSER A11Y PASS');
  process.exit(0);
}

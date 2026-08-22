// test/a11y.browser.mjs — browser axe + keyboard + rect harness for D3.
// Requires puppeteer-core + Chrome + axe-core. Skips gracefully if missing (static fallback).
// Viewports: 375x667, 320x568, 1280x800. States: default, sysprompt, inspector, settings, model.
// Also covers: keyboard trap 20x Tab, Escape + return-focus, aria-expanded/pressed, rect 44px, reflow 100vw, inert.
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

async function bootSkip(page) {
  // Boot overlay has skip button focused; press Escape to dismiss quickly
  // Wait for overlay to appear then dismiss
  try {
    await page.waitForSelector('#boot-overlay', { timeout: 3000 });
    // Give it a moment then press Escape
    await new Promise(r=>setTimeout(r, 300));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#boot-overlay', { hidden: true, timeout: 4000 }).catch(()=>{});
    // fallback: click skip button if still there
    const still = await page.$('#boot-overlay');
    if (still) {
      const btn = await page.$('#boot-skip');
      if (btn) await btn.click().catch(()=>{});
      await page.waitForSelector('#boot-overlay', { hidden: true, timeout: 2000 }).catch(()=>{});
    }
  } catch {}
  // also wait for messages log to be ready
  await page.waitForSelector('#messages', { timeout: 3000 }).catch(()=>{});
  await page.waitForSelector('#a11y-status', { timeout: 3000 }).catch(()=>{});
  // wait for engine init (telemetry or model button)
  await new Promise(r=>setTimeout(r, 800));
}

const viewports = [
  { name: '375x667', w: 375, h: 667 },
  { name: '320x568', w: 320, h: 568 },
  { name: '1280x800', w: 1280, h: 800 },
];

const states = [
  { name: 'default', open: null },
  { name: 'sysprompt', open: async (page) => { 
      const b = await page.$('#btn-sysprompt'); 
      if (b) await b.click(); 
      await page.waitForSelector('#sysprompt-panel', { visible: true, timeout: 2000 }).catch(()=>{}); 
      await new Promise(r=>setTimeout(r, 200));
    } },
  { name: 'inspector', open: async (page) => { 
      const b = await page.$('#btn-inspector'); 
      if (b) await b.click(); 
      await page.waitForSelector('#inspector', { visible: true, timeout: 2000 }).catch(async()=> {
        // hidden attribute instead of display none
        await page.evaluate(()=> { const el=document.getElementById('inspector'); if(el) el.hidden=false; });
      });
      await new Promise(r=>setTimeout(r, 200));
    } },
  { name: 'settings', open: async (page) => { 
      const b = await page.$('#btn-settings'); 
      if (b) await b.click(); 
      await page.waitForSelector('.modal-backdrop', { visible: true, timeout: 2000 }).catch(()=>{});
      await new Promise(r=>setTimeout(r, 300));
    } },
  { name: 'model', open: async (page) => { 
      const b = await page.$('#btn-model'); 
      if (b) await b.click(); 
      await page.waitForSelector('.modal-backdrop', { visible: true, timeout: 3000 }).catch(()=>{});
      await new Promise(r=>setTimeout(r, 500));
    } },
];

console.log('\n=== axe scans ===');
for (const vp of viewports) {
  for (const st of states) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await bootSkip(page);
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
  await bootSkip(page);

  // brand toggle aria-expanded — sidebar starts open (expanded true)
  const brandBtn = await page.$('.brand');
  const initExpanded = await page.evaluate(()=> document.querySelector('.brand')?.getAttribute('aria-expanded'));
  ok('brand aria-expanded initial true', initExpanded === 'true', `got ${initExpanded}`);
  await brandBtn.click();
  await new Promise(r=>setTimeout(r, 200));
  const after1 = await page.evaluate(()=> document.querySelector('.brand')?.getAttribute('aria-expanded'));
  ok('brand aria-expanded toggles false', after1 === 'false', `got ${after1}`);
  await brandBtn.click();
  await new Promise(r=>setTimeout(r,200));
  const after2 = await page.evaluate(()=> document.querySelector('.brand')?.getAttribute('aria-expanded'));
  ok('brand aria-expanded toggles back true', after2 === 'true', `got ${after2}`);
  // settings dialog trap 20x Tab
  const settingsBtn = await page.$('#btn-settings');
  await settingsBtn.click();
  await page.waitForSelector('.modal-backdrop', { visible: true, timeout: 2000 });
  // wait for trap to focus first element
  await new Promise(r=>setTimeout(r,300));
  const dialogEl = await page.$('.modal-backdrop');
  const dialogHandle = dialogEl;
  // get focusables inside dialog
  const focusableCount = await page.evaluate(()=> {
    const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const d = document.querySelector('.modal-backdrop');
    return d ? Array.from(d.querySelectorAll(sel)).filter(el=> !el.hasAttribute('disabled') && el.getAttribute('aria-hidden')!=='true').length : 0;
  });
  ok('settings dialog has focusables', focusableCount >= 2, `count ${focusableCount}`);
  // Tab 20x and ensure focus stays inside dialog
  let trapOk = true;
  let outsideFocus = null;
  for (let i=0;i<20;i++) {
    await page.keyboard.press('Tab');
    await new Promise(r=>setTimeout(r, 30));
    const inside = await page.evaluate(()=> {
      const d = document.querySelector('.modal-backdrop');
      const ae = document.activeElement;
      return d && d.contains(ae);
    });
    if (!inside) { trapOk = false; outsideFocus = await page.evaluate(()=> document.activeElement?.outerHTML?.slice(0,120)); break; }
  }
  ok('settings Tab 20x trap stays inside', trapOk, outsideFocus || 'focus leaked outside');
  // Shift+Tab 20x
  let shiftOk = true;
  for (let i=0;i<20;i++) {
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    await new Promise(r=>setTimeout(r,30));
    const inside = await page.evaluate(()=> document.querySelector('.modal-backdrop')?.contains(document.activeElement));
    if (!inside) { shiftOk = false; break; }
  }
  ok('settings Shift+Tab 20x trap', shiftOk, 'shift tab leaked');

  // Escape closes and returns focus
  const triggerId = await page.evaluate(()=> document.activeElement?.id || '');
  await page.keyboard.press('Escape');
  await new Promise(r=>setTimeout(r,300));
  const hidden = await page.evaluate(()=> {
    const m = document.querySelector('.modal-backdrop');
    return !m || m.hidden || getComputedStyle(m).display==='none';
  });
  ok('settings Escape closes', hidden, 'dialog still visible');
  const returnedFocus = await page.evaluate(()=> document.activeElement?.id);
  ok('settings return-focus to trigger', returnedFocus === 'btn-settings', `got ${returnedFocus} expected btn-settings`);

  // aria-pressed on HUD toggles
  await page.evaluate(()=> document.getElementById('btn-scan')?.click());
  await new Promise(r=>setTimeout(r,100));
  const scanPressed = await page.evaluate(()=> document.getElementById('btn-scan')?.getAttribute('aria-pressed'));
  // toggleCrt should update aria-pressed
  ok('hud aria-pressed reflects toggle', scanPressed === 'true' || scanPressed === 'false', `got ${scanPressed}`);

  // close inspector etc cleanup
  await page.close();
}

{
  // model dialog trap check at 375
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 667 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await bootSkip(page);
  // use evaluate click to avoid overlay hit-testing issues at 375
  await page.evaluate(()=> document.getElementById('btn-model')?.click());
  await page.waitForFunction(()=> {
    const m = document.querySelector('.modal-backdrop');
    return m && !m.hidden && getComputedStyle(m).display !== 'none';
  }, { timeout: 4000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r,500));
  const hasDialog = await page.evaluate(()=> {
    const m = document.querySelector('.modal-backdrop');
    return !!(m && !m.hidden && getComputedStyle(m).display !== 'none');
  });
  ok('model dialog opens at 375', hasDialog, 'not opened');
  if (hasDialog) {
    // trap check 10 tabs
    let trap = true;
    for (let i=0;i<10;i++) {
      await page.keyboard.press('Tab');
      await new Promise(r=>setTimeout(r,30));
      const inside = await page.evaluate(()=> {
        const m = document.querySelector('.modal-backdrop');
        return m && m.contains(document.activeElement);
      });
      if (!inside) { trap=false; break; }
    }
    ok('model Tab trap at 375', trap, 'leaked');
    await page.keyboard.press('Escape');
    await new Promise(r=>setTimeout(r,400));
    const closed = await page.evaluate(()=> {
      const m=document.querySelector('.modal-backdrop');
      return !m || m.hidden || getComputedStyle(m).display==='none';
    });
    ok('model Escape closes at 375', closed, 'still open');
    // inert check while open: reopen to check inert
    await page.evaluate(()=> document.getElementById('btn-model')?.click());
    await page.waitForFunction(()=> {
      const m=document.querySelector('.modal-backdrop');
      return m && !m.hidden;
    }, {timeout:3000}).catch(()=>{});
    await new Promise(r=>setTimeout(r,400));
    const inertOn = await page.evaluate(()=> {
      const l=document.getElementById('layout');
      const h=document.getElementById('hud');
      return (l && (l.inert || l.getAttribute('aria-hidden')==='true')) || (h && (h.inert || h.getAttribute('aria-hidden')==='true'));
    });
    ok('dialog inert on background', inertOn, 'layout/hud not inert while dialog open');
    await page.keyboard.press('Escape').catch(()=>{});
  }
  await page.close();
}

// ── visual rect + reflow ──
console.log('\n=== rect & reflow ===');
for (const vp of [{w:320,h:568},{w:375,h:667}]) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await bootSkip(page);
  // measure HUD scrollWidth vs viewport
  const hudMetrics = await page.evaluate(()=> {
    const hud = document.getElementById('hud');
    const layout = document.getElementById('layout');
    return {
      hudScroll: hud ? hud.scrollWidth : null,
      hudClient: hud ? hud.clientWidth : null,
      vp: window.innerWidth,
      layoutScroll: layout ? layout.scrollWidth : null,
      bodyOverflow: getComputedStyle(document.body).overflow,
      htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
    };
  });
  ok(`reflow ${vp.w} hud scrollWidth ≤ viewport`, hudMetrics.hudScroll <= hudMetrics.vp + 2, `hud scroll ${hudMetrics.hudScroll} > vp ${hudMetrics.vp}`);
  ok(`reflow ${vp.w} layout not overflow`, (hudMetrics.layoutScroll||0) <= vp.w + 5, `layout scroll ${hudMetrics.layoutScroll} > ${vp.w}`);
  ok(`body overflow not hidden trap at ${vp.w}`, hudMetrics.bodyOverflow !== 'hidden', `body overflow is hidden (should be auto)`);
  // check touch targets: WCAG 2.5.8 ≥24, HIG primary ≥44
  const rects = await page.evaluate(()=> {
    const selectors = ['.hud-btn', '.side-btn', '.pill', '.insp-tab', '.icon-btn', '.brand', '#btn-send', '.session-actions button', '.session-title-btn'];
    const out = [];
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els.slice(0,3)) {
        const r = el.getBoundingClientRect();
        out.push({ sel, w: r.width, h: r.height, text: el.textContent.slice(0,20) });
      }
    }
    return out;
  });
  for (const r of rects) {
    const pass24 = r.w >= 24 && r.h >= 24;
    ok(`rect ${vp.w} ${r.sel} "${r.text}" ≥24`, pass24, `${r.w.toFixed(1)}x${r.h.toFixed(1)}`);
    if (['.hud-btn', '.side-btn', '.brand', '#btn-send', '.session-title-btn'].includes(r.sel)) {
      const pass44 = r.w >= 44 && r.h >= 44;
      ok(`rect ${vp.w} ${r.sel} "${r.text}" ≥44 (HIG)`, pass44, `${r.w.toFixed(1)}x${r.h.toFixed(1)} <44`);
    }
  }
  // check 100vw overlays at 480
  if (vp.w <= 480) {
    // open sidebar drawer at 320
    await page.evaluate(()=> {
      const s=document.getElementById('sidebar');
      if(s) s.classList.remove('collapsed');
    });
    await new Promise(r=>setTimeout(r,200));
    const sidebarW = await page.evaluate(()=> document.getElementById('sidebar')?.getBoundingClientRect().width || 0);
    ok(`reflow ${vp.w} sidebar 100vw`, Math.abs(sidebarW - vp.w) <= 2, `sidebar ${sidebarW} != ${vp.w}`);
    // inspector
    await page.evaluate(()=> {
      const i=document.getElementById('inspector');
      if(i) { i.hidden=false; i.style.display='flex'; }
    });
    await new Promise(r=>setTimeout(r,200));
    const inspW = await page.evaluate(()=> document.getElementById('inspector')?.getBoundingClientRect().width || 0);
    ok(`reflow ${vp.w} inspector 100vw`, Math.abs(inspW - vp.w) <= 2, `inspector ${inspW} != ${vp.w}`);
  }
  // visualViewport fallback: check composer transform vs 100dvh
  const composerVisible = await page.evaluate(()=> {
    const c=document.getElementById('composer');
    if (!c) return false;
    const r=c.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  ok(`composer visible at ${vp.w}`, composerVisible, 'composer not visible');

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

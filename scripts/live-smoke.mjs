// live-smoke.mjs — bounded live check of the repaired pipeline on this date.
// Drives the REAL staged site (npm run serve), the REAL keyless fan-out, the
// REAL page reads, and the REAL free-model proxy. No fixtures. Captures:
//   * the answer text + drawer sources for each question,
//   * every outbound chat POST body (verifies the sampled clock context),
//   * every external origin the page contacted, and page console output.
// Usage: node .scratch/live-smoke.mjs [url] [--only <substring>] (default 3 questions)

import { chromium } from '@playwright/test';

const SITE_URL = process.argv[2] || 'http://127.0.0.1:58861/assembly-agent/';
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const QUESTIONS = [
  'who has the most points in nba history? how many points od they have?',
  'what is the capital of Australia',
  'who won the 2018 world cup',
].filter((q) => !ONLY || q.includes(ONLY));

const chatCalls = [];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('console', (msg) => console.error(`  [page.${msg.type()}] ${msg.text().slice(0, 160)}`));
  page.on('pageerror', (err) => console.error(`  [pageerror] ${String(err).slice(0, 200)}`));
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('http://127.0.0.1')) return;
    if (req.method() === 'POST' && /\/api\/chat/.test(u)) {
      let model = null;
      let hasClock = false;
      let clockLine = '';
      let toolCallRounds = 0;
      let toolResults = 0;
      try {
        const body = JSON.parse(req.postData() || '{}');
        model = body.model;
        const sys = (body.messages || []).find((m) => m.role === 'system');
        hasClock = !!sys && /Clock source: device\./.test(sys.content);
        clockLine = sys ? (sys.content.split('\n\n').findLast(Boolean) || '') : '';
        toolCallRounds = (body.messages || []).filter((m) => Array.isArray(m.tool_calls)).length;
        toolResults = (body.messages || []).filter((m) => m.role === 'tool').length;
      } catch { /* malformed body: leave the counters */ }
      chatCalls.push({ url: u, model, hasClock, clockLine, toolCallRounds, toolResults });
      return;
    }
    console.error(`  [net] ${req.method()} ${u.slice(0, 110)}`);
  });
  page.on('response', (res) => {
    if (/r\.jina\.ai|basketball-reference|wikipedia\.org\/wiki/.test(res.url())) {
      console.error(`  [net] ${res.status()} ${res.url().slice(0, 110)}`);
    }
  });

  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#b-st-progress')?.textContent === 'Ready', null, { timeout: 60000 });
  console.log('boot: Ready');

  for (const q of QUESTIONS) {
    console.log(`\n=== ${q} ===`);
    await page.fill('#b-input', q);
    await page.press('#b-input', 'Enter');
    const outcome = await page.evaluate(() => new Promise((resolve) => {
      const poll = setInterval(() => {
        const strip = document.querySelector('#b-st-progress')?.textContent || '';
        const err = document.querySelector('#b-transcript .b-error');
        const ans = document.querySelectorAll('#b-transcript .b-ans');
        const last = ans.length ? ans[ans.length - 1] : null;
        const foot = last ? last.querySelector('.b-foot')?.innerText || '' : '';
        if (err) { clearInterval(poll); resolve({ kind: 'error', text: err.innerText }); return; }
        if (strip === 'Ready' && last && foot) {
          clearInterval(poll);
          const srcs = [...last.querySelectorAll('.b-src-item')].map((li) => {
            const a = li.querySelector('a');
            return { title: a?.innerText || '', url: a?.href || '', snippet: li.querySelector('.b-src-s')?.textContent || '' };
          });
          const note = [...last.querySelectorAll('.b-note')].map((n) => n.textContent);
          resolve({ kind: 'answer', body: last.querySelector('.b-md')?.innerText || '', foot, srcs, note });
        }
      }, 500);
      setTimeout(() => {
        clearInterval(poll);
        resolve({
          kind: 'timeout', strip: document.querySelector('#b-st-progress')?.textContent,
          diag: {
            transcript: (document.querySelector('#b-transcript')?.innerText || '').slice(0, 400),
            modelId: document.querySelector('#b-st-model')?.textContent,
            send: document.querySelector('#b-send')?.textContent,
            dialogs: [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.id),
          },
        });
      }, 170000);
    }));
    console.log(JSON.stringify(outcome, null, 2));
  }

  console.log('\n=== outbound chat requests ===');
  console.log(JSON.stringify(chatCalls, null, 2));
} finally {
  await browser.close();
}

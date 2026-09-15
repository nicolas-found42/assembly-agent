// journey-turn.spec.mjs — Turn lifecycle journeys (campaign brief §5.3 items 5 and 6).
//
// Everything runs against the staged `_site/` artifact through the harness page
// object (lib/app.mjs) and the fixture control surface (lib/network.mjs). Chunk
// release is explicit: with `chat.mode = 'manual'` the fixture writes no SSE
// frame until `fixture.release()` is called, so every "mid-stream" state below
// is a deliberate event, never a race against a sleep.
//
// Two transports are used, both local:
//   * the proxy path (a free model, no key) — POST <fixture>/api/chat, the
//     fixture's own SSE endpoint, whose manual mode holds frames;
//   * the direct path (a synthetic BYO key) — POST openrouter.ai, routed by
//     lib/network.mjs onto the fixture's /__upstream/openrouter.ai/… handler,
//     where `setSource` serves a scripted body. The harness chat fixture only
//     emits content frames, and the search-budget journey needs tool_calls
//     frames (the engine's scanner reads them, src/agent.wat), so that journey
//     uses the scripted upstream body. Nothing leaves 127.0.0.1 either way.

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';
import { UPSTREAM_HOSTS } from './fixtures/upstream.mjs';

const fixture = fixtureClient();

/** The repo's declared dummy key (scripts/check-sentinel.mjs): never a
 *  credential, only a routing switch to the direct path (js/bridge.js). */
const SYNTHETIC_KEY = 'sk-or-v1-test-dummy-key-not-real';

/** SSE frames in the shape the engine's scanner consumes (src/agent.wat):
 *  `data: {"choices":[{"delta":…}]}` closed by `data: [DONE]`, the same shape
 *  test/tool-loop.mjs drives the turn loop with. */
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const toolCallSse = (id, query) => frame({
  choices: [{
    index: 0,
    delta: {
      tool_calls: [{
        id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) },
      }],
    },
  }],
}) + DONE;

test.beforeEach(async () => { await fixture.reset(); });

/** No request may leave a fixture origin, and no fixture may be missing. */
async function expectHermetic(app) {
  expect(app.net.blocked, app.net.describeBlocked()).toEqual([]);
  for (const request of app.net.proxied) {
    expect(UPSTREAM_HOSTS).toContain(new URL(request.url).host);
  }
  const { misses } = await fixture.requests();
  expect(misses, `fixture gaps: ${misses.join(', ')}`).toEqual([]);
}

/** Chat POSTs the fixture served, in order — one per model round. Two shapes:
 *  the proxy path (POST /api/chat) and the direct path (the fixture answers
 *  openrouter.ai's upstream route; its OPTIONS preflight is not a round). */
const chatPosts = async () => (await fixture.requests()).requests
  .filter((r) => r.method === 'POST' && (
    (r.kind === 'worker' && r.url === '/api/chat')
    || (r.kind === 'upstream' && r.host === 'openrouter.ai' && r.url.endsWith('/api/v1/chat/completions'))
  ));

/** Wait for the round's POST (explicit fixture round trip, no sleep). */
async function expectChatPosts(n) {
  await expect.poll(async () => (await chatPosts()).length, { timeout: 15000 })
    .toBeGreaterThanOrEqual(n);
}

/** A held stream exists only once the fixture owns a live session: `release`
 *  answers 409 before that. Waiting on that signal beats any sleep. */
async function releaseWhenHeld(count) {
  await expect.poll(async () => {
    try { return (await fixture.release(count)).ok === true; } catch { return false; }
  }, { timeout: 15000 }).toBe(true);
}

/** The realised answer card body (HTML, so link/code markup is visible). */
const answerHtml = (page) => page.locator('#b-transcript .b-ans').last().locator('.b-md').innerHTML();
const answerText = (page) => page.locator('#b-transcript .b-ans').last().locator('.b-md').innerText();

// ── journey 5: budgets ────────────────────────────────────────────────────

test('@turn the search budget holds the round limit and runs the last pass with tools disabled', async ({ page }) => {
  const posted = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/chat/completions')) posted.push(req.postData() || '');
  });
  // A key switches the turn to direct routing, which reaches the fixture's
  // openrouter.ai upstream handler — the only place a scripted SSE body can be
  // served (the harness chat endpoint streams content frames only).
  await page.addInitScript((key) => {
    try { sessionStorage.setItem('asm.openrouter.key', key); } catch { /* storage blocked */ }
  }, SYNTHETIC_KEY);
  const app = await bootApp(page);

  // Set AFTER boot: the same override would otherwise answer the catalog fetch.
  await fixture.setSource('openrouter.ai', {
    body: toolCallSse('call_1', 'budget probe'),
    contentType: 'text/event-stream; charset=utf-8',
  });

  await app.ask('How many search rounds does the budget allow?');
  const answer = await app.waitForAnswer({ timeout: 30000 });

  // The budget is spent, so the product answers from the results it has.
  expect(answer.text).toContain('Search budget (5 rounds) spent without a usable answer.');
  expect(await chatPosts()).toHaveLength(5);          // 4 tool rounds + 1 final pass
  expect(posted).toHaveLength(5);
  expect(posted.slice(0, 4).map((b) => JSON.parse(b).tools?.length)).toEqual([1, 1, 1, 1]);
  expect('tools' in JSON.parse(posted[4]), 'the last pass must not offer the tool').toBe(false);
  expect(await app.progress()).toBe('Ready');
  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

// ── journey 5: wording pass ───────────────────────────────────────────────

/** A violating answer (passive voice) carrying every span the integrity gate
 *  protects: a URL, a fenced code body, a digit token and a quoted span. */
const VIOLATING = [
  'The release page was written by the team. Open https://example.com/notes and read the number 42.',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  'The phrase "quoted span here" is exact.',
].join('\n');

/** The rewrite: still passive (so a second pass would be visible as a third
 *  round), and carrying every protected span over unchanged. */
const REWRITTEN = [
  'The release page was written again by the team. The number 42 is on https://example.com/notes.',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  'The phrase "quoted span here" is exact.',
].join('\n');

/** The same rewrite with the link dropped: the integrity gate must reject it. */
const REWRITTEN_BROKEN = [
  'The release page was written again by the team. The number 42 is important.',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  'The phrase "quoted span here" is exact.',
].join('\n');

/** Drive one held answer, stage the rewrite for the next round, let it land. */
async function driveWordingPass(app, page, rewrite) {
  await fixture.setChat({ mode: 'manual', answer: VIOLATING });
  await app.ask('Explain the release page');
  await expectChatPosts(1);
  await releaseWhenHeld(12);
  // The first round is streaming its own text (not the rewrite) at this point.
  await expect(page.locator('#b-transcript .b-ans').last()).toContainText('The release page was written');
  // Stage the rewrite BEFORE the held stream finishes: the wording round posts
  // as soon as the last frame lands, and a later setChat would miss it.
  await fixture.setChat({ mode: 'manual', answer: rewrite });
  await fixture.release();
  await expect(page.locator('#b-st-progress'), 'the corrective pass must announce itself').toHaveText('Checking wording…');
  await expectChatPosts(2);
  await fixture.release();
  await app.waitForAnswer();
}

test('@turn one corrective rewrite is allowed, and links, code, numbers and quotes survive it', async ({ page }) => {
  const app = await bootApp(page);
  await driveWordingPass(app, page, REWRITTEN);

  const answer = (await app.transcript()).answers.at(-1);
  expect(answer.text).toContain('The release page was written again by the team.');
  expect(answer.footer, 'an accepted rewrite is marked as checked').toContain('checked wording');
  const html = await answerHtml(page);
  expect(html, 'the link survives as a working link').toContain('href="https://example.com/notes"');
  expect(html, 'the fenced code survives').toContain('<code');
  expect(await answerText(page)).toContain('const answer = 42;');
  expect(await answerText(page)).toContain('"quoted span here"');
  // Bounded: the rewrite is still passive, so a second pass would show up as a
  // third model round. Two rounds are all this turn may spend.
  expect(await chatPosts()).toHaveLength(2);
  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

test('@turn a rewrite that drops protected material is rejected and the original stands', async ({ page }) => {
  const app = await bootApp(page);
  await driveWordingPass(app, page, REWRITTEN_BROKEN);

  const answer = (await app.transcript()).answers.at(-1);
  expect(answer.text, 'the original answer stands').toContain('The release page was written by the team.');
  expect(answer.text).toContain('https://example.com/notes');
  expect(answer.footer, 'a rejected rewrite is not marked as checked').not.toContain('checked wording');
  expect(await chatPosts()).toHaveLength(2);
  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

// ── journey 6: Stop / Retry ───────────────────────────────────────────────

test('@turn Stop during streaming: the released tail changes nothing and the composer recovers', async ({ page }) => {
  const long = 'The synthetic stream keeps writing more words for the reader. '.repeat(12);
  await fixture.setChat({ mode: 'manual', answer: long });
  const app = await bootApp(page);

  await app.ask('Stream me a long answer');
  await expectChatPosts(1);
  await releaseWhenHeld(6);
  await expect(page.locator('#b-transcript .b-ans').last()).toContainText('The synthetic stream');

  await page.locator('#b-send').click();                    // the composer's Stop
  await expect(page.locator('#b-transcript .b-error')).toContainText('Stopped.');
  const stopped = await page.locator('#b-transcript').innerHTML();
  expect(await page.locator('#b-transcript .b-ans').count(), 'the unfinished draft is dropped').toBe(0);
  expect(await app.status()).toMatchObject({ send: 'Send' });

  // Release the frames the cancelled turn never consumed, then let the page
  // process a full round trip before comparing: nothing may arrive late.
  // Two shapes are honest here: the fixture still owns the stream and writes
  // the frames into the abandoned socket, or the browser already tore the
  // request down and the fixture answers 409. Whichever it is, the transcript
  // must not move.
  const outcome = await fixture.release()
    .then((r) => ({ shape: 'released', streams: r.streams }))
    .catch((err) => ({ shape: 'closed', message: String(err.message) }));
  if (outcome.shape === 'released') expect(outcome.streams).toBeGreaterThanOrEqual(1);
  else expect(outcome.message).toContain('409');
  await app.status();
  expect(await page.locator('#b-transcript').innerHTML()).toBe(stopped);
  expect(await page.locator('#b-transcript .b-ans').count()).toBe(0);

  // The composer still works after the stop: a fresh turn answers normally.
  await fixture.setChat({ mode: 'auto', answer: 'The next turn answers normally.' });
  await app.ask('A question after the stop');
  expect((await app.waitForAnswer()).text).toBe('The next turn answers normally.');
  await expectHermetic(app);
  // Stopping aborts the in-flight POST; Chromium reports that to the page here
  // as ERR_ABORTED (firefox/webkit report their own name for it). That failure
  // is the deliberate stop and the only noise this test allows.
  const noise = (await app.allProblems()).filter((p) => !/failed request: POST \S*\/api\/chat\b/.test(p));
  expect(noise).toEqual([]);
});

test('@turn Stop during the search ends the turn before any model call', async ({ page }) => {
  // One delayed Source keeps the mandated first search in flight while Stop is
  // pressed (the fixture drives the delay; no sleep in the test).
  await fixture.setSource('hn.algolia.com', { delayMs: 1500 });
  const app = await bootApp(page);

  await app.ask('Stop this question during its search');
  await expect(page.locator('#b-st-progress')).toHaveText('Searching the web…');
  await page.locator('#b-send').click();
  await expect(page.locator('#b-transcript .b-error')).toContainText('Stopped.');

  expect(await chatPosts(), 'no model round may start after the stop').toHaveLength(0);
  const stopped = await page.locator('#b-transcript').innerHTML();
  expect(await app.status()).toMatchObject({ send: 'Send' });
  const t = await app.transcript();
  expect(t.answers).toEqual([]);
  expect(t.users).toEqual(['Stop this question during its search']);

  // The delayed Source still resolves; it must not repaint the stopped turn.
  await fixture.health();
  expect(await page.locator('#b-transcript').innerHTML()).toBe(stopped);
  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

test('@turn Retry after a failure runs the research again and keeps one user message', async ({ page }) => {
  await fixture.setChat({ status: 429, error: 'rate limited' });
  const app = await bootApp(page);

  await app.ask('A question that fails first');
  const row = page.locator('#b-transcript .b-error');
  await expect(row).toContainText('rate limited');
  const before = (await fixture.requests()).requests.length;

  await fixture.setChat({ status: 200, answer: 'Recovered after retry.' });
  await row.getByRole('button', { name: 'Retry' }).click();
  const answer = await app.waitForAnswer();

  expect(answer.text).toBe('Recovered after retry.');
  const { requests, misses } = await fixture.requests();
  const fresh = requests.slice(before);
  expect(fresh.filter((r) => r.kind === 'upstream').length, 'Retry researches from scratch').toBeGreaterThan(10);
  expect(await chatPosts()).toHaveLength(2);
  const t = await app.transcript();
  expect(t.users, 'Retry never duplicates the user message').toEqual(['A question that fails first']);
  expect(t.errors).toEqual([]);
  expect(misses).toEqual([]);
  // Chromium logs the deliberate 429 as a console error; the app's own failure
  // path is the only noise allowed here (same policy as boot.spec.mjs).
  const noise = [...app.diag.problems(), ...(await app.rejections())];
  expect(noise.filter((p) => !/status of 429/.test(p))).toEqual([]);
  await expectHermetic(app);
});

test('@turn switching chats during a held turn keeps the other chat clean', async ({ page }) => {
  await fixture.setChat({ mode: 'manual', answer: 'The held answer lands in the first chat.' });
  const app = await bootApp(page);

  await app.ask('First chat question');
  await expectChatPosts(1);
  await releaseWhenHeld(8);
  await expect(page.locator('#b-transcript .b-ans').last()).toContainText('The held answer');

  // Leave the running turn behind (the product keeps it alive in the background).
  await app.openDialog('chats');
  await page.locator('#b-dlg-chats').getByRole('button', { name: 'New chat' }).click();
  expect((await app.transcript()).rows, 'the new chat shows only its welcome banner').toBe(1);

  await fixture.release();
  await expect.poll(async () => (await app.status()).send, { timeout: 15000 }).toBe('Send');
  const other = await app.transcript();
  expect(other.answers, 'the old turn never paints into the new chat').toEqual([]);
  expect(other.users).toEqual([]);

  // The answer belonged to the chat that started it.
  await app.openDialog('chats');
  await page.locator('#b-dlg-chats .b-row', { hasText: 'First chat question' })
    .getByRole('button', { name: 'Open' }).click();
  await expect.poll(async () => (await app.transcript()).answers.length, { timeout: 15000 }).toBe(1);
  const home = await app.transcript();
  expect(home.users).toEqual(['First chat question']);
  expect(home.answers[0].text).toBe('The held answer lands in the first chat.');
  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

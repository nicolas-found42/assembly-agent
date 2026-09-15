// leak.spec.mjs — R07: a synthetic secret cannot reach a retained output.
//
// The campaign sentinel (a synthetic string; see scripts/check-sentinel.mjs) travels the three routes a
// real secret could take through the product, and every test asserts it cannot
// be read back out of a retained channel: the page console (all levels, not
// only the errors the harness keeps), page errors, request URLs, request
// bodies, the fixture server's request log, the status strip, the live region,
// the document title, the rendered source links and the rendered transcript.
//
//   T1  Settings API key — a dummy `sk-or-v1-…` value that CARRIES the sentinel.
//                           It is stored by the app and travels only in the
//                           Authorization header the model origin receives;
//                           the Settings input is the one place it stays.
//   T2  user question    — the sentinel inside pasted private material. The
//                           planning boundary (js/research.js planQuery) keeps
//                           it out of every search query, while the user's own
//                           message still shows exactly what they typed.
//   T3  model answer     — the fixture model streams the sentinel; it renders in
//                           its own answer card and in no other channel.
//
// Every test asserts positively too (the Settings input value, the user row,
// the answer card and the model Authorization header really do carry the
// sentinel), so no test can pass by never handling it.
//
// Scope note (product behaviour, not a weakened assertion): the model request
// body is the conversation, so it carries the user's own message — that is what
// a chat app must send. A key never appears in a body; it is a header, and only
// ever addressed to the model origin. Search origins receive neither the key nor
// the pasted material, in URL or in body.

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';
import { DEFAULT_ANSWER, UPSTREAM_HOSTS } from './fixtures/upstream.mjs';

const fixture = fixtureClient();

/** The campaign sentinel (R07). Synthetic; never a real credential. Assembled from
 *  fragments on purpose: no file in this repository may contain the value as a
 *  literal, or a retained copy of that source (a Playwright trace, an injected
 *  review diff) would trip the very scan that looks for it. `test/ci-guards.test.mjs`
 *  enforces that property. */
const SENTINEL = ['SYNTHETIC', 'SECRET', 'SENTINEL'].join('-') + '-' + ['9f3c', '1a'].join('');
/** A dummy OpenRouter key shaped like the real thing and carrying the sentinel. */
const SPY_KEY = `sk-or-v1-${SENTINEL}`;
/** A question with no secret in it, for the tests whose carrier is not the question. */
const QUESTION = 'What is a synthetic fixture?';
/** One sentence: the STE wording pass (>=2 sentences) and the Hedge Pass stay out. */
const ECHOED_ANSWER = `The synthetic fixture answer carries ${SENTINEL} as a marker.`;

const MODEL_HOST = 'openrouter.ai';
const SEARCH_HOSTS = UPSTREAM_HOSTS.filter((host) => host !== MODEL_HOST);

test.beforeEach(async () => { await fixture.reset(); });

/** Everything one page retained and every request it made. Must run before boot. */
function watch(page) {
 const calls = [];            // { method, url, postData, authorization }
 const pending = [];          // header reads, awaited before asserting
 const consoleLines = [];     // every console level, not only the harness's errors
 const pageErrors = [];

 page.on('request', (request) => {
  const call = { method: request.method(), url: request.url(), postData: request.postData() || '' };
  calls.push(call);
  pending.push(request.allHeaders()
   .then((headers) => { call.authorization = headers.authorization || ''; })
   .catch(() => { call.authorization = ''; }));
 });
 page.on('console', (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
 page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err)));

 return { calls, consoleLines, pageErrors, settled: () => Promise.all(pending) };
}

/** SSE body in the OpenRouter chunk shape the engine's scanner consumes. */
const sse = (text) => String(text).split(/(\s+)/).filter((part) => part !== '')
 .map((part) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part } }] })}\n\n`)
 .join('') + 'data: [DONE]\n\n';

/** The two routes the app reaches a model by: the Proxy (`/api/chat`) and, with a
 *  BYO key, the model origin itself. Both bodies are the conversation. */
const isModelCall = (url) => {
 const { host, pathname } = new URL(url);
 return host === MODEL_HOST || pathname === '/api/chat';
};

const occurrences = (text, needle) => text.split(needle).length - 1;

/** Channels that must never carry the sentinel, whatever carried it in. */
async function expectRetainedClean(app, page, spy) {
 await spy.settled();

 for (const line of spy.consoleLines) {
  expect(line, 'page console output must not retain the sentinel').not.toContain(SENTINEL);
 }
 for (const line of spy.pageErrors) {
  expect(line, 'page error must not retain the sentinel').not.toContain(SENTINEL);
 }

 // No request may put a secret in a URL, and the fixture server's log (the
 // retained request record this suite produces) must not hold one either.
 for (const call of spy.calls) {
  expect(call.url, 'network request URL must not carry the sentinel').not.toContain(SENTINEL);
 }
 const { requests, misses } = await fixture.requests();
 for (const request of requests) {
  expect(request.url, `fixture-recorded request must not carry the sentinel: ${request.method} ${request.url}`)
   .not.toContain(SENTINEL);
 }

 // A search origin gets neither URL nor body carrying it.
 for (const call of spy.calls) {
  if (!SEARCH_HOSTS.includes(new URL(call.url).host)) continue;
  expect(call.url, 'search-origin request URL').not.toContain(SENTINEL);
  expect(call.postData, `search-origin request body (${call.url})`).not.toContain(SENTINEL);
 }
 // The model call is the one request whose body is the conversation, whether it
 // rides the Proxy (`/api/chat`) or a BYO key (the model origin). Every other
 // body must be free of the sentinel.
 for (const call of spy.calls) {
  if (isModelCall(call.url)) continue;
  expect(call.postData, `request body sent to ${new URL(call.url).host}`).not.toContain(SENTINEL);
 }

 // Rendered chrome: status strip, live region, titles, source links.
 const status = await app.status();
 for (const [name, value] of Object.entries(status)) {
  expect(value, `status strip (${name})`).not.toContain(SENTINEL);
 }
 expect(await app.announcement(), 'live region').not.toContain(SENTINEL);
 expect(await page.title(), 'document title').not.toContain(SENTINEL);
 expect(await page.locator('#b-st-model').getAttribute('title') || '', 'model title attribute')
  .not.toContain(SENTINEL);
 const hrefs = await page.locator('#b-transcript a[href]')
  .evaluateAll((links) => links.map((a) => a.href).join(' '));
 expect(hrefs, 'rendered source links').not.toContain(SENTINEL);

 // Hermetic: nothing left a fixture origin and no fixture is missing.
 expect(app.net.blocked, app.net.describeBlocked()).toEqual([]);
 for (const request of app.net.proxied) {
  expect(UPSTREAM_HOSTS).toContain(new URL(request.url).host);
 }
 expect(misses, `fixture gaps (a source shape is missing from fixtures/upstream.mjs): ${misses.join(', ')}`)
  .toEqual([]);
}

test('@leak the saved Settings key reaches the model header only, never a log or a search origin', async ({ page }) => {
 const spy = watch(page);
 const app = await bootApp(page);

 // The user saves a dummy key that CARRIES the sentinel.
 const settings = await app.openDialog('settings');
 await page.locator('#b-set-key').fill(SPY_KEY);
 await page.locator(`${settings.dialog} .b-btn`, { hasText: 'Save key' }).click();
 await expect(page.locator(`${settings.dialog} .b-test-badge`)).toHaveText('Saved for this session.');
 await expect(page.locator('#b-st-key')).toHaveText('API key set');
 await app.closeDialog('settings');

 // A BYO key makes the app call the model origin directly. The catalog was
 // already loaded at boot, before this override, so the round is the only
 // openrouter.ai path served by it.
 await fixture.setSource(MODEL_HOST, {
  contentType: 'text/event-stream; charset=utf-8',
  body: sse(DEFAULT_ANSWER),
 });

 await app.ask(QUESTION);
 const answer = await app.waitForAnswer();
 expect(answer.text).toBe(DEFAULT_ANSWER);
 expect((await app.transcript()).errors).toEqual([]);

 // Positive: the key really was used, and only the model origin saw it.
 const authorized = spy.calls.filter((call) => (call.authorization || '').includes(SENTINEL));
 expect(authorized.length, 'the saved key must actually reach the model call').toBeGreaterThan(0);
 for (const call of authorized) {
  expect(new URL(call.url).host, 'the key is only ever addressed to the model origin').toBe(MODEL_HOST);
 }
 // It travels as a header, never in a body — not even the model round's.
 for (const call of spy.calls) {
  expect(call.postData, `no request body may carry the key (${call.url})`).not.toContain(SPY_KEY);
 }

 // The Settings input still shows it — the one channel it belongs in.
 await app.openDialog('settings');
 await expect(page.locator('#b-set-key')).toHaveValue(SPY_KEY);
 await app.closeDialog('settings');

 // Nothing rendered shows it: the status strip says "API key set", not the key.
 expect(occurrences(await page.locator('body').innerText(), SENTINEL)).toBe(0);

 await expectRetainedClean(app, page, spy);
});

test('@leak a pasted secret in the question is shown to its author and stays out of every search', async ({ page }) => {
 const PASTED = `Please rewrite this note for me: "Reminder — the staging key is ${SENTINEL} and it must not leave the team."`;
 const spy = watch(page);
 const app = await bootApp(page);

 await app.ask(PASTED);
 const answer = await app.waitForAnswer();
 expect(answer.text).toBe(DEFAULT_ANSWER);

 // Positive: the user's own message shows exactly what they typed.
 const transcript = await app.transcript();
 expect(transcript.users).toEqual([PASTED]);
 expect(transcript.users.join('\n')).toContain(SENTINEL);
 // ...and it is rendered once — not echoed into the answer, an error or a notice.
 expect(occurrences(await page.locator('body').innerText(), SENTINEL)).toBe(1);
 expect(transcript.answers.map((a) => `${a.text} ${a.footer} ${a.sources}`).join('\n')).not.toContain(SENTINEL);
 expect(transcript.errors.concat(transcript.notices)).toEqual([]);

 // Non-vacuity for the network side: the mandated search really ran, and the
 // query it sent is the planned private-writing query, not the pasted material.
 const searched = spy.calls.filter((call) => SEARCH_HOSTS.includes(new URL(call.url).host));
 expect(searched.length).toBeGreaterThan(5);
 const queries = decodeURIComponent(searched.map((call) => new URL(call.url).search).join('&')).replace(/\+/g, ' ');
 expect(queries, 'the search query is the planned one, derived from the ask').toContain('how to write clearly');

 await expectRetainedClean(app, page, spy);
});

test('@leak a secret the model echoes renders once, in its own answer, and nowhere else', async ({ page }) => {
 await fixture.setChat({ answer: ECHOED_ANSWER });
 const spy = watch(page);
 const app = await bootApp(page);

 await app.ask(QUESTION);
 const answer = await app.waitForAnswer();

 // Positive: the model's own words are rendered in its answer card, once.
 expect(answer.text).toBe(ECHOED_ANSWER);
 const transcript = await app.transcript();
 expect(transcript.answers.map((a) => a.text).join('\n')).toContain(SENTINEL);
 expect(transcript.users.join('\n')).not.toContain(SENTINEL);
 expect(transcript.errors.concat(transcript.notices)).toEqual([]);
 expect(occurrences(await page.locator('body').innerText(), SENTINEL)).toBe(1);

 await expectRetainedClean(app, page, spy);
});

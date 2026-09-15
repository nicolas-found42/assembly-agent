// journey-search.spec.mjs — R02 §5.3 journeys 2, 3 and 4 against the real app.
//
// Coverage map (campaign brief §5.3):
//   2. request ordering  -> '@search ordering: …' (4 tests): the mandated
//      fan-out reaches its Sources before the first model call, and a repeat,
//      a follow-up, a Retry and a new chat under another assistant each search
//      again — the 10-minute sessionStorage cache cannot stand in for a turn.
//   3. search privacy    -> '@search privacy: …': synthetic private markers
//      (a writing brief and a translation input) never reach a search origin,
//      in the fixture server's request log or in the page's own traffic.
//   4. search results    -> '@search states: …' (4 tests): success, partial,
//      empty and unavailable each render their documented source/footer state.
//
// Every signal asserted here is product-observable: the fixture server's
// ordered request log, the intercepted page requests, the status strip, the
// transcript rows and the answer card's footer. No product module is stubbed
// and nothing here touches the network outside 127.0.0.1.

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';
import { UPSTREAM_HOSTS } from './fixtures/upstream.mjs';

const fixture = fixtureClient();

/** Every origin the fan-out searches; openrouter.ai is the model catalog. */
const SEARCH_HOSTS = UPSTREAM_HOSTS.filter((host) => host !== 'openrouter.ai');
const CHAT_URL = '/api/chat';
const QUESTION = 'What is a synthetic fixture?';

/** The product's three documented footer notes (js/main.js newAnswerCard). */
const NOTE_NO_SOURCES = 'Web search was not available for this answer.';
const NOTE_UNREACHABLE = 'Some sources were unreachable.';

test.beforeEach(async () => { await fixture.reset(); });

// ── observable signals ────────────────────────────────────────────────────

const isChat = (entry) => entry.kind === 'worker' && entry.url === CHAT_URL;
const isSearch = (entry) => entry.kind === 'upstream' && entry.host !== 'openrouter.ai';

/**
 * The fixture log, cut into turns: one entry per model call carrying exactly
 * the Source requests recorded since the previous model call. A turn that
 * reused a cached result has none.
 */
function turns(requests) {
  const out = [];
  let cursor = -1;
  for (let i = 0; i < requests.length; i++) {
    if (!isChat(requests[i])) continue;
    const searches = [];
    for (let j = cursor + 1; j < i; j++) if (isSearch(requests[j])) searches.push(requests[j]);
    out.push({ chat: requests[i], chatIndex: i, searches, index: out.length + 1 });
    cursor = i;
  }
  return out;
}

/** Decoded query-string values of a recorded URL (path-only or absolute). */
function paramValues(url) {
  try { return [...new URL(url, 'http://log.invalid').searchParams.values()]; } catch { return []; }
}

/** Record every status-strip transition so a turn's visible order is provable. */
async function recordProgress(page) {
  await page.evaluate(() => {
    const strip = document.getElementById('b-st-progress');
    if (!strip) throw new Error('#b-st-progress is missing — the strip contract changed');
    const seen = [];
    const note = () => {
      const text = strip.textContent.trim();
      if (text && seen.at(-1) !== text) seen.push(text);
    };
    window.__searchProgress = seen;
    note();
    new MutationObserver(note).observe(strip, { subtree: true, childList: true, characterData: true });
  });
}

const readProgress = (page) => page.evaluate(() => (window.__searchProgress || []).slice());

/** The newest answer card's source/footer slot. */
const sourceSlot = (page) => page.locator('#b-transcript .b-ans').last().locator('.b-src-slot');

async function expectHermetic(app) {
  expect(app.net.blocked, app.net.describeBlocked()).toEqual([]);
  for (const request of app.net.proxied) {
    expect(UPSTREAM_HOSTS).toContain(new URL(request.url).host);
  }
  const { misses } = await fixture.requests();
  expect(misses, `fixture gaps (a source shape is missing from fixtures/upstream.mjs): ${misses.join(', ')}`)
    .toEqual([]);
}

/** A deliberate upstream failure is the only noise a browser may log. */
const DELIBERATE_HTTP_NOISE = /\bstatus of [45]\d\d\b/;
async function expectOnlyDeliberateProblems(app) {
  const problems = [...app.diag.take(), ...(await app.rejections()).map((r) => `unhandled rejection: ${r}`)];
  expect(problems.filter((p) => !DELIBERATE_HTTP_NOISE.test(p)), 'unexpected page error').toEqual([]);
}

// ── 2. request ordering ───────────────────────────────────────────────────

test('@search ordering: the mandatory search reaches its Sources before the first model call', async ({ page }) => {
  const app = await bootApp(page);
  await recordProgress(page);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe('The synthetic catalog answered this question from fixture data.');

  // Ordered fixture log: the Source requests sit before the one model call and
  // the last of them still precedes it — the search finished first.
  const { requests } = await fixture.requests();
  const chatIndex = requests.findIndex(isChat);
  const searchIndexes = requests.flatMap((entry, i) => (isSearch(entry) ? [i] : []));
  expect(chatIndex, 'the app made no model call').toBeGreaterThan(-1);
  expect(searchIndexes.length, 'the fan-out made no Source request').toBeGreaterThanOrEqual(5);
  expect(Math.max(...searchIndexes), 'every Source request must precede the model call')
    .toBeLessThan(chatIndex);
  expect(new Set(searchIndexes.map((i) => requests[i].host)).size, 'too few distinct Sources')
    .toBeGreaterThan(4);

  // The product-visible order too: the strip says it searched before it wrote.
  const progress = await readProgress(page);
  expect(progress, `status strip never announced the search: ${JSON.stringify(progress)}`)
    .toContain('Searching the web…');
  expect(progress, `status strip never announced the answer: ${JSON.stringify(progress)}`)
    .toContain('Writing your answer…');
  expect(progress.indexOf('Searching the web…'), `status strip order: ${JSON.stringify(progress)}`)
    .toBeLessThan(progress.indexOf('Writing your answer…'));

  await expectHermetic(app);
  expect(answer.sources).toMatch(/^Sources \(\d+\)$/);
  expect(await app.allProblems()).toEqual([]);
});

test('@search ordering: a repeated question and a follow-up each search afresh', async ({ page }) => {
  const app = await bootApp(page);
  await recordProgress(page);

  await app.ask(QUESTION);
  await app.waitForAnswer();

  // The same question again: the Source responses are already in the
  // sessionStorage cache at this point, so a reused result would show up as a
  // turn with no Source request at all.
  await app.ask(QUESTION);
  await app.waitForAnswer();

  // A follow-up borrows the topic of the earlier message (js/research.js
  // planQuery) and must search for it, not answer from the stand-in.
  await app.ask('continue');
  await app.waitForAnswer();

  const { requests } = await fixture.requests();
  const log = turns(requests);
  expect(log, 'expected one model call per turn').toHaveLength(3);
  for (const turn of log) {
    expect(turn.searches.length, `turn ${turn.index} made no Source request`).toBeGreaterThanOrEqual(5);
    expect(Math.max(...turn.searches.map((s) => requests.indexOf(s))), `turn ${turn.index} ordered wrong`)
      .toBeLessThan(turn.chatIndex);
    const hosts = new Set(turn.searches.map((s) => s.host));
    // These two Sources answer through the 10-minute sessionStorage cache
    // (cachedJson), so a cache hit instead of a request is exactly the bypass
    // this test must catch.
    expect(hosts, `turn ${turn.index} never re-fetched the cached Source api.mwmbl.org`)
      .toContain('api.mwmbl.org');
    expect(hosts, `turn ${turn.index} never re-fetched the cached Source api.duckduckgo.com`)
      .toContain('api.duckduckgo.com');
  }

  // The follow-up searched the borrowed topic, not the word "continue".
  const followUp = log[2].searches.flatMap((s) => paramValues(s.url));
  expect(followUp, 'the follow-up did not search the earlier topic')
    .toContain('synthetic fixture?');
  expect(followUp, 'the follow-up searched its own wording').not.toContain('continue');

  // Three turns, three answer cards, three announced searches.
  const progress = await readProgress(page);
  expect(progress.filter((p) => p === 'Searching the web…').length).toBeGreaterThanOrEqual(3);
  expect((await app.transcript()).answers).toHaveLength(3);

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

test('@search ordering: Retry after a failed model call searches again', async ({ page }) => {
  await fixture.setChat({ status: 429, error: 'rate limited' });
  const app = await bootApp(page);

  await app.ask(QUESTION);
  const row = page.locator('#b-transcript .b-error');
  await expect(row).toBeVisible();
  expect((await app.transcript()).answers).toEqual([]);

  // The failed turn already searched; fixing the proxy and retrying must search
  // again rather than answer from the failed turn's results.
  await fixture.setChat({ status: 200 });
  const before = turns((await fixture.requests()).requests).length;
  await row.locator('.b-btn', { hasText: 'Retry' }).click();
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe('The synthetic catalog answered this question from fixture data.');

  const { requests } = await fixture.requests();
  const log = turns(requests);
  expect(log.length, 'the retry made no model call').toBe(before + 1);
  const retry = log.at(-1);
  expect(retry.searches.length, 'the retry reused the failed turn’s results').toBeGreaterThanOrEqual(5);
  expect(Math.min(...retry.searches.map((s) => requests.indexOf(s))))
    .toBeGreaterThan(log.at(-2).chatIndex);
  expect(new Set(retry.searches.map((s) => s.host))).toContain('api.mwmbl.org');

  // Exactly one user message, answered once.
  const transcript = await app.transcript();
  expect(transcript.users).toEqual([QUESTION]);
  expect(transcript.answers).toHaveLength(1);

  await expectHermetic(app);
  await expectOnlyDeliberateProblems(app);
});

test('@search ordering: a new chat under another assistant searches again', async ({ page }) => {
  const app = await bootApp(page);
  await app.ask(QUESTION);
  await app.waitForAnswer();

  // Switch assistant: author one and start a chat that carries it.
  await app.openDialog('assistants');
  await page.getByRole('button', { name: 'New assistant' }).click();
  await page.locator('#b-edit-name').fill('Fixture Reviewer');
  await page.locator('#b-edit-ins').fill('You are the fixture reviewer. Answer in one sentence.');
  await page.getByRole('button', { name: 'Save assistant' }).click();
  const row = page.locator('#b-dlg-assistants li.b-row', { hasText: 'Fixture Reviewer' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'New chat' }).click();

  // The chat really switched: new transcript, the new assistant on the strip.
  await expect(page.locator('#b-st-assistant')).toHaveText('Fixture Reviewer');
  await expect(page.locator('#b-transcript .b-user')).toHaveCount(0);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe('The synthetic catalog answered this question from fixture data.');

  const { requests } = await fixture.requests();
  const log = turns(requests);
  expect(log, 'expected one model call per turn').toHaveLength(2);
  const second = log[1];
  expect(second.searches.length, 'the new chat answered without searching').toBeGreaterThanOrEqual(5);
  // The same sessionStorage-cacheable Sources were re-fetched for the new chat.
  const hosts = new Set(second.searches.map((s) => s.host));
  expect(hosts, 'the new chat reused the earlier chat’s cached Source').toContain('api.mwmbl.org');
  expect(hosts, 'the new chat reused the earlier chat’s cached Source').toContain('api.duckduckgo.com');
  expect(Math.min(...second.searches.map((s) => requests.indexOf(s))))
    .toBeGreaterThan(log[0].chatIndex);

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

// ── 3. search privacy ─────────────────────────────────────────────────────

test('@search privacy: private writing and translation markers never reach a search origin', async ({ page }) => {
  // Synthetic markers only: ordinary tokens that js/research.js minimizeQuery
  // would keep if the plan passed the message through.
  const WRITING_INPUT = 'Please write an email to my manager about the bellwether quartz nightjar launch, '
    + 'because the schedule moved to Friday and the team needs a short update.';
  const TRANSLATION_INPUT = 'Please translate this text into French: cinderplume ambervex schedule moved '
    + 'to Friday and the team needs an update.';
  const MARKERS = ['bellwether', 'quartz', 'nightjar', 'cinderplume', 'ambervex'];

  // Interception is installed before boot so every request the page makes is seen.
  const seen = [];
  page.on('request', (request) => {
    let body = '';
    try { body = request.postData() || ''; } catch { body = ''; }
    seen.push({ method: request.method(), url: request.url(), headers: request.headers(), body });
  });

  const app = await bootApp(page);
  for (const input of [WRITING_INPUT, TRANSLATION_INPUT]) {
    await app.ask(input);
    await app.waitForAnswer();
  }

  // Non-vacuity: the markers really travelled through the product (and the
  // model call carries the user's words — that is the documented contract).
  const users = (await app.transcript()).users;
  expect(users.join('\n')).toContain(WRITING_INPUT);
  expect(users.join('\n')).toContain(TRANSLATION_INPUT);

  const leaked = (haystack) => MARKERS.some((m) => haystack.toLowerCase().includes(m));

  // (a) the intercepted page traffic to a search origin: URL, headers, body.
  const searchTraffic = seen.filter((r) => SEARCH_HOSTS.includes(new URL(r.url).host));
  expect(searchTraffic.length, 'no search request was intercepted').toBeGreaterThanOrEqual(10);
  const trafficLeaks = searchTraffic.filter((r) => leaked(`${r.url}\n${r.body}\n${JSON.stringify(r.headers)}`));
  expect(trafficLeaks, `private marker reached a search origin:\n${trafficLeaks.map((r) => `${r.method} ${r.url}\n  headers: ${JSON.stringify(r.headers)}\n  body: ${r.body}`).join('\n')}`)
    .toEqual([]);

  // (b) the fixture server's own request log (what the fixture actually saw).
  const { requests, misses } = await fixture.requests();
  expect(misses).toEqual([]);
  const loggedSearches = requests.filter(isSearch);
  expect(loggedSearches.length, 'the fixture server saw no search request').toBeGreaterThanOrEqual(10);
  const logLeaks = requests.filter((r) => leaked(r.url));
  expect(logLeaks, `private marker in the fixture log: ${logLeaks.map((r) => `${r.kind} ${r.url}`).join('\n')}`)
    .toEqual([]);

  // The plan replaced the material with a task-shaped query at both stages.
  const queries = loggedSearches.flatMap((r) => paramValues(r.url));
  expect(queries, 'the writing turn did not search its derived query')
    .toContain('how to write a clear email');
  expect(queries, 'the translation turn did not search its derived query')
    .toContain('French translation');

  expect(await app.allProblems()).toEqual([]);
  await expectHermetic(app);
});

// ── 4. search result states ───────────────────────────────────────────────

test('@search states: a successful search discloses its Sources', async ({ page }) => {
  const app = await bootApp(page);
  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();

  expect(answer.text).toBe('The synthetic catalog answered this question from fixture data.');
  expect(answer.sources, `footer disclosures: ${JSON.stringify(answer.sources)}`).toMatch(/^Sources \(\d+\)$/);
  const disclosed = Number(answer.sources.match(/\((\d+)\)/)[1]);
  expect(disclosed).toBeGreaterThanOrEqual(3);

  // The disclosure is a real list of links behind the summary, not a count.
  const summary = page.locator('#b-transcript .b-ans').last().locator('details.b-src > summary');
  await summary.click();
  const links = await app.sources();
  expect(links).toHaveLength(disclosed);
  for (const link of links) expect(link.url).toMatch(/^https?:\/\//);
  await expect(page.locator('#b-transcript .b-src-list a').first()).toBeVisible();

  await expect(sourceSlot(page)).not.toContainText(NOTE_UNREACHABLE);
  await expect(sourceSlot(page)).not.toContainText(NOTE_NO_SOURCES);

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

test('@search states: a partial search discloses Sources and warns about unreachable ones', async ({ page }) => {
  // Some Sources die; the rest of the fan-out still answers the turn.
  await fixture.setSource('en.wikipedia.org', { status: 503, body: { error: 'unavailable' } });
  await fixture.setSource('hn.algolia.com', { status: 500, body: { error: 'unavailable' } });
  const app = await bootApp(page);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();

  expect(answer.text).toBe('The synthetic catalog answered this question from fixture data.');
  expect(answer.sources, `footer disclosures: ${JSON.stringify(answer.sources)}`).toMatch(/^Sources \(\d+\)$/);
  const disclosed = Number(answer.sources.match(/\((\d+)\)/)[1]);
  expect(disclosed).toBeGreaterThanOrEqual(1);

  const slot = sourceSlot(page);
  await expect(slot).toContainText(NOTE_UNREACHABLE);
  await expect(slot).not.toContainText(NOTE_NO_SOURCES);

  // The dead Sources really were attempted through the fan-out.
  const { requests } = await fixture.requests();
  const hosts = new Set(requests.filter(isSearch).map((r) => r.host));
  expect(hosts).toContain('en.wikipedia.org');
  expect(hosts).toContain('hn.algolia.com');

  await expectHermetic(app);
  await expectOnlyDeliberateProblems(app);
});

test('@search states: an empty search renders the not-available note without a warning', async ({ page }) => {
  // Every Source answers successfully with an empty payload: the fan-out runs
  // to completion and nothing usable comes back. (js/search.js drops the JINA
  // reader block when the reader extracted nothing, so "empty" really is empty.)
  for (const host of SEARCH_HOSTS) {
    if (host === 'r.jina.ai') await fixture.setSource(host, { body: '', contentType: 'text/plain; charset=utf-8' });
    else await fixture.setSource(host, { body: {} });
  }
  const app = await bootApp(page);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe('The synthetic catalog answered this question from fixture data.');

  const slot = sourceSlot(page);
  const rendered = await slot.innerText();
  expect(rendered, `empty-state footer rendered: ${JSON.stringify(rendered)}`).toContain(NOTE_NO_SOURCES);
  expect(rendered, `empty-state footer rendered: ${JSON.stringify(rendered)}`).not.toContain(NOTE_UNREACHABLE);
  expect(await page.locator('#b-transcript .b-ans .b-src').count(), 'an empty result set disclosed a Source')
    .toBe(0);

  // The fan-out really ran — an "empty" state that skipped the search would be
  // indistinguishable from the cache bypass this file exists to catch.
  const { requests } = await fixture.requests();
  const hosts = new Set(requests.filter(isSearch).map((r) => r.host));
  expect(hosts.size, 'the fan-out did not even try the Sources').toBeGreaterThan(4);

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

test('@search states: an unavailable search renders the note and the warning', async ({ page }) => {
  // Search unusable: every Source origin fails the turn.
  for (const host of SEARCH_HOSTS) {
    await fixture.setSource(host, { status: 503, body: { error: 'unavailable' } });
  }
  const app = await bootApp(page);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();

  // The turn still answers — the failure is disclosed, not hidden.
  expect(answer.text).toBe('The synthetic catalog answered this question from fixture data.');
  const slot = sourceSlot(page);
  const rendered = await slot.innerText();
  expect(rendered, `unavailable-state footer rendered: ${JSON.stringify(rendered)}`).toContain(NOTE_NO_SOURCES);
  expect(rendered, `unavailable-state footer rendered: ${JSON.stringify(rendered)}`).toContain(NOTE_UNREACHABLE);
  expect(await page.locator('#b-transcript .b-ans .b-src').count(), 'an unusable search disclosed a Source')
    .toBe(0);

  const { requests } = await fixture.requests();
  const hosts = new Set(requests.filter(isSearch).map((r) => r.host));
  expect(hosts.size, 'the fan-out did not even try the Sources').toBeGreaterThan(4);

  await expectHermetic(app);
  await expectOnlyDeliberateProblems(app);
});

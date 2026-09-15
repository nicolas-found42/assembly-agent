// journey-evidence.spec.mjs — the motivating research journey (Phase 2).
//
// The user's own words — "who has the most points in nba history? how many
// points od they have?" — typed into the real app against the fixture server.
// The turn must search the question's own plan query, read the page that holds
// the record, and disclose that page. The failure this guards against answered
// a points question from a scoreboard and surfaced game links instead.
//
// Every signal asserted here is product-observable: the fixture server's
// request log, the intercepted browser traffic, the answer card's drawer and
// the transcript after a reload. No product module is stubbed and nothing
// touches the network outside 127.0.0.1.

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';

const fixture = fixtureClient();

/** The motivating question, verbatim (typo included). */
const QUESTION = 'who has the most points in nba history? how many points od they have?';
/** js/research.js planTask() for that text: the query the turn must search. */
const PLAN_QUERY = 'NBA all-time career points leaders regular season';
/** The page the answer lives on. fixtures/upstream.mjs serves it directly and
 *  behind the r.jina.ai reader, and the SERP ranks that destination first. */
const LEADERBOARD = 'https://www.basketball-reference.com/leaders/nba_career_pts.html';

const isUpstream = (entry) => entry.kind === 'upstream';

/** Decoded query-string values of a recorded URL (path-only or absolute). */
function paramValues(url) {
  try { return [...new URL(url, 'http://log.invalid').searchParams.values()]; } catch { return []; }
}

const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };
const isEspn = (host) => /(^|\.)espn\.com$/.test(host);

test.beforeEach(async () => { await fixture.reset(); });

test('@evidence journey: the NBA points question reads the leaderboard, never a scoreboard', async ({ page }) => {
  const app = await bootApp(page);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();
  expect(await app.progress(), 'the turn did not settle cleanly').toBe('Ready');
  const settled = await app.transcript();
  expect(settled.users).toEqual([QUESTION]);
  expect(settled.errors).toEqual([]);
  expect(answer.sources, `footer disclosure: ${JSON.stringify(answer.sources)}`).toMatch(/^Sources \(\d+\)$/);

  // The drawer of the settled answer: real links, opened from its summary.
  const summary = page.locator('#b-transcript .b-ans').last().locator('details.b-src > summary');
  await summary.click();
  const links = await app.sources();
  const urls = links.map((l) => l.url);
  expect(urls, `drawer sources: ${JSON.stringify(urls)}`).toContain(LEADERBOARD);

  // The motivating failure disclosed scoreboard game links. None may appear.
  const espnLinks = urls.filter((u) => isEspn(hostOf(u)));
  expect(espnLinks, `an ESPN link reached the sources drawer: ${espnLinks.join(', ')}`).toEqual([]);

  // The fan-out searched the question's own plan query, and it never called
  // ESPN's scoreboard API — nor did the page reach any ESPN origin at all.
  const { requests } = await fixture.requests();
  const upstream = requests.filter(isUpstream);
  expect(upstream.length, 'the fan-out made no upstream request').toBeGreaterThan(4);
  expect(upstream.flatMap((r) => paramValues(r.url)), 'the turn did not search the plan query')
    .toContain(PLAN_QUERY);
  const espnHosts = upstream.map((r) => r.host).filter(isEspn);
  expect(espnHosts, `the fan-out called an ESPN API: ${espnHosts.join(', ')}`).toEqual([]);
  const reached = [...app.net.blocked, ...app.net.proxied].map((entry) => hostOf(entry.url)).filter(isEspn);
  expect(reached, `the page reached an ESPN origin: ${reached.join(', ')}`).toEqual([]);

  // The registry survives the reload: the persisted assistant message keeps the
  // full source snapshot, and the restored chat re-renders its drawer.
  await page.reload();
  await app.waitForBoot();
  const restored = await app.transcript();
  expect(restored.users).toEqual([QUESTION]);
  expect(restored.answers, 'the reloaded chat lost its answer').toHaveLength(1);
  await page.locator('#b-transcript .b-ans').last().locator('details.b-src > summary').click();
  const after = await app.sources();
  expect(after.map((l) => l.url), 'the reloaded chat lost its sources').toContain(LEADERBOARD);

  // Reading the leaderboard is a fixture fetch, not a stray call: the whole
  // journey leaves no page error, no failed request and no console defect.
  const problems = await app.allProblems();
  expect(problems, `page problems:\n${problems.join('\n')}`).toEqual([]);
});

// harness.spec.mjs — self-tests for the harness itself.
//
// Every other spec relies on two properties that would be invisible if they
// silently degraded: that a request to an origin with no fixture is recorded
// (so a real external call cannot hide behind an application's own catch), and
// that the axe gate actually fails on a violation. Both are planted here at
// runtime — never in product source — and both are gone with the page.

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { expectNoBlocking, scan } from './lib/a11y.mjs';
import { fixtureClient } from './lib/network.mjs';

const fixture = fixtureClient();

test.beforeEach(async () => { await fixture.reset(); });

test('@harness a request to an unfixtured origin is recorded even when the app swallows the error', async ({ page }) => {
  const app = await bootApp(page);
  const before = app.net.blocked.length;

  // Exactly how a stray call would look in the app: caught, so the UI shows
  // nothing and no page error is raised.
  await page.evaluate(() => { fetch('https://unregistered.example/probe').catch(() => {}); });

  await expect.poll(() => app.net.blocked.length).toBe(before + 1);
  const entry = app.net.blocked.at(-1);
  expect(entry.method).toBe('GET');
  expect(entry.url).toBe('https://unregistered.example/probe');
  expect(entry.origin).toBe('https://unregistered.example');
  expect(app.net.origins()).toContain('https://unregistered.example');
  expect(app.net.describeBlocked()).toContain('https://unregistered.example/probe');

  // Two independent records: the harness one (authoritative, survives any
  // application catch) and the browser's own failed-load noise. The app itself
  // raised nothing — no uncaught error, no unhandled rejection.
  expect(app.diag.pageErrors).toEqual([]);
  expect(await app.rejections()).toEqual([]);
  expect(app.diag.requestFailures.join()).toContain('https://unregistered.example/probe');
});

test('@harness axe fails on a planted critical violation', async ({ page }) => {
  const app = await bootApp(page);
  expect((await scan(page)).byImpact.critical).toEqual([]);

  await page.evaluate(() => {
    const planted = document.createElement('button');
    planted.id = 'planted-nameless';
    document.body.append(planted);
  });

  const planted = await scan(page);
  expect(planted.byImpact.critical).toContain('button-name');
  await expect(expectNoBlocking(page, 'planted')).rejects.toThrow(/critical\/serious/);

  expect(await app.allProblems()).toEqual([]);
});

// boot.spec.mjs — journey 1: the app boots and answers, hermetically.
//
// Covers, end to end and against the staged _site/ artifact:
//   * the wasm engine initialises and the catalog loads into it;
//   * the newest free TEXT model is the one selected (the catalog fixture has a
//     newer image-only free model on purpose);
//   * the composer starts a turn, the mandated web search runs before the model
//     call, and the answer lands with its Sources;
//   * nothing leaves the fixture origins, no fixture gap is hit, and there are
//     no uncaught errors, unhandled rejections, failed imports or missing assets.

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';
import { DEFAULT_ANSWER, EXPECTED_DEFAULT_MODEL, UPSTREAM_HOSTS } from './fixtures/upstream.mjs';

const fixture = fixtureClient();
const SHORT_MODEL = EXPECTED_DEFAULT_MODEL.replace(/^.*\//, '').replace(/:free$/, '');

test.beforeEach(async () => { await fixture.reset(); });

/** No request may leave a fixture origin, and no fixture may be missing. */
async function expectHermetic(app) {
  expect(app.net.blocked, app.net.describeBlocked()).toEqual([]);
  for (const request of app.net.proxied) {
    expect(UPSTREAM_HOSTS).toContain(new URL(request.url).host);
  }
  const { misses } = await fixture.requests();
  expect(misses, `fixture gaps (a source shape is missing from fixtures/upstream.mjs): ${misses.join(', ')}`)
    .toEqual([]);
}

test('@boot boots the engine, loads the catalog and selects the newest free model', async ({ page }) => {
  const app = await bootApp(page);

  // Boot settled on the healthy path, not on the catalog/engine error paths.
  expect(await app.progress()).toBe('Ready');
  await expect(page.locator('#b-st-assistant')).toHaveText('ASM::AGENT');
  await expect(page.locator('#b-st-key')).toHaveText('No API key');
  await expect(page.locator('#b-transcript')).toContainText('Ask a question');
  await expect(page.locator('body')).not.toContainText('MAIN FAILED');

  // The catalog reached the wasm engine: the picker renders from wasm records.
  const model = await app.openDialog('model');
  await expect(page.locator(`${model.dialog} .b-row-m`).first()).toBeVisible();
  const catalog = await page.evaluate(() => {
    const dlg = document.getElementById('b-dlg-model');
    const auto = document.getElementById('b-auto');
    return {
      count: dlg.querySelector('.b-dlg-count')?.textContent || '',
      rows: dlg.querySelectorAll('.b-mrow').length,
      auto: auto?.textContent || '',
      autoPressed: auto?.getAttribute('aria-pressed'),
      // The row the picker marks ACTIVE: the chat's current model.
      active: [...dlg.querySelectorAll('.b-mrow.is-active')].map((r) => r.querySelector('.b-row-id')?.textContent || ''),
    };
  });
  // Every fixture model is in the engine, and the ACTIVE one is the flagship.
  expect(catalog.count).toBe('4/4 models');
  expect(catalog.rows).toBe(4);
  expect(catalog.active).toEqual([EXPECTED_DEFAULT_MODEL]);

  // Automatic (newest free) is the selected mode, and the engine's answer to
  // "newest free text model" is the flagship — not the newer image-only model.
  expect(catalog.autoPressed).toBe('true');
  expect(catalog.auto).toContain(`uses ${EXPECTED_DEFAULT_MODEL}`);
  await app.closeDialog('model');
  expect((await app.status()).model).toBe(SHORT_MODEL);

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

test('@boot answers a question from the fixture origins only', async ({ page }) => {
  const app = await bootApp(page);
  const question = 'What is a synthetic fixture?';

  await app.ask(question);
  const answer = await app.waitForAnswer();

  // The streamed answer is the fixture's answer, rendered final.
  expect(answer.text).toBe(DEFAULT_ANSWER);
  expect(answer.footer).toContain(SHORT_MODEL);

  const transcript = await app.transcript();
  expect(transcript.users).toEqual([question]);
  expect(transcript.answers).toHaveLength(1);
  expect(transcript.errors).toEqual([]);

  // The mandated web search ran, its Sources hang off the answer, and the
  // first Source is the first fan-out job (wikipedia).
  expect(answer.sources).toMatch(/^Sources \(\d+\)$/);
  const sources = await app.sources();
  expect(sources.length).toBeGreaterThan(5);
  expect(sources[0].url).toBe('https://en.wikipedia.org/wiki/Synthetic_Article');

  // Research precedes the model call, and the model call is the proxy's.
  const { requests } = await fixture.requests();
  const chats = requests.filter((r) => r.kind === 'worker' && r.url === '/api/chat');
  expect(chats).toHaveLength(1);
  const upstream = requests.filter((r) => r.kind === 'upstream').map((r) => r.host);
  expect(new Set(upstream).size).toBeGreaterThan(5);

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

test('@boot surfaces the proxy error with Retry and Change model, and recovers', async ({ page }) => {
  await fixture.setChat({ status: 429, error: 'rate limited' });
  const app = await bootApp(page);

  await app.ask('A question the proxy will refuse');
  const row = page.locator('#b-transcript .b-error');
  await expect(row).toBeVisible();
  await expect(row.locator('.b-btn', { hasText: 'Retry' })).toBeVisible();
  await expect(row.locator('.b-btn', { hasText: 'Change model' })).toBeVisible();
  // js/bridge.js appends the Free-tier hint to a proxied 429.
  await expect(row).toContainText('Free tier busy');
  expect((await app.status()).send).toBe('Send');
  expect((await app.transcript()).answers).toEqual([]);

  // The app's own failure path is the ONLY noise the browser is allowed to
  // log here: Chromium logs any non-2xx resource, and this 429 is deliberate.
  const duringFailure = [...app.diag.take(), ...(await app.rejections())];
  expect(duringFailure.filter((p) => !/status of 429/.test(p)), 'unexpected error during the failure path').toEqual([]);

  // Recovery: the same turn succeeds once the proxy answers again.
  await fixture.setChat({ status: 200 });
  await row.locator('.b-btn', { hasText: 'Retry' }).click();
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe(DEFAULT_ANSWER);

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

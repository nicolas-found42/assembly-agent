// visual.spec.mjs — the product's visual states, pinned to screenshot baselines.
//
// Baselines live in __snapshots__/visual.spec.mjs/ (per project and platform,
// the config's snapshotPathTemplate). CI never writes them: `npm run
// test:update-snapshots` is an explicit local command and no workflow invokes
// it, so a pixel change fails the run instead of blessing itself.
//
// Chromium only. The required `browser` class runs the chromium project and the
// cross-browser config excludes this file, because a baseline is only meaningful
// for the machine that renders it — see "platform" below.
//
// Platform. Baselines are keyed darwin and linux. The darwin set is rendered on
// a developer machine; the linux set is rendered on the pinned ubuntu-24.04
// runner and CANNOT be reproduced locally — the same woff2 bytes rasterise
// ~1 px differently under the container's font stack (measured: differences are
// confined to 13-px text bands, never to layout or content). A local
// `test:update-snapshots` therefore rewrites the darwin set only; regenerating
// linux means taking the `*-actual.png` files from a failing `build-and-test`
// run's `browser-diagnostics` artifact and copying them over the corresponding
// `-chromium-linux.png` baselines. Without this branch the two sets disagree at
// every text row and the required check would fail for a reason that is not a
// regression.
//
// Determinism (each line removes a real source of drift, none of them by
// removing product behaviour):
//   * viewport — fixed at the config's Desktop Chrome size; the mobile test
//     resizes before boot (the app reads the viewport during boot).
//   * data — only the fixture server answers: catalog, 27 search origins and
//     the SSE answer all come from fixtures/upstream.mjs. No wall clock, no
//     network, no stored state survives `fixture.reset()`.
//   * clock — page.clock.setFixedTime() before navigation, so relTime() paints
//     "just now" and no wall-clock value can reach the pixels.
//   * locale/timezone — explicit in test.use(), so a machine's own settings
//     cannot change a formatted date or number.
//   * pointers — every shot is taken with the pointer parked away from the
//     shell and nothing focused: a hovered .b-act/.b-row paints inverted and a
//     focused control paints a :focus-visible ring. Both are interaction
//     states, not product states.
//   * fonts — test 1 proves the self-hosted woff2 faces are the faces that
//     rendered; Playwright also waits for document.fonts.ready before a shot,
//     so no shot can catch the font-display: swap period.
//   * animation — toHaveScreenshot({ animations: 'disabled' }) finishes finite
//     animations and cancels the infinite CRT sweep to its initial (off-screen)
//     state. The scanline and vignette layers stay painted: the CRT identity is
//     kept, only its timing is removed.

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';
import { DEFAULT_ANSWER, EXPECTED_DEFAULT_MODEL, UPSTREAM_HOSTS } from './fixtures/upstream.mjs';
import { expectNoBlocking, expectNoNewLowImpact, loadBaseline } from './lib/a11y.mjs';

const fixture = fixtureClient();
const baseline = loadBaseline();

const QUESTION = 'What is a synthetic fixture?';
const SHORT_MODEL = EXPECTED_DEFAULT_MODEL.replace(/^.*\//, '').replace(/:free$/, '');
/** openrouter.ai serves the model catalog; it is not a search Source. */
const SEARCH_HOSTS = UPSTREAM_HOSTS.filter((host) => host !== 'openrouter.ai');

/** The instant the page believes it is: a stored chat is always "just now". */
const FIXED_NOW = new Date('2026-01-02T03:04:05.000Z');

test.use({ viewport: { width: 1280, height: 720 }, locale: 'en-US', timezoneId: 'UTC' });

test.beforeEach(async () => { await fixture.reset(); });

/** Park the pointer, drop focus, wait for fonts — the resting state every shot
 *  is taken from. Nothing here changes what the product renders. */
async function settle(page) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.evaluate(() => document.fonts.ready.then(() => true));
}

/** One set of options for every shot: `animations` cancels the infinite CRT
 *  sweep, `caret` hides the text caret — a focused input keeps its caret and
 *  the caret's blink phase is its own animation, which the app does not own. */
const SHOT = { animations: 'disabled', caret: 'hide' };

async function shot(page, name) {
  await settle(page);
  await expect(page).toHaveScreenshot(`${name}.png`, SHOT);
}
/** Soft so one bad shot does not hide the other three: each dialog gets its own
 *  shot and its own diff, instead of the first failure ending the test and
 *  leaving the later baselines untested. It is `shot()` minus the hard
 *  assertion — and it goes through the same settle, or the autofocus ring the
 *  dialog opens with would be painted into the shot. */
async function softShot(page, name) {
  await settle(page);
  await expect.soft(page).toHaveScreenshot(`${name}.png`, SHOT);
}

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

/** The new states this file adds to the a11y gate. Blocking findings always
 *  fail; moderate/minor ones must be reviewed into a11y-baseline.json. */
async function expectStateA11y(page, label) {
  expectNoNewLowImpact(await expectNoBlocking(page, label), label, baseline);
}

/** The states that render a 5xx Source answer: Chromium logs one console error
 *  per non-2xx resource and these are deliberate, exactly like the 429 in
 *  boot.spec.mjs. Everything else stays a defect. */
const expectedSourceNoise = (problem) => /status of 503/.test(problem);

// ── the code-block answer: long enough to fill the transcript, short sentences
// (STE-clean so the turn stays one model round), one fenced block to highlight.
const CODE_ANSWER = [
  '## Synthetic catalog notes',
  '',
  'The fixture server answers every request from local data. Each origin has one shape. '
    + 'The catalog carries an id, a name, a context length, and a price pair.',
  '',
  '```js',
  "const free = catalog.filter((model) => model.id.endsWith(':free'));",
  'console.log(free.map((model) => model.id));',
  '```',
  '',
  'The engine reads that list after boot. It selects the newest entry with text output.',
].join('\n');

test('@visual fonts: the staged CRT faces are the ones that render', async ({ page }) => {
  const app = await bootApp(page);

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const resources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('.woff2'))
      .map((entry) => ({
        file: new URL(entry.name).pathname.split('/').pop(),
        bytes: entry.decodedBodySize,
      }));
    const family = (sel) => getComputedStyle(document.querySelector(sel)).fontFamily;
    return {
      resources,
      faces: [...document.fonts].map((face) => `${face.family} ${face.weight} ${face.status}`),
      brand: family('.b-brand'),
      composer: family('#b-input'),
      displayReady: document.fonts.check('400 21px "VT323"'),
      uiReady: document.fonts.check('400 13px "JetBrains Mono"'),
    };
  });

  // The two faces the UI uses on this state were fetched from the staged site
  // with real bytes — a fallback face would leave both entries missing.
  expect(fonts.resources.map((r) => r.file).sort())
    .toEqual(['jetbrains-mono-latin-400.woff2', 'vt323-latin-400.woff2']);
  for (const resource of fonts.resources) expect(resource.bytes).toBeGreaterThan(1000);

  // …and they are the faces the layout resolves to, not a fallback stack.
  // FontFace.family is quoted on Firefox ("VT323") and bare on Chromium/WebKit,
  // so the comparison is quote-insensitive on purpose — the claim is the same.
  const faces = fonts.faces.map((face) => face.replace(/"/g, ''));
  expect(fonts.brand).toContain('VT323');
  expect(fonts.composer).toContain('JetBrains Mono');
  expect(faces).toEqual(expect.arrayContaining(['VT323 400 loaded', 'JetBrains Mono 400 loaded']));
  expect(fonts.displayReady).toBe(true);
  expect(fonts.uiReady).toBe(true);

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

test('@visual desktop chat: the boot banner and a settled answer', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  const app = await bootApp(page);

  // Boot banner: the welcome copy and the idle strip.
  await expect(page.locator('#b-transcript')).toContainText('Ask a question in the box below.');
  expect(await app.progress()).toBe('Ready');
  await shot(page, 'chat-desktop-boot');

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe(DEFAULT_ANSWER);
  expect(answer.footer).toContain(SHORT_MODEL);
  expect(answer.sources).toMatch(/^Sources \(\d+\)$/);
  expect((await app.sources()).length).toBeGreaterThan(5);
  await shot(page, 'chat-desktop-answer');

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
  await expectStateA11y(page, 'visual-desktop-answer');
});

test('@visual mobile chat: 360px stays usable and is pinned', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.clock.setFixedTime(FIXED_NOW);
  const app = await bootApp(page);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe(DEFAULT_ANSWER);

  // The narrow layout must not scroll sideways; the composer must stay on screen.
  const layout = await page.evaluate(() => ({
    docWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    composer: document.getElementById('b-composer')?.getBoundingClientRect().bottom || -1,
    height: window.innerHeight,
  }));
  expect(layout.docWidth).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.composer).toBeGreaterThan(0);
  expect(layout.composer).toBeLessThanOrEqual(layout.height);
  await shot(page, 'chat-mobile-answer');

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
  await expectStateA11y(page, 'visual-mobile-answer');
});

test('@visual dialogs: chats, assistants, model and settings', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  const app = await bootApp(page);
  await app.ask(QUESTION);
  await app.waitForAnswer();

  await app.openDialog('chats');
  await expect(page.locator('#b-dlg-chats .b-row-t').first()).toHaveText(QUESTION);
  await softShot(page, 'dialog-chats');
  await app.closeDialog('chats');

  await app.openDialog('assistants');
  await expect(page.locator('#b-dlg-assistants .b-tag')).toHaveText('Built-in');
  await softShot(page, 'dialog-assistants');
  await app.closeDialog('assistants');

  await app.openDialog('model');
  await expect(page.locator('#b-dlg-model')).toContainText('4/4 models');
  await expect(page.locator('#b-dlg-model .b-row-on')).toHaveText('ACTIVE');
  await softShot(page, 'dialog-model');
  await app.closeDialog('model');

  await app.openDialog('settings');
  for (const toggle of ['scan', 'curve', 'flicker', 'sound']) {
    await expect(page.locator(`#b-set-${toggle}`)).toBeVisible();
  }
  await softShot(page, 'dialog-settings');
  await app.closeDialog('settings');

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
  await expectStateA11y(page, 'visual-dialogs');
});

test('@visual assistant editor: the new-assistant form', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  const app = await bootApp(page);

  await app.openDialog('assistants');
  await page.locator('#b-dlg-assistants').getByRole('button', { name: 'New assistant' }).click();
  await expect(page.locator('#b-dlg-edit')).toHaveJSProperty('open', true);

  // A filled form is the state the baseline pins; the empty form is the same
  // layout with two placeholders.
  await page.fill('#b-edit-name', 'Fixture Assistant');
  await page.fill('#b-edit-ins', 'Answer with the synthetic catalog only.');
  await expect(page.locator('#b-edit-name')).toHaveValue('Fixture Assistant');
  await expect(page.locator('#b-edit-ins')).toHaveValue('Answer with the synthetic catalog only.');
  await shot(page, 'dialog-assistant-editor');

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
  await expectStateA11y(page, 'visual-assistant-editor');
});

test('@visual long answer: the code block is highlighted', async ({ page }) => {
  await fixture.setChat({ answer: CODE_ANSWER });
  await page.clock.setFixedTime(FIXED_NOW);
  const app = await bootApp(page);

  await app.ask('Show me the synthetic catalog');
  const answer = await app.waitForAnswer();
  expect(answer.text).toContain('Synthetic catalog notes');
  expect(answer.text).toContain('console.log(free.map((model) => model.id));');

  // The fenced block went through marked + highlight.js, not through the prose path.
  const rendered = await page.evaluate(() => ({
    heading: document.querySelectorAll('#b-transcript h2').length,
    blocks: document.querySelectorAll('#b-transcript pre code').length,
    highlighted: document.querySelectorAll('#b-transcript pre code span[class^="hljs-"]').length,
    code: document.querySelector('#b-transcript pre code')?.textContent || '',
  }));
  expect(rendered.heading).toBe(1);
  expect(rendered.blocks).toBe(1);
  expect(rendered.highlighted).toBeGreaterThan(0);
  expect(rendered.code).toContain("endsWith(':free')");
  await shot(page, 'answer-code-block');

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
  await expectStateA11y(page, 'visual-answer-code');
});

test('@visual search error: unreachable Sources are named, not hidden', async ({ page }) => {
  for (const host of ['en.wikipedia.org', 'hn.algolia.com', 'api.stackexchange.com']) {
    await fixture.setSource(host, { status: 503, body: { error: 'down' } });
  }
  await page.clock.setFixedTime(FIXED_NOW);
  const app = await bootApp(page);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe(DEFAULT_ANSWER);
  expect(answer.sources).toMatch(/^Sources \(\d+\)$/);

  const answerCard = page.locator('#b-transcript .b-ans').last();
  await expect(answerCard.locator('.b-note')).toHaveText(['Some sources were unreachable.']);
  await shot(page, 'search-error');

  await expectHermetic(app);
  const problems = [...app.diag.take(), ...(await app.rejections())];
  expect(problems.filter((problem) => !expectedSourceNoise(problem)), 'unexpected error during the failure path')
    .toEqual([]);
  await expectStateA11y(page, 'visual-search-error');
});

test('@visual search unavailable: no Source answered', async ({ page }) => {
  // Every search origin answers with an EMPTY document: a valid response that
  // carries nothing usable. r.jina.ai answers with an empty body, which
  // js/search.js drops instead of counting an empty Source, so the "no search
  // results" state is reachable: the answer card says so once, and nothing else.
  for (const host of SEARCH_HOSTS) {
    await fixture.setSource(host, { body: host === 'r.jina.ai' ? '' : '{}', contentType: 'application/json' });
  }
  await page.clock.setFixedTime(FIXED_NOW);
  const app = await bootApp(page);

  await app.ask(QUESTION);
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe(DEFAULT_ANSWER);
  // No usable Sources at all, and nothing failed either: one note, no "Sources".
  expect(answer.sources).toBe('');
  const answerCard = page.locator('#b-transcript .b-ans').last();
  await expect(answerCard.locator('.b-note')).toHaveText(['Web search was not available for this answer.']);
  await shot(page, 'search-unavailable');

  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
  await expectStateA11y(page, 'visual-search-unavailable');
});

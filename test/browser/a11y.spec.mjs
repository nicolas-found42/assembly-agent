// a11y.spec.mjs — accessibility + responsive behaviour of the staged app.
//
// Coverage maps assertion by assertion onto the legacy manual harness
// (test/a11y.browser.mjs, puppeteer + a possibly-CDN axe) which this replaces:
//
//   legacy §1 axe scan of main view + every dialog      -> 'axe:' test
//   legacy §2 Tab order, per-dialog trap, Escape+focus  -> 'keyboard:' tests
//   legacy §3 24px targets / strip wrap / no overflow   -> 'reflow:' tests
//   legacy §4 Shift+Enter, Enter, Stop, error row        -> 'composer:' tests
//                                                          (the offline error
//                                                          branch is asserted
//                                                          deterministically in
//                                                          boot.spec.mjs)
//   legacy §5 no terminal affordances, chat aria labels  -> 'copy:' test
//   legacy §6 200% zoom reflow (640x475)                 -> 'zoom:' test
// plus what the campaign asked for on top: live-region announcements, reduced
// motion, and horizontal-overflow checks at phone widths.

import { test, expect } from '@playwright/test';
import { bootApp, DIALOGS } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';
import {
  expectNoBlocking, expectNoNewLowImpact, loadBaseline, recordBaseline,
} from './lib/a11y.mjs';

const fixture = fixtureClient();
const HEADER_IDS = ['b-new', 'b-chats', 'b-assist', 'b-model', 'b-settings'];
const PHONE_VIEWPORTS = [360, 320];

test.beforeEach(async () => { await fixture.reset(); });

/** Start a turn whose SSE stream the fixture holds open, so mid-turn state
 *  (progress row, Stop button, live region) is observable without a sleep. */
async function holdTurn(app, question = 'A question the fixture will hold open') {
  await fixture.setChat({ mode: 'manual' });
  await app.ask(question);
  await expect(app.locator('#b-st-progress')).toHaveText('Writing your answer…');
  await expect(app.locator('#b-send')).toHaveText('Stop');
  await expect(app.locator('#b-transcript .b-progress')).toBeVisible();
}

// ── axe: main view + every dialog ────────────────────────────────────────
test('@a11y axe: main view and every dialog stay free of critical/serious violations', async ({ page }) => {
  const app = await bootApp(page);

  const results = { main: await expectNoBlocking(page, 'main') };
  for (const dialog of DIALOGS) {
    await app.openDialog(dialog.name);
    results[dialog.name] = await expectNoBlocking(page, dialog.name);
    await app.closeDialog(dialog.name);
    expect(await app.isDialogOpen(dialog.name)).toBe(false);
  }

  // First run of a new scan set: record it, review, commit. Never silent.
  if (process.env.A11Y_BASELINE_WRITE === '1') {
    recordBaseline(results);
    test.info().annotations.push({ type: 'baseline', description: 'rewrote test/browser/a11y-baseline.json' });
    return;
  }
  const baseline = loadBaseline();
  for (const [label, result] of Object.entries(results)) {
    expectNoNewLowImpact(result, label, baseline);
  }
  expect(await app.allProblems()).toEqual([]);
});

// ── keyboard ─────────────────────────────────────────────────────────────
// Playwright's WebKit follows Safari's default keyboard policy: Tab never
// visits a <button> (verified against a bare page — buttons are absent from the
// tab walk while [tabindex="0"] and form fields are in it). The tab-walk and
// focus-cycle assertions below therefore run on the engines that expose the
// full tab sequence, and WebKit keeps the engine-independent guarantees:
// header controls accept focus and activate by Enter, a dialog takes focus on
// open, and Escape closes it and restores focus to the composer.
const TABS_TO_BUTTONS = (projectName) => projectName !== 'webkit';

test('@a11y keyboard: Tab reaches every header button in order', async ({ page }, testInfo) => {
  const app = await bootApp(page);
  const activeId = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || '');

  // Start from a known tab stop: the browser's own starting-point rules after a
  // blur differ per engine, and this test is about the app's tab order.
  await page.locator('#b-new').focus();
  const walk = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    walk.push(await activeId());
  }

  if (TABS_TO_BUTTONS(testInfo.project.name)) {
    expect(walk.slice(0, 4), `tab walk was ${walk.join(' → ')}`).toEqual(['b-chats', 'b-assist', 'b-model', 'b-settings']);
    expect(walk).toContain('b-transcript');
    expect(walk).toContain('b-input');
    expect(walk).toContain('b-send');
  } else {
    testInfo.annotations.push({ type: 'webkit', description: 'Tab skips <button> in WebKit; header focusability asserted directly' });
    expect(walk, `tab walk was ${walk.join(' → ')}`).toEqual(expect.arrayContaining(['b-transcript', 'b-input']));
    for (const id of HEADER_IDS) {
      await page.locator(`#${id}`).focus();
      expect(await activeId(), `${id} cannot take focus`).toBe(id);
    }
  }

  // The composer is reachable too, and the transcript is a labelled log region.
  expect(await app.locator('#b-input').getAttribute('aria-label')).toBe('Message');
  expect(await app.allProblems()).toEqual([]);
});

for (const dialog of DIALOGS) {
  test(`@a11y keyboard: the ${dialog.name} dialog opens by keyboard, traps focus and restores it`, async ({ page }, testInfo) => {
    const app = await bootApp(page);
    const id = dialog.dialog.slice(1);

    await page.locator(dialog.button).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(dialog.dialog)).toHaveJSProperty('open', true);

    const inside = () => page.evaluate((sel) => !!document.getElementById(sel)?.contains(document.activeElement), id);
    // Opening a modal dialog moves focus into it in every engine.
    expect(await inside(), `focus did not enter the ${dialog.name} dialog`).toBe(true);

    if (TABS_TO_BUTTONS(testInfo.project.name)) {
      // 20 forward and 10 backward steps never leave the dialog.
      for (let i = 0; i < 20; i += 1) {
        await page.keyboard.press('Tab');
        expect(await inside(), `Tab escaped the ${dialog.name} dialog after ${i + 1} press(es)`).toBe(true);
      }
      for (let i = 0; i < 10; i += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(await inside(), `Shift+Tab escaped the ${dialog.name} dialog after ${i + 1} press(es)`).toBe(true);
      }
    } else {
      testInfo.annotations.push({ type: 'webkit', description: 'Tab cycle not asserted: WebKit does not tab to dialog buttons' });
    }

    await page.keyboard.press('Escape');
    await expect(page.locator(dialog.dialog)).toHaveJSProperty('open', false);
    await expect(page.locator('#b-input')).toBeFocused();

    expect(await app.allProblems()).toEqual([]);
  });
}

// ── phone widths: targets, wrapping, overflow (WCAG 1.4.10 / target size) ──
for (const width of PHONE_VIEWPORTS) {
  test(`@a11y reflow: ${width}px stays usable and never overflows`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 360 ? 640 : 568 });
    const app = await bootApp(page);

    const measured = await page.evaluate(() => {
      const visible = (el) => {
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
      };
      const targets = [...document.querySelectorAll('.b-act, #b-send')]
        .filter(visible)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.id || el.className, w: r.width, h: r.height };
        });
      const strip = document.getElementById('b-status');
      const stripKids = [...strip.children].filter((c) => c.getClientRects().length);
      const transcript = document.getElementById('b-transcript');
      const composer = document.getElementById('b-composer').getBoundingClientRect();
      return {
        targets,
        strip: {
          wrap: getComputedStyle(strip).flexWrap,
          scrollWidth: strip.scrollWidth,
          clientWidth: strip.clientWidth,
          clipped: stripKids.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.id || c.className),
          outside: stripKids.filter((c) => {
            const r = c.getBoundingClientRect();
            return r.left < -1 || r.right > window.innerWidth + 1;
          }).map((c) => c.id || c.className),
        },
        overflow: {
          vw: window.innerWidth,
          docScrollWidth: document.scrollingElement.scrollWidth,
          transcriptOverflowY: getComputedStyle(transcript).overflowY,
          transcriptClientWidth: transcript.clientWidth,
          transcriptScrollWidth: transcript.scrollWidth,
        },
        composer: { top: composer.top, bottom: composer.bottom, width: composer.width, vh: window.innerHeight },
      };
    });

    const small = measured.targets.filter((t) => t.w < 24 || t.h < 24);
    expect(small.map((t) => `${t.id} ${t.w.toFixed(0)}x${t.h.toFixed(0)}`), 'targets under 24x24').toEqual([]);
    expect(measured.strip.wrap).toBe('wrap');
    expect(measured.strip.clipped, 'status segments clipped instead of wrapped').toEqual([]);
    expect(measured.strip.outside, 'status segments outside the viewport').toEqual([]);
    expect(measured.strip.scrollWidth).toBeLessThanOrEqual(measured.strip.clientWidth + 2);
    expect(measured.overflow.docScrollWidth, 'horizontal overflow').toBeLessThanOrEqual(measured.overflow.vw + 1);
    expect(['auto', 'scroll']).toContain(measured.overflow.transcriptOverflowY);
    expect(measured.overflow.transcriptClientWidth).toBeLessThanOrEqual(measured.overflow.vw + 1);
    expect(measured.composer.width).toBeGreaterThan(0);
    expect(measured.composer.top).toBeLessThan(measured.composer.vh);
    expect(measured.composer.bottom).toBeGreaterThan(0);

    expect(await app.allProblems()).toEqual([]);
  });
}

// ── 200% zoom equivalent (640x475 ≈ 1280x950 at 2x) ──────────────────────
test('@a11y zoom: the 200% zoom layout keeps the composer usable', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 475 });
  const app = await bootApp(page);

  // Long content still scrolls inside the transcript, not off the page.
  await page.evaluate(() => {
    const row = document.createElement('div');
    row.className = 'b-turn';
    row.textContent = 'overflow probe '.repeat(200);
    document.getElementById('b-transcript').append(row);
  });
  const zoom = await page.evaluate(() => {
    const input = document.getElementById('b-input').getBoundingClientRect();
    const send = document.getElementById('b-send').getBoundingClientRect();
    const composer = document.getElementById('b-composer').getBoundingClientRect();
    const transcript = document.getElementById('b-transcript');
    const before = transcript.scrollTop;
    transcript.scrollTop = transcript.scrollHeight;
    return {
      vw: window.innerWidth,
      docScrollWidth: document.scrollingElement.scrollWidth,
      docOverflow: document.scrollingElement.scrollWidth - window.innerWidth,
      inputWidth: input.width,
      inputHeight: input.height,
      inputInView: input.top >= 0 && input.bottom <= window.innerHeight,
      sendW: send.width,
      sendH: send.height,
      sendInView: send.top >= 0 && send.bottom <= window.innerHeight,
      composerInView: composer.top >= 0 && composer.bottom <= window.innerHeight,
      transcriptOverflowY: getComputedStyle(transcript).overflowY,
      scrollMoved: transcript.scrollTop !== before,
    };
  });
  expect(zoom.inputInView).toBe(true);
  expect(zoom.inputWidth).toBeGreaterThan(0);
  expect(zoom.sendInView && zoom.sendW >= 24 && zoom.sendH >= 24).toBe(true);
  expect(zoom.composerInView).toBe(true);
  expect(zoom.scrollMoved).toBe(true);
  expect(['auto', 'scroll']).toContain(zoom.transcriptOverflowY);
  expect(zoom.docScrollWidth).toBeLessThanOrEqual(zoom.vw + 1);

  // The composer still accepts input at this size.
  await app.ask('zoom check', { submit: false });
  await expect(app.locator('#b-input')).toHaveValue('zoom check\n'); // Shift+Enter added the newline

  expect(await app.allProblems()).toEqual([]);
});

// ── composer: newline vs send, and Stop ──────────────────────────────────
test('@a11y composer: Shift+Enter inserts a newline, Enter sends, Stop ends the turn', async ({ page }) => {
  const app = await bootApp(page);
  const before = await app.transcript();
  const idle = await app.status();

  await app.ask('line one', { submit: false });
  await page.keyboard.type('line two');
  const value = await app.locator('#b-input').inputValue();
  expect(value).toContain('\n');
  expect(value).toBe('line one\nline two');

  // Nothing was sent: no new row, same button, same status text.
  expect(await app.transcript()).toEqual(before);
  expect(await app.status()).toEqual(idle);

  // Enter starts the turn; the fixture holds the stream so the Stop state is
  // observable on demand rather than raced.
  await fixture.setChat({ mode: 'manual' });
  await app.locator('#b-input').press('Enter');
  await expect(app.locator('#b-st-progress')).toHaveText('Writing your answer…');
  await expect(app.locator('#b-send')).toHaveText('Stop');
  await expect(app.locator('#b-send')).toHaveAttribute('aria-label', 'Stop');
  const mid = await app.transcript();
  expect(mid.users).toContain('line one\nline two');
  // The answer card is open but empty: the stream is held, nothing landed yet.
  expect(mid.answers.map((a) => a.text)).toEqual(['']);

  await app.locator('#b-send').click();
  await expect(page.locator('#b-transcript .b-error')).toContainText('Stopped.');
  await expect(app.locator('#b-send')).toHaveText('Send');
  await expect(app.locator('#b-send')).toHaveAttribute('aria-label', 'Send message');
  await expect(app.locator('#b-st-progress')).toHaveText('Ready');
  expect((await app.transcript()).answers).toEqual([]);

  // Stopping aborts the in-flight POST. Chromium does not report that to the
  // page; firefox (NS_BINDING_ABORTED) and webkit (cancelled) do. That failure
  // is the deliberate abort — and it is the only POST /api/chat that could have
  // failed by now.
  const afterStop = (await app.allProblems()).filter((p) => !/failed request: POST \S*\/api\/chat\b/.test(p));
  expect(afterStop).toEqual([]);
});

// ── live region announcements ────────────────────────────────────────────
test('@a11y status: the live region announces turn state and completion', async ({ page }) => {
  const app = await bootApp(page);
  const announcer = page.locator('#a11y-status');
  await expect(announcer).toHaveAttribute('role', 'status');
  await expect(announcer).toHaveAttribute('aria-live', 'polite');
  await expect(announcer).toHaveAttribute('aria-atomic', 'true');

  await holdTurn(app, 'Announce this turn');
  await expect.poll(() => app.announcement(), { timeout: 5000 })
    .toMatch(/Thinking\.|Searching the web\.|Writing your answer\./);

  await fixture.release();
  await app.waitForAnswer();
  await expect.poll(() => app.announcement(), { timeout: 5000 }).toBe('Response complete.');
  expect(await page.locator('#b-st-progress').textContent()).toBe('Ready');

  expect(await app.allProblems()).toEqual([]);
});

// ── reduced motion ───────────────────────────────────────────────────────
test('@a11y motion: prefers-reduced-motion stops the CRT animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const app = await bootApp(page);

  const scanline = () => page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.b-crt .b-scan'), '::after');
    return { animation: style.animationName, opacity: style.opacity };
  });
  await expect.poll(scanline).toEqual({ animation: 'none', opacity: '0' });

  // The turn progress indicator animates by default and must not with reduce;
  // toggling the preference back proves the assertion is not vacuous.
  const progressAnimation = () => page.evaluate(() => {
    const row = document.querySelector('#b-transcript .b-progress');
    return row ? getComputedStyle(row, '::before').animationName : 'no progress row';
  });
  await holdTurn(app, 'Motion check');
  await expect.poll(progressAnimation).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(progressAnimation).not.toBe('none');

  await fixture.release();
  await app.waitForAnswer();
  expect(await app.allProblems()).toEqual([]);
});

// ── product copy: no terminal/diagnostics affordances ────────────────────
test('@a11y copy: no terminal affordances and chat-shaped aria labels', async ({ page }) => {
  const app = await bootApp(page);

  const scan = await page.evaluate((patterns) => {
    const modelText = document.getElementById('b-st-model')?.textContent || '';
    const bodyText = document.body.innerText.replace(modelText, '');
    const attrs = [];
    for (const el of document.body.querySelectorAll('*')) {
      for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute?.(name);
        if (v) attrs.push(`${name}="${v}"`);
      }
    }
    const surfaces = {
      header: document.querySelector('.b-header')?.textContent || '',
      status: document.getElementById('b-status')?.textContent || '',
      composer: document.getElementById('b-composer')?.textContent || '',
      document: bodyText,
      attributes: attrs.join('\n'),
    };
    const hits = [];
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const pattern of patterns) {
        const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const m = re.exec(text);
        if (m) hits.push(`${surface}: "${pattern}" → …${text.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')}…`);
      }
    }
    return {
      hits,
      labels: {
        nav: document.querySelector('.b-acts')?.getAttribute('aria-label'),
        input: document.getElementById('b-input')?.getAttribute('aria-label'),
        placeholder: document.getElementById('b-input')?.getAttribute('placeholder'),
        transcript: document.getElementById('b-transcript')?.getAttribute('aria-label'),
        transcriptRole: document.getElementById('b-transcript')?.getAttribute('role'),
        status: document.getElementById('b-status')?.getAttribute('aria-label'),
        statusRole: document.getElementById('b-status')?.getAttribute('role'),
        send: document.getElementById('b-send')?.getAttribute('aria-label'),
      },
    };
  }, ['guest@asm', 'tok/s', 'mem', ':mem', 'command suggestions', 'terminal']);

  expect(scan.hits).toEqual([]);
  expect(scan.labels).toEqual({
    nav: 'App',
    input: 'Message',
    placeholder: 'Ask a question',
    transcript: 'Chat history',
    transcriptRole: 'log',
    status: 'Status',
    statusRole: 'group',
    send: 'Send message',
  });

  expect(await app.allProblems()).toEqual([]);
});

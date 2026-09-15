// lib/app.mjs — page object for the staged ASM::AGENT app.
//
// bootApp(page) installs the harness (network routing + the asm.proxyUrl
// override that points the app at the fixture Worker), navigates to the staged
// build and waits until boot has settled. Everything a spec asserts goes
// through the App methods below, so selectors live in one place.

import { expect } from '@playwright/test';
import { FIXTURE, installNetwork } from './network.mjs';
import { BASE_URL } from './ports.mjs';

/** Where the app posts /api/chat when asm.proxyUrl is set (js/bridge.js). */
export const PROXY_URL = `${FIXTURE}/api/chat`;

/** Boot settles on one of these status-strip strings (js/main.js boot()). */
export const SETTLED = ['Ready', 'No model list', 'Not available'];
const SETTLED_RE = new RegExp(`^(${SETTLED.join('|')})$`);

/** The four dialogs js/main.js builds, keyed by header button. */
export const DIALOGS = [
  { name: 'chats', button: '#b-chats', dialog: '#b-dlg-chats' },
  { name: 'assistants', button: '#b-assist', dialog: '#b-dlg-assistants' },
  { name: 'model', button: '#b-model', dialog: '#b-dlg-model' },
  { name: 'settings', button: '#b-settings', dialog: '#b-dlg-settings' },
];

/** Browsers request /favicon.ico speculatively; index.html declares none and
 *  the staged site (like GitHub Pages) answers 404. Not a product asset. */
const isSpeculative = (url) => new URL(url).pathname === '/favicon.ico';

/**
 * Boot the app against the fixture server.
 * @returns {Promise<App>} page object; `app.problems()` lists harness findings.
 */
export async function bootApp(page) {
  const net = await installNetwork(page);
  const diag = new Diagnostics();

  // Answer the speculative favicon request so it cannot be mistaken for a
  // missing asset. Registered after installNetwork: later routes win.
  await page.route((url) => isSpeculative(url.href), (route) => route.fulfill({ status: 204, body: '' }));

  // The proxy override must exist before the app module runs.
  await page.addInitScript((url) => {
    try { localStorage.setItem('asm.proxyUrl', url); } catch { /* storage blocked */ }
  }, PROXY_URL);
  // Unhandled rejections are not reliably page errors in every engine.
  await page.addInitScript(() => {
    window.__harnessRejections = [];
    window.addEventListener('unhandledrejection', (ev) => {
      window.__harnessRejections.push(String((ev.reason && ev.reason.stack) || ev.reason || 'unhandled rejection'));
    });
  });

  page.on('pageerror', (err) => diag.pageErrors.push(String(err?.stack || err)));
  page.on('console', (msg) => { if (msg.type() === 'error') diag.consoleErrors.push(msg.text()); });
  page.on('requestfailed', (req) => {
    if (!isSpeculative(req.url())) diag.requestFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (res) => {
    if (res.status() < 400 || isSpeculative(res.url())) return;
    if (new URL(res.url()).origin !== new URL(BASE_URL).origin) return;
    diag.badResponses.push(`${res.status()} ${res.url()}`);
  });

  await page.goto(BASE_URL, { waitUntil: 'load' });
  const app = new App(page, net, diag);
  await app.waitForBoot();
  return app;
}

export class Diagnostics {
  constructor() {
    this.pageErrors = [];
    this.consoleErrors = [];
    this.requestFailures = [];
    this.badResponses = [];
  }

  /** Everything the harness treats as a defect, as readable lines. */
  problems() {
    return [
      ...this.pageErrors.map((e) => `uncaught error: ${e}`),
      ...this.consoleErrors.map((e) => `console error: ${e}`),
      ...this.badResponses.map((e) => `bad local response: ${e}`),
      ...this.requestFailures.map((e) => `failed request: ${e}`),
    ];
  }

  take() {
    const out = this.problems();
    this.pageErrors = [];
    this.consoleErrors = [];
    this.requestFailures = [];
    this.badResponses = [];
    return out;
  }
}

export class App {
  constructor(page, net, diag) {
    this.page = page;
    this.net = net;
    this.diag = diag;
  }

  locator(selector) { return this.page.locator(selector); }

  /** Unhandled rejections recorded by the init script. */
  async rejections() {
    return this.page.evaluate(() => window.__harnessRejections || []);
  }

  /** The status strip: progress / assistant / model / key. */
  async status() {
    return this.page.evaluate(() => ({
      progress: document.getElementById('b-st-progress')?.textContent.trim() || '',
      assistant: document.getElementById('b-st-assistant')?.textContent.trim() || '',
      model: document.getElementById('b-st-model')?.textContent.trim() || '',
      key: document.getElementById('b-st-key')?.textContent.trim() || '',
      send: document.getElementById('b-send')?.textContent.trim() || '',
    }));
  }

  async progress() { return (await this.status()).progress; }

  /** Live-region text: turn-state announcements (js/a11y.js). */
  async announcement() {
    return this.page.evaluate(() => document.getElementById('a11y-status')?.textContent.trim() || '');
  }

  /** Boot is settled when the progress strip left its start state and the
   *  transcript owns a row (welcome banner, restored chat, or the error row). */
  async waitForBoot() {
    await expect.poll(() => this.progress(), { timeout: 15000 }).toMatch(SETTLED_RE);
    await expect.poll(
      () => this.page.evaluate(() => document.getElementById('b-transcript')?.children.length || 0),
      { timeout: 15000 },
    ).toBeGreaterThan(0);
  }

  /** Transcript state: user rows, answer cards, error rows. */
  async transcript() {
    return this.page.evaluate(() => {
      const rows = [...document.querySelectorAll('#b-transcript > *')];
      const text = (el) => (el?.textContent || '').trim();
      return {
        rows: rows.length,
        users: rows.filter((r) => r.classList.contains('b-user')).map((r) => text(r.querySelector('.b-user-txt'))),
        answers: rows.filter((r) => r.classList.contains('b-ans')).map((r) => ({
          text: text(r.querySelector('.b-md')),
          footer: text(r.querySelector('.b-foot .b-stat')),
          sources: text(r.querySelector('.b-src > summary')),
        })),
        errors: rows.filter((r) => r.classList.contains('b-error')).map(text),
        notices: rows.filter((r) => r.classList.contains('b-notice')).map(text),
      };
    });
  }

  /** Source links of the newest answer card. */
  async sources() {
    return this.page.evaluate(() => {
      const card = [...document.querySelectorAll('#b-transcript .b-ans')].at(-1);
      const links = [...(card?.querySelectorAll('.b-src-list a') || [])];
      return links.map((a) => ({ title: a.textContent.trim(), url: a.getAttribute('href') }));
    });
  }

  /** Type a question into the composer and submit it (Enter by default). */
  async ask(text, { submit = true } = {}) {
    const input = this.page.locator('#b-input');
    await input.click();
    await input.fill(text);
    if (submit) await input.press('Enter');
    else await input.press('Shift+Enter');
  }

  /** Wait until the turn's answer card is final and the strip is idle again. */
  async waitForAnswer({ timeout = 20000 } = {}) {
    await expect.poll(async () => (await this.status()).send, { timeout }).toBe('Send');
    await expect.poll(() => this.progress(), { timeout }).toMatch(/^(Ready|Something went wrong|Stopped)$/);
    await expect.poll(async () => {
      const t = await this.transcript();
      return t.answers.length ? t.answers.at(-1).text.length : 0;
    }, { timeout }).toBeGreaterThan(0);
    const t = await this.transcript();
    return t.answers.at(-1);
  }

  dialogByName(name) {
    const entry = DIALOGS.find((d) => d.name === name);
    if (!entry) throw new Error(`unknown dialog "${name}" (expected ${DIALOGS.map((d) => d.name).join(', ')})`);
    return entry;
  }

  async openDialog(name) {
    const entry = this.dialogByName(name);
    await this.page.locator(entry.button).click();
    await expect(this.page.locator(entry.dialog)).toHaveJSProperty('open', true);
    return entry;
  }

  async isDialogOpen(name) {
    return this.page.locator(this.dialogByName(name).dialog).evaluate((el) => !!el.open);
  }

  /** Escape closes the dialog and returns focus to the composer. */
  async closeDialog(name) {
    const entry = this.dialogByName(name);
    await this.page.keyboard.press('Escape');
    await expect(this.page.locator(entry.dialog)).toHaveJSProperty('open', false);
  }

  problems() { return this.diag.problems(); }

  /** Problems, including unhandled rejections captured in the page. */
  async allProblems() {
    const rejections = await this.rejections();
    return [...this.problems(), ...rejections.map((r) => `unhandled rejection: ${r}`)];
  }
}

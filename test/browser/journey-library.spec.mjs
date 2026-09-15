// journey-library.spec.mjs — R02 §5.3 journeys 7, 8 and 9, against the frozen
// harness (test/browser/lib/*, fixtures/upstream.mjs) and the staged _site/.
//
// Coverage map (campaign brief §5.3):
//
//   journey 7 — models and keys
//     models: a paid model stays visible but locked until a key exists
//     models: automatic is the newest free model and a free turn uses the proxy
//     keys:   the session key enables the paid path; removal blocks the next one
//     keys:   session-only by default, Remember opts in, Remove clears both
//
//   journey 8 — assistant library
//     assistants: the built-in is protected from edit and delete
//     assistants: create, edit, duplicate and delete a custom assistant
//     assistants: a valid export imports back as the same assistant
//     assistants: invalid and oversized imports are refused with the message
//     assistants: duplicate names skip identical records and copy a clash
//     assistants: a chat keeps its snapshot and takes a newer rev of the same one
//
//   journey 9 — chats and storage
//     chats: new, open, rename, delete and export
//     chats: the model choice is independent per chat
//     chats: a legacy v1 store migrates to v2, with no key in the backup
//     chats: a repeated migration changes nothing
//
// Rules kept: no real network (fixture server only), no key material outside
// the settings input, native confirm() answered by a handler that is asserted
// to have run, and every per-row button found by accessible text (never by
// index — list order is not a contract).

import { test, expect } from '@playwright/test';
import { bootApp } from './lib/app.mjs';
import { fixtureClient } from './lib/network.mjs';
import { DEFAULT_ANSWER, EXPECTED_DEFAULT_MODEL, UPSTREAM_HOSTS } from './fixtures/upstream.mjs';
// The migrated BASIC AGENT chat takes the built-in assistant's current
// instructions (js/store.js chatFromLegacy sets them from BUILTIN).
import { DEFAULT_PERSONA } from '../../js/persona.js';

const fixture = fixtureClient();

/** Synthetic credentials. Never a real key; never written to disk on purpose. */
const SESSION_KEY = 'sk-or-synthetic-session-5521';
const LEGACY_KEY = 'sk-or-synthetic-legacy-8842';

const SHORT_DEFAULT = EXPECTED_DEFAULT_MODEL.replace(/^.*\//, '').replace(/:free$/, '');
const SHORT_PAID = 'synthetic-paid';
const PAID_MODEL = 'asm/synthetic-paid';
const SHORT_MINI = 'synthetic-mini';
const MINI_MODEL = 'asm/synthetic-mini:free';
const LEGACY_MODEL = 'asm/synthetic-mini:free';
const DIRECT_ANSWER = 'Direct routing reached the synthetic OpenRouter fixture.';

/** Verbatim from js/store.js PRESET_BASIC: an unchanged BASIC AGENT session
 *  becomes the built-in assistant during migration. */
const LEGACY_BASIC = `You are a helpful assistant. You have one tool: web_search.

Use web_search when the answer depends on current or factual information that you are not sure about. Otherwise answer directly, with no search.

After a search, answer the question from the results you were given. Do not search again unless you need different information.

If the results do not answer the question, say what you found and what is still missing.

Keep answers short. Link your sources.`;

/** Two supported v1 records: a BASIC AGENT session (built-in mapping, with a
 *  legacy tool record that becomes Sources) and an unknown-preset session. */
const LEGACY_SESSIONS = [
  {
    id: 's-legacy-one',
    title: 'LEGACY ONE',
    created: 1700000000000,
    preset: 'BASIC AGENT',
    system: LEGACY_BASIC,
    messages: [
      { role: 0, content: LEGACY_BASIC },
      { role: 1, content: 'Which fixture answered this?' },
      { role: 2, content: 'The synthetic fixture answered.', tool_call_id: 'call_1', name: 'web_search', args: '{"query":"fixture"}' },
      { role: 3, content: '### [WEB] Synthetic Fixture\nhttps://en.wikipedia.org/wiki/Fixture\nA fixture is local test data.' },
    ],
  },
  {
    id: 's-legacy-two',
    title: 'LEGACY TWO',
    created: 1700000060000,
    preset: 'CUSTOM',
    system: 'You are a pirate.',
    messages: [
      { role: 0, content: 'You are a pirate.' },
      { role: 1, content: 'arr' },
      { role: 2, content: 'ahoy' },
    ],
  },
];

test.beforeEach(async () => { await fixture.reset(); });

// ── helpers ─────────────────────────────────────────────────────────────

/** No request may leave a fixture origin, and no fixture may be missing. */
async function expectHermetic(app) {
  expect(app.net.blocked, app.net.describeBlocked()).toEqual([]);
  for (const request of app.net.proxied) {
    expect(UPSTREAM_HOSTS).toContain(new URL(request.url).host);
  }
  const { misses } = await fixture.requests();
  expect(misses, `fixture gaps (a source shape is missing from fixtures/upstream.mjs): ${misses.join(', ')}`)
    .toEqual([]);
  expect(await app.allProblems()).toEqual([]);
}

/**
 * The key is allowed to live in the settings input (the dialog pre-fills it by
 * design). Everywhere else the test retains — page text, console output, saved
 * files, recorded request URLs — must stay free of it.
 */
async function expectNoKeyLeak(app, key, { consoleLines = [], files = [], requests = [] } = {}) {
  const pageText = await app.page.evaluate(() => {
    const skip = new Set(['INPUT', 'TEXTAREA']);
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out += `\n${node.nodeValue}`; return; }
      if (node.nodeType !== Node.ELEMENT_NODE || skip.has(node.tagName)) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(document.body);
    return out;
  });
  const harnessConsole = await app.allProblems();
  expect(pageText, 'the key must not appear in page text outside the settings input').not.toContain(key);
  expect([...consoleLines, ...harnessConsole].join('\n'), 'the key must not appear in console output').not.toContain(key);
  expect(JSON.stringify(files), 'the key must not appear in a file the test kept').not.toContain(key);
  expect(JSON.stringify(requests.map((r) => r.url)), 'the key must not appear in a recorded request URL').not.toContain(key);
}

/** Every capture the page produced, for the leak check. */
function captureConsole(page) {
  const lines = [];
  page.on('console', (msg) => lines.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (err) => lines.push(`pageerror: ${String(err)}`));
  return lines;
}

/** The asm.* storage, parsed, plus the raw strings for byte comparisons. */
const readStored = (page) => page.evaluate(() => {
  const parse = (raw) => { try { return raw == null ? null : JSON.parse(raw); } catch { return raw; } };
  const raw = { local: {}, session: {} };
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); raw.local[k] = localStorage.getItem(k); }
  for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); raw.session[k] = sessionStorage.getItem(k); }
  return {
    raw,
    chats: parse(raw.local['asm.chats.v2']) || [],
    activeChat: raw.local['asm.activeChat.v2'] ?? null,
    assistants: parse(raw.local['asm.assistants.v2']) || [],
    settings: parse(raw.local['asm.settings']),
    migration: parse(raw.local['asm.migration.v2']),
    backup: parse(raw.local['asm.legacy.backup.v1']),
    sessionKey: raw.session['asm.openrouter.key'] ?? null,
  };
});

/** Upstream/worker traffic the fixture answered, excluding control calls
 *  (each fixtureClient call is itself logged). */
async function recordedRequests() {
  const { requests } = await fixture.requests();
  return requests.filter((r) => r.kind !== 'control');
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A row of a list dialog, found by its exact title text (never by index). */
const rowByTitle = (page, scope, title) => page.locator(`${scope} li.b-row`).filter({
  has: page.locator('.b-row-t', { hasText: new RegExp(`^${escapeRegex(title)}$`) }),
});

/** A row found by its meta line — for lists where two rows share a title. */
const rowByMeta = (page, scope, text) => page.locator(`${scope} li.b-row`).filter({
  has: page.locator('.b-row-m', { hasText: text }),
});

/** Native confirm() is answered explicitly; the returned list proves the
 *  handler ran (an unhandled confirm would time the action out instead). */
function watchConfirms(page) {
  const seen = [];
  page.on('dialog', (dialog) => {
    seen.push({ type: dialog.type(), message: dialog.message() });
    dialog.accept().catch(() => {});
  });
  return seen;
}

/** Click something that downloads and return the file the browser produced. */
async function readDownload(page, action) {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { filename: download.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
}

/** SSE frames in the shape the engine's scanner reads (same as the fixture
 *  server writes): used to fulfil the direct OpenRouter path. */
function sseFrames(text) {
  return text.split(/(\s+)/).filter((part) => part !== '')
    .map((part) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
}

/** Create a custom assistant through the real editor. */
async function createAssistant(page, name, instructions) {
  await page.getByRole('button', { name: 'New assistant' }).click();
  await expect(page.locator('#b-dlg-edit')).toHaveJSProperty('open', true);
  await page.fill('#b-edit-name', name);
  await page.fill('#b-edit-ins', instructions);
  await page.getByRole('button', { name: 'Save assistant' }).click();
  await expect(page.locator('#b-dlg-edit')).toHaveJSProperty('open', false);
}

// ── journey 7: models and keys ──────────────────────────────────────────

test('@library models: a paid model stays visible but locked until a key exists', async ({ page }) => {
  const app = await bootApp(page);
  await app.openDialog('model');

  const paid = page.locator('#b-dlg-model .b-mrow').filter({ hasText: PAID_MODEL });
  await expect(paid).toBeVisible();
  await expect(paid.locator('.b-lock')).toContainText('Your API key required');
  // the free rows carry no lock — the gate is the key, not the row
  await expect(page.locator('#b-dlg-model .b-mrow').filter({ hasText: EXPECTED_DEFAULT_MODEL }).locator('.b-lock'))
    .toHaveCount(0);

  // Choosing it does not select it: it routes to Settings with the reason.
  await paid.getByRole('button', { name: /Synthetic Paid/ }).click();
  await expect(page.locator('#b-dlg-settings')).toHaveJSProperty('open', true);
  await expect(page.locator('#b-dlg-settings .b-dlg-note')).toHaveText('Add your OpenRouter API key to use this model.');
  expect(await app.isDialogOpen('model')).toBe(true);

  const { chats } = await readStored(page);
  expect(chats[0].model).toEqual({ mode: 'auto', id: EXPECTED_DEFAULT_MODEL });
  expect((await app.status()).key).toBe('No API key');

  await app.closeDialog('settings');
  await app.closeDialog('model');
  await expectHermetic(app);
});

test('@library models: automatic is the newest free model and a free turn uses the proxy', async ({ page }) => {
  const app = await bootApp(page);

  // The pinned automatic choice: newest free *text* model, not the newer
  // image-only free record in the catalog fixture.
  expect((await app.status()).model).toBe(SHORT_DEFAULT);
  expect((await readStored(page)).chats[0].model).toEqual({ mode: 'auto', id: EXPECTED_DEFAULT_MODEL });

  await app.openDialog('model');
  const auto = page.locator('#b-dlg-model #b-auto');
  await expect(auto).toHaveAttribute('aria-pressed', 'true');
  await expect(auto).toContainText(`uses ${EXPECTED_DEFAULT_MODEL}`);
  await app.closeDialog('model');

  // One turn with no key: it must go to the Worker proxy, never to OpenRouter.
  await app.ask('Which fixture answered this?');
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe(DEFAULT_ANSWER);

  const { requests } = await fixture.requests();
  expect(requests.filter((r) => r.kind === 'worker' && r.url === '/api/chat')).toHaveLength(1);
  expect(requests.some((r) => r.url.includes('/chat/completions')), 'the free turn must not call OpenRouter directly')
    .toBe(false);
  expect((await readStored(page)).chats[0].model).toEqual({ mode: 'auto', id: EXPECTED_DEFAULT_MODEL });

  await expectHermetic(app);
});

test('@library keys: a session key enables the paid path and removal blocks the next one', async ({ page }) => {
  const consoleLines = captureConsole(page);
  const app = await bootApp(page);

  await app.openDialog('settings');
  await page.fill('#b-set-key', SESSION_KEY);
  // The Settings "Test" button is a real round trip through the fixture.
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.locator('#b-dlg-settings .b-test-badge')).toHaveText('Valid');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(page.locator('#b-dlg-settings .b-test-badge')).toHaveText('Saved for this session.');
  await expect(page.locator('#b-st-key')).toHaveText('API key set');
  await app.closeDialog('settings');

  // A direct chat-completions answer from the fixture, only for this origin.
  await fixture.setSource('openrouter.ai', {
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    body: sseFrames(DIRECT_ANSWER),
  });

  await app.openDialog('model');
  const paid = page.locator('#b-dlg-model .b-mrow').filter({ hasText: PAID_MODEL });
  await expect(paid.locator('.b-lock')).toHaveCount(0);
  await paid.getByRole('button', { name: /Synthetic Paid/ }).click();
  await expect(page.locator('#b-st-model')).toHaveText(SHORT_PAID);
  expect((await readStored(page)).chats[0].model).toEqual({ mode: 'manual', id: PAID_MODEL });

  const workerBefore = (await recordedRequests()).filter((r) => r.kind === 'worker').length;
  await app.ask('Which fixture answered this?');
  const answer = await app.waitForAnswer();
  expect(answer.text).toBe(DIRECT_ANSWER);

  let requests = await recordedRequests();
  const direct = requests.filter((r) => r.host === 'openrouter.ai' && r.url.includes('/chat/completions'));
  expect(direct.length, 'the paid turn must call OpenRouter directly, through the fixture').toBeGreaterThan(0);
  expect(requests.filter((r) => r.kind === 'worker').length, 'the paid turn must not use the proxy')
    .toBe(workerBefore);
  await expectNoKeyLeak(app, SESSION_KEY, { consoleLines, requests });

  // Removing the key clears both stores and stops the next paid request cold.
  await app.openDialog('settings');
  await page.getByRole('button', { name: 'Remove key', exact: true }).click();
  await expect(page.locator('#b-st-key')).toHaveText('No API key');
  let stored = await readStored(page);
  expect(stored.sessionKey).toBeNull();
  expect(stored.settings.key).toBe('');
  expect(stored.settings.rememberKey).toBe(false);
  await app.closeDialog('settings');

  const before = (await recordedRequests()).length;
  await app.ask('Which fixture answered this?');
  await expect(page.locator('#b-transcript .b-err'))
    .toHaveText('This model needs your API key. Add a key in Settings, or choose a free model.');
  expect((await app.status()).send).toBe('Send');
  const after = await recordedRequests();
  expect(after.filter((r) => r.host === 'openrouter.ai' && r.url.includes('/chat/completions'))).toHaveLength(direct.length);
  expect(after.length, 'a blocked turn must not reach any origin').toBe(before);
  expect((await app.transcript()).answers).toHaveLength(1);

  stored = await readStored(page);
  expect(JSON.stringify(stored.raw)).not.toContain(SESSION_KEY);
  await expectHermetic(app);
});

test('@library keys: session-only by default, Remember opts in, Remove clears both', async ({ page }) => {
  const app = await bootApp(page);
  const badge = page.locator('#b-dlg-settings .b-test-badge');

  // Default: the key lives in sessionStorage only; nothing is written to disk.
  await app.openDialog('settings');
  await page.fill('#b-set-key', SESSION_KEY);
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(badge).toHaveText('Saved for this session.');
  let stored = await readStored(page);
  expect(stored.sessionKey).toBe(SESSION_KEY);
  expect(stored.settings).toEqual({
    crt: { scan: true, curve: true, flicker: false, sound: false },
    rememberKey: false,
    key: '',
  });
  expect(JSON.stringify(stored.raw.local), 'a session key must not reach localStorage').not.toContain(SESSION_KEY);
  await expectNoKeyLeak(app, SESSION_KEY);

  // Remove clears the session copy.
  await page.getByRole('button', { name: 'Remove key', exact: true }).click();
  stored = await readStored(page);
  expect(stored.sessionKey).toBeNull();
  expect(JSON.stringify(stored.raw)).not.toContain(SESSION_KEY);
  await expect(page.locator('#b-st-key')).toHaveText('No API key');

  // Explicit opt-in: the remembered key survives a reload with no session copy.
  await page.fill('#b-set-key', SESSION_KEY);
  await page.check('#b-set-remember');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(badge).toHaveText('Saved for this browser.');
  stored = await readStored(page);
  expect(stored.sessionKey).toBeNull();
  expect(stored.settings).toEqual({
    crt: { scan: true, curve: true, flicker: false, sound: false },
    rememberKey: true,
    key: SESSION_KEY,
  });
  await app.closeDialog('settings');

  await page.reload();
  await app.waitForBoot();
  await expect(page.locator('#b-st-key')).toHaveText('API key set');

  // The remembered key is the key the turn uses: with a key present even a free
  // model skips the Worker proxy and calls OpenRouter directly (js/bridge.js
  // shouldUseProxy — a key means direct routing). Fixture-served, one answer.
  await fixture.setSource('openrouter.ai', {
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    body: sseFrames(DIRECT_ANSWER),
  });
  await app.ask('Which fixture answered this?');
  expect((await app.waitForAnswer()).text).toBe(DIRECT_ANSWER);
  const requests = await recordedRequests();
  expect(requests.some((r) => r.host === 'openrouter.ai' && r.url.includes('/chat/completions')), 'a remembered key must route the turn')
    .toBe(true);
  expect(requests.some((r) => r.kind === 'worker'), 'with a key the Worker proxy must not be used').toBe(false);
  await expectNoKeyLeak(app, SESSION_KEY, { requests });

  // Remove clears the remembered copy too, and nothing is left anywhere.
  await app.openDialog('settings');
  await page.getByRole('button', { name: 'Remove key', exact: true }).click();
  await expect(page.locator('#b-st-key')).toHaveText('No API key');
  stored = await readStored(page);
  expect(stored.sessionKey).toBeNull();
  expect(stored.settings.key).toBe('');
  expect(stored.settings.rememberKey).toBe(false);
  expect(JSON.stringify(stored.raw)).not.toContain(SESSION_KEY);
  await app.closeDialog('settings');
  await expectHermetic(app);
});

// ── journey 8: the assistant library ────────────────────────────────────

test('@library assistants: the built-in is protected from edit and delete', async ({ page }) => {
  const app = await bootApp(page);
  await app.openDialog('assistants');

  const builtin = page.locator('#b-a-list li.b-row').filter({ has: page.locator('.b-tag') });
  await expect(builtin).toHaveCount(1);
  await expect(builtin.locator('.b-row-t')).toContainText('ASM::AGENT');
  await expect(builtin.locator('.b-tag')).toHaveText('Built-in');
  await expect(builtin.locator('.b-row-m')).toContainText('You are ASM::AGENT, a general-purpose assistant.');
  await expect(builtin.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(builtin.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await expect(builtin.getByRole('button', { name: 'Duplicate', exact: true })).toHaveCount(1);

  const { assistants } = await readStored(page);
  expect(assistants).toEqual([]);
  await expectHermetic(app);
});

test('@library assistants: create, edit, duplicate and delete a custom assistant', async ({ page }) => {
  const app = await bootApp(page);
  await app.openDialog('assistants');

  await createAssistant(page, 'Fixture Helper', 'Answer with fixture data only.');
  const row = rowByTitle(page, '#b-a-list', 'Fixture Helper');
  await expect(row).toHaveCount(1);
  let record = (await readStored(page)).assistants.find((a) => a.name === 'Fixture Helper');
  expect(record.instructions).toBe('Answer with fixture data only.');
  expect(record.rev).toBe(1);
  const id = record.id;

  // edit: same record, bumped revision
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#b-dlg-edit')).toHaveJSProperty('open', true);
  await page.fill('#b-edit-ins', 'Answer with fixture data only. Keep it short.');
  await page.getByRole('button', { name: 'Save assistant' }).click();
  await expect(page.locator('#b-dlg-edit')).toHaveJSProperty('open', false);
  record = (await readStored(page)).assistants.find((a) => a.name === 'Fixture Helper');
  expect(record.id).toBe(id);
  expect(record.instructions).toBe('Answer with fixture data only. Keep it short.');
  expect(record.rev).toBe(2);

  // duplicate: a copy of its own, same instructions, fresh revision
  await row.getByRole('button', { name: 'Duplicate', exact: true }).click();
  const copy = rowByTitle(page, '#b-a-list', 'Fixture Helper (copy)');
  await expect(copy).toHaveCount(1);
  const copies = (await readStored(page)).assistants.filter((a) => a.name === 'Fixture Helper (copy)');
  expect(copies).toHaveLength(1);
  expect(copies[0].instructions).toBe('Answer with fixture data only. Keep it short.');
  expect(copies[0].id).not.toBe(id);

  // delete: the native confirm is answered by the handler, which must run
  const confirms = watchConfirms(page);
  await copy.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rowByTitle(page, '#b-a-list', 'Fixture Helper (copy)')).toHaveCount(0);
  expect(confirms).toEqual([
    { type: 'confirm', message: 'Delete the assistant "Fixture Helper (copy)"? Chats that used it keep their instructions.' },
  ]);
  expect((await readStored(page)).assistants.map((a) => a.name)).toEqual(['Fixture Helper']);
  await expectHermetic(app);
});

test('@library assistants: a valid export imports back as the same assistant', async ({ page }) => {
  const app = await bootApp(page);
  await app.openDialog('assistants');
  await createAssistant(page, 'Round Trip', 'Round trip instructions v1.');

  const exported = await readDownload(page, () => page.getByRole('button', { name: 'Export all', exact: true }).click());
  expect(exported.filename).toBe('asm-agent-assistants.json');
  const dump = JSON.parse(exported.text);
  expect(dump.format).toBe('asm-agent.assistants');
  expect(dump.assistants).toEqual([{ name: 'Round Trip', instructions: 'Round trip instructions v1.', rev: 1 }]);

  // Remove it, then import the file the app just produced.
  const confirms = watchConfirms(page);
  await rowByTitle(page, '#b-a-list', 'Round Trip').getByRole('button', { name: 'Delete', exact: true }).click();
  expect(confirms).toHaveLength(1);
  await expect(rowByTitle(page, '#b-a-list', 'Round Trip')).toHaveCount(0);

  await page.fill('#b-imp-text', exported.text);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('#b-dlg-assistants .b-res')).toHaveText('Imported 1. Skipped 0.');
  await expect(rowByTitle(page, '#b-a-list', 'Round Trip')).toHaveCount(1);
  const back = (await readStored(page)).assistants.find((a) => a.name === 'Round Trip');
  expect(back.instructions).toBe('Round trip instructions v1.');
  await expectHermetic(app);
});

test('@library assistants: invalid and oversized imports are refused with the message', async ({ page }) => {
  const app = await bootApp(page);
  await app.openDialog('assistants');
  const result = page.locator('#b-dlg-assistants .b-res');
  const importButton = page.getByRole('button', { name: 'Import', exact: true });

  await page.fill('#b-imp-text', '{"hello":"world"}');
  await importButton.click();
  await expect(result).toHaveText('Imported 0. Skipped 0. The file is not an ASM::AGENT assistant export.');

  await page.fill('#b-imp-text', '{oops');
  await importButton.click();
  await expect(result).toHaveText('Imported 0. Skipped 0. The file is not valid JSON.');

  // The cap is inclusive: exactly 256 KB is still accepted, so the refusal
  // below is about the cap and not about the paste path.
  const boundary = JSON.stringify({
    format: 'asm-agent.assistants',
    version: 1,
    assistants: [{ name: 'At The Cap', instructions: 'Exactly at the import cap.' }],
  });
  const padded = boundary + ' '.repeat(256 * 1024 - boundary.length);
  expect(Buffer.byteLength(padded)).toBe(256 * 1024);
  await page.fill('#b-imp-text', padded);
  await importButton.click();
  await expect(result).toHaveText('Imported 1. Skipped 0.');

  // Oversized through the real file input: 256 KB + 1 byte.
  await page.fill('#b-imp-text', '');
  await page.setInputFiles('#b-imp-file', {
    name: 'huge.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(256 * 1024 + 1, 0x78),
  });
  await importButton.click();
  await expect(result).toHaveText('Imported 0. Skipped 0. The file is larger than 256 KB.');

  await page.setInputFiles('#b-imp-file', []);
  await importButton.click();
  await expect(result).toHaveText('Choose a file or paste an assistant file first.');

  expect((await readStored(page)).assistants.map((a) => a.name)).toEqual(['At The Cap']);
  await expectHermetic(app);
});

test('@library assistants: duplicate names skip identical records and copy a clash', async ({ page }) => {
  const app = await bootApp(page);
  await app.openDialog('assistants');
  await createAssistant(page, 'Twin', 'Twin text one.');

  const payload = {
    format: 'asm-agent.assistants',
    version: 1,
    exported: new Date().toISOString(),
    assistants: [
      { name: 'Twin', instructions: 'Twin text one.', rev: 1 },     // identical -> skipped
      { name: 'Twin', instructions: 'Twin text two.', rev: 1 },     // name clash -> copy
      { name: 'ASM::AGENT', instructions: 'EVIL', rev: 1 },         // built-in clash -> copy
    ],
  };
  await page.fill('#b-imp-text', JSON.stringify(payload));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('#b-dlg-assistants .b-res')).toHaveText('Imported 2. Skipped 1.');

  const assistants = (await readStored(page)).assistants;
  expect(assistants.map((a) => a.name).sort()).toEqual(['ASM::AGENT (copy)', 'Twin', 'Twin (copy)']);
  expect(assistants.find((a) => a.name === 'Twin').instructions).toBe('Twin text one.');
  expect(assistants.find((a) => a.name === 'Twin (copy)').instructions).toBe('Twin text two.');
  expect(assistants.some((a) => a.id === 'asm-agent'), 'the built-in never becomes a stored record').toBe(false);

  // The built-in row still shows its own persona, and its next copy is numbered.
  const builtin = page.locator('#b-a-list li.b-row').filter({ has: page.locator('.b-tag') });
  await expect(builtin.locator('.b-row-m')).toContainText('You are ASM::AGENT, a general-purpose assistant.');
  await rowByTitle(page, '#b-a-list', 'Twin').getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(rowByTitle(page, '#b-a-list', 'Twin (copy 2)')).toHaveCount(1);
  await expectHermetic(app);
});

test('@library assistants: a chat keeps its snapshot and takes a newer rev of the same one', async ({ page }) => {
  const app = await bootApp(page);
  await app.openDialog('assistants');
  await createAssistant(page, 'Snapshot Keeper', 'Snapshot instructions v1.');
  await createAssistant(page, 'Rival', 'Rival instructions.');

  // Start a chat on Snapshot Keeper from its own row.
  await rowByTitle(page, '#b-a-list', 'Snapshot Keeper').getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.locator('#b-dlg-assistants')).toHaveJSProperty('open', false);
  await expect(page.locator('#b-st-assistant')).toHaveText('Snapshot Keeper');

  const keeperId = (await readStored(page)).assistants.find((a) => a.name === 'Snapshot Keeper').id;
  const chatId = (await readStored(page)).activeChat;
  let chatRecord = (await readStored(page)).chats.find((c) => c.id === chatId);
  expect(chatRecord.assistantId).toBe(keeperId);
  expect(chatRecord.assistantRev).toBe(1);
  expect(chatRecord.instructions).toBe('Snapshot instructions v1.');

  // Edit the library record: the chat keeps its snapshot.
  await app.openDialog('assistants');
  await rowByTitle(page, '#b-a-list', 'Snapshot Keeper').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.fill('#b-edit-ins', 'Snapshot instructions v2.');
  await page.getByRole('button', { name: 'Save assistant' }).click();
  await expect(page.locator('#b-dlg-edit')).toHaveJSProperty('open', false);
  await app.closeDialog('assistants');

  chatRecord = (await readStored(page)).chats.find((c) => c.id === chatId);
  expect(chatRecord.instructions).toBe('Snapshot instructions v1.');
  expect(chatRecord.assistantRev).toBe(1);
  expect(chatRecord.assistantName).toBe('Snapshot Keeper');

  // Re-opening the chat offers the newer revision of the same assistant.
  // 'New chat' is not unique here (boot created one too), so the row is found
  // by the assistant it keeps.
  await app.openDialog('chats');
  await rowByMeta(page, '#b-dlg-chats', 'Snapshot Keeper')
    .getByRole('button', { name: 'Open', exact: true }).click();
  const notice = page.locator('#b-transcript .b-notice');
  await expect(page.locator('#b-transcript .b-notice-t'))
    .toHaveText('This chat uses an older copy of the instructions for Snapshot Keeper.');
  await page.getByRole('button', { name: 'Update instructions' }).click();
  await expect(notice).toHaveCount(0);

  chatRecord = (await readStored(page)).chats.find((c) => c.id === chatId);
  expect(chatRecord.instructions).toBe('Snapshot instructions v2.');
  expect(chatRecord.assistantRev).toBe(2);
  expect(chatRecord.assistantId, 'the newer revision must come from the same assistant').toBe(keeperId);
  expect(chatRecord.assistantName).toBe('Snapshot Keeper');
  await expectHermetic(app);
});

// ── journey 9: chats and storage ────────────────────────────────────────

test('@library chats: new, open, rename, delete and export', async ({ page }) => {
  const consoleLines = captureConsole(page);
  const app = await bootApp(page);

  // The turn runs with no key, so the automatic free model uses the proxy.
  await app.ask('What is a synthetic fixture?');
  await app.waitForAnswer();

  // A session key is present while exporting, so the leak assertion has
  // something real to find: the export must not carry it.
  await app.openDialog('settings');
  await page.fill('#b-set-key', SESSION_KEY);
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await app.closeDialog('settings');

  // The first turn titled the chat from the question (js/main.js persistTurn).
  await app.openDialog('chats');
  const row = rowByTitle(page, '#b-dlg-chats', 'What is a synthetic fixture?');
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Rename', exact: true }).click();
  const titleInput = page.locator('#b-dlg-chats input[aria-label="Chat title"]');
  await titleInput.fill('Renamed chat');
  await titleInput.press('Enter');
  await expect(rowByTitle(page, '#b-dlg-chats', 'Renamed chat')).toHaveCount(1);
  const renamedId = (await readStored(page)).chats.find((c) => c.title === 'Renamed chat').id;

  // New chat: a different chat with its own empty transcript.
  await page.locator('#b-dlg-chats').getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.locator('#b-transcript .b-ans')).toHaveCount(0);

  // Open the renamed chat again: its transcript comes back.
  await app.openDialog('chats');
  await rowByTitle(page, '#b-dlg-chats', 'Renamed chat').getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('#b-transcript')).toContainText('What is a synthetic fixture?');
  await expect(page.locator('#b-transcript .b-ans')).toHaveCount(1);
  expect((await readStored(page)).activeChat).toBe(renamedId);

  // Export both formats from the row (the real Blob download path).
  await app.openDialog('chats');
  const md = await readDownload(page, () => rowByTitle(page, '#b-dlg-chats', 'Renamed chat')
    .getByRole('button', { name: 'Export .md', exact: true }).click());
  expect(md.filename).toBe('Renamed-chat.md');
  expect(md.text).toContain('# Renamed chat');
  expect(md.text).toContain('## You');
  expect(md.text).toContain('What is a synthetic fixture?');

  const json = await readDownload(page, () => rowByTitle(page, '#b-dlg-chats', 'Renamed chat')
    .getByRole('button', { name: 'Export .json', exact: true }).click());
  expect(json.filename).toBe('Renamed-chat.json');
  const exportedChat = JSON.parse(json.text);
  expect(exportedChat.title).toBe('Renamed chat');
  expect(exportedChat.messages[0]).toEqual({ role: 'user', content: 'What is a synthetic fixture?' });
  expect(exportedChat).not.toHaveProperty('draft');

  await expectNoKeyLeak(app, SESSION_KEY, {
    consoleLines,
    files: [md.text, json.text],
    requests: await recordedRequests(),
  });

  // Delete the inactive chat, then the active one: the app starts a new chat.
  const confirms = watchConfirms(page);
  await rowByTitle(page, '#b-dlg-chats', 'New chat').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rowByTitle(page, '#b-dlg-chats', 'New chat')).toHaveCount(0);
  expect(confirms).toEqual([{ type: 'confirm', message: 'Delete the chat "New chat"? This cannot be undone.' }]);

  await rowByTitle(page, '#b-dlg-chats', 'Renamed chat').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rowByTitle(page, '#b-dlg-chats', 'Renamed chat')).toHaveCount(0);
  expect(confirms[1]).toEqual({ type: 'confirm', message: 'Delete the chat "Renamed chat"? This cannot be undone.' });

  const after = await readStored(page);
  expect(after.chats.map((c) => c.title)).toEqual(['New chat']);
  expect(after.activeChat).not.toBe(renamedId);
  await app.closeDialog('chats');
  await expect(page.locator('#b-transcript')).not.toContainText('What is a synthetic fixture?');
  await expectHermetic(app);
});

test('@library chats: the model choice is independent per chat', async ({ page }) => {
  const app = await bootApp(page);

  // Chat A: a manual free model.
  await app.openDialog('model');
  await page.locator('#b-dlg-model .b-mrow').filter({ hasText: MINI_MODEL })
    .getByRole('button', { name: /Synthetic Mini/ }).click();
  await expect(page.locator('#b-st-model')).toHaveText(SHORT_MINI);
  const aId = (await readStored(page)).activeChat;

  // Give A a stable title so it can be found by text later.
  await app.openDialog('chats');
  await rowByTitle(page, '#b-dlg-chats', 'New chat').getByRole('button', { name: 'Rename', exact: true }).click();
  const titleInput = page.locator('#b-dlg-chats input[aria-label="Chat title"]');
  await titleInput.fill('Mini chat');
  await titleInput.press('Enter');
  await app.closeDialog('chats');

  // Chat B: new chat, automatic again.
  await page.click('#b-new');
  await expect(page.locator('#b-st-model')).toHaveText(SHORT_DEFAULT);
  const bId = (await readStored(page)).activeChat;
  expect(bId).not.toBe(aId);

  let stored = await readStored(page);
  expect(stored.chats.find((c) => c.id === aId).model).toEqual({ mode: 'manual', id: MINI_MODEL });
  expect(stored.chats.find((c) => c.id === bId).model).toEqual({ mode: 'auto', id: EXPECTED_DEFAULT_MODEL });

  // Switching back restores A's own choice, in the strip and in storage.
  await app.openDialog('chats');
  await rowByTitle(page, '#b-dlg-chats', 'Mini chat').getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('#b-st-model')).toHaveText(SHORT_MINI);
  await app.openDialog('model');
  await expect(page.locator('#b-dlg-model .b-mrow.is-active')).toContainText(MINI_MODEL);
  await expect(page.locator('#b-dlg-model #b-auto')).toHaveAttribute('aria-pressed', 'false');
  await app.closeDialog('model');

  stored = await readStored(page);
  expect(stored.chats.find((c) => c.id === bId).model).toEqual({ mode: 'auto', id: EXPECTED_DEFAULT_MODEL });
  await expectHermetic(app);
});

test('@library chats: a legacy v1 store migrates to v2 with no key in the backup', async ({ page }) => {
  const consoleLines = captureConsole(page);
  // The v1 keys the app still reads. Seeded before the app module runs; skipped
  // once the marker exists so a reload tests the migration, not the seeding.
  await page.addInitScript((seed) => {
    if (localStorage.getItem('asm.migration.v2')) return;
    localStorage.setItem('asm.sessions', JSON.stringify(seed.sessions));
    localStorage.setItem('asm.activeSession', seed.active);
    localStorage.setItem('asm.activeModel', seed.model);
    localStorage.setItem('asm.settings', JSON.stringify({ key: seed.key, crt: { scan: true, curve: true, flicker: false, sound: false } }));
  }, { sessions: LEGACY_SESSIONS, active: 's-legacy-one', model: LEGACY_MODEL, key: LEGACY_KEY });

  const app = await bootApp(page);
  const stored = await readStored(page);

  // Both sessions became v2 chats, ids, titles and text preserved.
  expect(stored.chats.map((c) => c.id).sort()).toEqual(['s-legacy-one', 's-legacy-two']);
  const first = stored.chats.find((c) => c.id === 's-legacy-one');
  expect(first.title).toBe('LEGACY ONE');
  expect(first.assistantId).toBe('asm-agent');
  expect(first.assistantName).toBe('ASM::AGENT');
  expect(first.instructions).toBe(DEFAULT_PERSONA);
  expect(first.model).toEqual({ mode: 'manual', id: LEGACY_MODEL, provenance: 'legacy' });
  expect(first.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(first.messages[0].content).toBe('Which fixture answered this?');
  expect(first.messages[1].sources).toEqual([{
    title: 'Synthetic Fixture',
    url: 'https://en.wikipedia.org/wiki/Fixture',
    snippet: 'A fixture is local test data.',
  }]);

  const second = stored.chats.find((c) => c.id === 's-legacy-two');
  expect(second.assistantName).toBe('CUSTOM (imported)');
  expect(second.instructions).toBe('You are a pirate.');
  expect(stored.assistants.map((a) => a.name)).toEqual(['CUSTOM (imported)']);
  expect(second.assistantId).toBe(stored.assistants[0].id);
  expect(stored.activeChat).toBe('s-legacy-one');

  // The backup keeps the legacy records, minus the credential.
  expect(stored.backup.sessions).toHaveLength(2);
  expect(stored.backup.activeSession).toBe('s-legacy-one');
  expect(stored.backup.activeModel).toBe(LEGACY_MODEL);
  expect(stored.backup.settings).not.toHaveProperty('key');
  expect(JSON.stringify(stored.backup)).not.toContain(LEGACY_KEY);

  // The key moved to the session store, and no persisted copy keeps it.
  expect(stored.sessionKey).toBe(LEGACY_KEY);
  expect(stored.settings.key).toBe('');
  expect(stored.settings.rememberKey).toBe(false);
  expect(JSON.stringify(stored.raw.local), 'a legacy key must not stay in localStorage').not.toContain(LEGACY_KEY);
  expect(stored.raw.local['asm.sessions'], 'legacy keys are never deleted').toContain('s-legacy-one');
  expect(stored.migration.version).toBe(2);

  // Observed in the UI: the one-time notices, then the restored chat.
  await expect(page.locator('#b-transcript .b-notice-t')).toHaveText([
    'Your API key now lasts only for this browser session. Use Remember on this device in Settings to keep it.',
    'Your default assistant is now ASM::AGENT',
  ]);
  await expect(page.locator('#b-transcript')).toContainText('Which fixture answered this?');
  await expect(page.locator('#b-transcript .b-ans')).toHaveCount(1);
  await expect(page.locator('#b-transcript .b-src > summary')).toHaveText('Sources (1)');
  await expect(page.locator('#b-st-model')).toHaveText(SHORT_MINI);
  await expect(page.locator('#b-st-key')).toHaveText('API key set');

  await expectNoKeyLeak(app, LEGACY_KEY, { consoleLines });
  await expectHermetic(app);
});

test('@library chats: a repeated migration changes nothing', async ({ page }) => {
  await page.addInitScript((seed) => {
    if (localStorage.getItem('asm.migration.v2')) return;
    localStorage.setItem('asm.sessions', JSON.stringify(seed.sessions));
    localStorage.setItem('asm.activeSession', seed.active);
    localStorage.setItem('asm.settings', JSON.stringify({ key: seed.key }));
  }, { sessions: LEGACY_SESSIONS, active: 's-legacy-one', key: LEGACY_KEY });

  const app = await bootApp(page);
  const before = await readStored(page);
  expect(before.chats).toHaveLength(2);
  expect(before.migration.version).toBe(2);

  // Second boot: the marker is present, so the legacy keys are re-read but
  // nothing may be written — no duplicated chats, no rewritten backup.
  await page.reload();
  await app.waitForBoot();
  const after = await readStored(page);

  expect(after.raw.local).toEqual(before.raw.local);
  expect(after.raw.session).toEqual(before.raw.session);
  expect(after.chats).toHaveLength(2);
  expect(after.assistants).toHaveLength(1);
  expect(after.backup).toEqual(before.backup);
  expect(after.activeChat).toBe(before.activeChat);
  expect(JSON.stringify(after.raw.local)).not.toContain(LEGACY_KEY);
  await expect(page.locator('#b-transcript')).toContainText('Which fixture answered this?');
  await expectHermetic(app);
});

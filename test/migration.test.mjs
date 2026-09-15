// migration.test.mjs — v1 -> v2 migration contract for js/store.js.
// Legacy fixtures reproduce the js/sessions.js v1 shapes: numeric history
// roles, PRESETS system prompts, asm.sessions / asm.activeSession /
// asm.activeModel / asm.settings.
// Run: node --test test/migration.test.mjs   (or: node test/migration.test.mjs)
import assert from 'node:assert/strict';

// ── browser shims ───────────────────────────────────────────────────────
class MemoryStorage {
  constructor() { this.map = new Map(); this.failOn = new Set(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.failOn.has(k)) { this.failOn.delete(k); throw new Error('quota'); }
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const fresh = () => {
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = new MemoryStorage();
};
fresh();

const S = await import('../js/store.js');
const { BUILTIN_ID } = S;
S.setBuiltinInstructions('ASM DEFAULT PERSONA');

const ls = () => globalThis.localStorage;
const ss = () => globalThis.sessionStorage;
const values = (store) => {
  const out = [];
  for (let i = 0; i < store.length; i++) out.push(store.getItem(store.key(i)));
  return out;
};

const KEY_NOTICE = 'Your API key now lasts only for this browser session. Use Remember on this device in Settings to keep it.';
const DEFAULT_NOTICE = 'Your default assistant is now ASM::AGENT';

// ── verbatim legacy PRESETS (js/sessions.js at the time of v1) ──────────
const BASIC = `You are a helpful assistant. You have one tool: web_search.

Use web_search when the answer depends on current or factual information that you are not sure about. Otherwise answer directly, with no search.

After a search, answer the question from the results you were given. Do not search again unless you need different information.

If the results do not answer the question, say what you found and what is still missing.

Keep answers short. Link your sources.`;
const RESEARCH = `You are a research analyst. Be concise and evidence-first. For anything time-sensitive or factual, use the web_search tool before answering. Cite sources as markdown links. Prefer markdown tables for comparisons and fenced code blocks for code.`;
const TERSE = `You are a terse senior engineer. Answer in the fewest words that are complete. Code first, prose second. No filler, no warnings, no pleasantries. Use web_search only when the answer depends on current information.`;
const EDITED = `${BASIC}\n\nBe brief.`;

const basicMessages = () => ([
  { role: 0, content: BASIC },
  { role: 1, content: 'What is the capital of France?' },
  { role: 2, content: 'Paris.', tool_call_id: 'call_1', name: 'web_search', args: '{"query":"capital of France"}' },
  {
    role: 3,
    content: '### [WIKIPEDIA] Paris\nhttps://en.wikipedia.org/wiki/Paris\nCapital of France.\n\n'
      + '### [DBPEDIA] Paris\nhttps://dbpedia.org/page/Paris\nParis is the capital.\n\n',
  },
  { role: 4, content: '', tool_call_id: 'call_2', name: 'web_search', args: '{"query":"more"}' },
  { role: 3, content: '### [NASA] Mars\nhttps://science.nasa.gov/mars\nFourth planet.\n\n' },
]);

const SESSIONS = [
  { id: 's-basic', title: 'CAPITAL OF FRANCE', created: 100, preset: 'BASIC AGENT', system: BASIC, messages: basicMessages() },
  { id: 's-terse', title: 'TERSE', created: 200, preset: 'TERSE CODER', system: TERSE, messages: [{ role: 0, content: TERSE }, { role: 1, content: 'hi' }, { role: 2, content: 'yo' }] },
  { id: 's-research', title: 'RESEARCH', created: 300, preset: 'RESEARCH ANALYST', system: RESEARCH, messages: [{ role: 0, content: RESEARCH }, { role: 1, content: 'find' }, { role: 2, content: 'found' }] },
  { id: 's-edited', title: 'EDITED', created: 400, preset: 'BASIC AGENT', system: EDITED, messages: [{ role: 0, content: EDITED }, { role: 1, content: 'q1' }, { role: 2, content: 'a1' }] },
  { id: 's-edited-2', title: 'EDITED AGAIN', created: 500, preset: 'BASIC AGENT', system: EDITED, messages: [{ role: 0, content: EDITED }, { role: 1, content: 'q2' }, { role: 2, content: 'a2' }] },
  { id: 's-custom', title: 'CUSTOM', created: 600, preset: 'CUSTOM', system: 'You are a pirate.', messages: [{ role: 0, content: 'You are a pirate.' }, { role: 1, content: 'arr' }, { role: 2, content: 'ahoy' }] },
];

const legacyStore = ({ sessions, key, crt, active, model }) => {
  localStorage.setItem('asm.sessions', JSON.stringify(sessions));
  if (key !== undefined) localStorage.setItem('asm.settings', JSON.stringify({ key, crt: crt || { scan: true, curve: true, flicker: false, sound: false } }));
  if (active !== undefined) localStorage.setItem('asm.activeSession', active);
  if (model !== undefined) localStorage.setItem('asm.activeModel', model);
};
const seed = () => legacyStore({
  sessions: SESSIONS,
  key: 'sk-legacy-secret',
  crt: { scan: false, curve: true, flicker: true, sound: false },
  active: 's-basic',
  model: 'vendor/model-x:free',
});

// ── full v1 fixture ─────────────────────────────────────────────────────
{
  fresh();
  seed();
  const r = S.migrateIfNeeded();
  assert.equal(r.ran, true, 'migration ran');
  assert.deepEqual(r.errors, [], 'no errors');
  assert.deepEqual(r.notices, [KEY_NOTICE, DEFAULT_NOTICE], 'both notices');
  assert.equal(r.chats, 6, 'six chats created');
  assert.equal(r.assistants, 2, 'two imported assistants');
  assert.equal(r.skippedMalformed, 0, 'nothing malformed');

  assert.deepEqual(S.listChats().map((c) => c.id),
    ['s-custom', 's-edited-2', 's-edited', 's-research', 's-terse', 's-basic'], 'newest created first');

  const basic = S.getChat('s-basic');
  assert.equal(basic.title, 'CAPITAL OF FRANCE', 'title preserved');
  assert.equal(basic.created, 100, 'created preserved');
  assert.equal(basic.assistantId, BUILTIN_ID, 'BASIC AGENT maps to the builtin');
  assert.equal(basic.assistantName, 'ASM::AGENT', 'builtin name baked');
  assert.equal(basic.assistantRev, 1, 'builtin rev baked');
  assert.equal(basic.instructions, 'ASM DEFAULT PERSONA', 'builtin instructions baked');
  assert.deepEqual(basic.model, { mode: 'manual', id: 'vendor/model-x:free', provenance: 'legacy' }, 'legacy model');
  assert.equal(basic.draft, '', 'draft empty');
  assert.deepEqual(basic.messages.map((m) => m.role), ['user', 'assistant'], 'system and tool-call records dropped');
  assert.equal(basic.messages[0].content, 'What is the capital of France?', 'user text verbatim');
  assert.equal(basic.messages[1].content, 'Paris.', 'assistant text verbatim');
  assert.ok(!('tool_call_id' in basic.messages[1]), 'tool-call metadata dropped');
  assert.deepEqual(basic.messages[1].sources, [
    { title: 'Paris', url: 'https://en.wikipedia.org/wiki/Paris', snippet: 'Capital of France.' },
    { title: 'Paris', url: 'https://dbpedia.org/page/Paris', snippet: 'Paris is the capital.' },
    { title: 'Mars', url: 'https://science.nasa.gov/mars', snippet: 'Fourth planet.' },
  ], 'tool results parsed into sources');

  const terse = S.getChat('s-terse');
  assert.equal(terse.assistantId, null, 'retired preset has no library assistant');
  assert.equal(terse.assistantName, 'TERSE CODER', 'retired preset name kept');
  assert.equal(terse.instructions, TERSE, 'retired instructions stay inline');
  assert.equal(S.getChat('s-research').assistantId, null, 'second retired preset has no library assistant');
  assert.equal(S.getChat('s-research').assistantName, 'RESEARCH ANALYST', 'second retired preset named');

  const edited = S.getChat('s-edited');
  assert.ok(edited.assistantId, 'edited prompt gets a custom assistant');
  assert.equal(edited.assistantId, S.getChat('s-edited-2').assistantId, 'identical text deduped to one record');
  const imported = S.getAssistant(edited.assistantId);
  assert.equal(imported.name, 'BASIC AGENT (imported)', 'imported name keeps the preset name');
  assert.equal(imported.instructions, EDITED, 'imported instructions verbatim');
  assert.equal(S.getChat('s-custom').assistantName, 'CUSTOM (imported)', 'unknown preset imported by name');
  assert.equal(S.listAssistants().length, 3, 'builtin plus two imports');
  assert.ok(!S.listAssistants().some((a) => a.name === 'TERSE CODER' || a.name === 'RESEARCH ANALYST'),
    'retired presets never resurrect as selectable assistants');

  assert.equal(ss().getItem('asm.openrouter.key'), 'sk-legacy-secret', 'key moved to sessionStorage');
  assert.equal(S.getKey(), 'sk-legacy-secret', 'getKey returns the session key');
  const settings = S.getSettings();
  assert.equal(settings.key, '', 'persistent key removed');
  assert.equal(settings.rememberKey, false, 'rememberKey off');
  assert.deepEqual(settings.crt, { scan: false, curve: true, flicker: true, sound: false }, 'crt prefs preserved');
  for (const v of values(ls())) assert.ok(!String(v).includes('sk-legacy-secret'), 'no stored artifact keeps the secret');

  const backup = JSON.parse(ls().getItem('asm.legacy.backup.v1'));
  assert.equal(backup.sessions.length, 6, 'backup keeps every legacy session');
  assert.equal(backup.activeSession, 's-basic', 'backup active session');
  assert.equal(backup.activeModel, 'vendor/model-x:free', 'backup active model');
  assert.ok(!('key' in backup.settings), 'backup settings has no key field');
  assert.ok(!JSON.stringify(backup).includes('sk-legacy-secret'), 'backup carries no secret');
  assert.equal(S.activeChat().id, 's-basic', 'legacy active session becomes the active chat');
  assert.ok(ls().getItem('asm.migration.v2'), 'marker written');

  // second run: complete no-op
  assert.deepEqual(S.migrateIfNeeded(),
    { ran: false, notices: [], chats: 0, assistants: 0, skippedMalformed: 0, errors: [] },
    'second run is a no-op');
  assert.equal(S.listChats().length, 6, 'no duplicate chats');
  assert.equal(S.listAssistants().length, 3, 'no duplicate assistants');
  console.log('ok  : full v1 fixture');
}

// ── interrupted run: marker deleted, re-run must not duplicate ──────────
{
  fresh();
  seed();
  S.migrateIfNeeded();
  ls().removeItem('asm.migration.v2');
  const rerun = S.migrateIfNeeded();
  assert.equal(rerun.chats, 0, 're-run creates no chats');
  assert.equal(rerun.assistants, 0, 're-run creates no assistants');
  assert.deepEqual(rerun.notices, [], 're-run announces nothing again');
  assert.equal(S.listChats().length, 6, 'chats intact');
  assert.equal(S.listAssistants().length, 3, 'assistants intact');
  assert.equal(S.getChat('s-basic').messages.length, 2, 'messages intact');
  assert.ok(ls().getItem('asm.migration.v2'), 'marker restored');
  console.log('ok  : deleted marker -> re-run does not duplicate');
}

// ── interrupted run: the marker write fails mid-migration ───────────────
{
  fresh();
  seed();
  ls().failOn.add('asm.migration.v2');
  const first = S.migrateIfNeeded();
  assert.equal(first.ran, false, 'failed run reports ran false');
  assert.equal(first.errors.length, 1, 'failure reported');
  assert.equal(ls().getItem('asm.migration.v2'), null, 'no marker after the failure');
  assert.equal(S.listChats().length, 6, 'chats landed before the failure');

  const second = S.migrateIfNeeded();
  assert.equal(second.chats, 0, 'retry adds no chats');
  assert.equal(second.assistants, 0, 'retry adds no assistants');
  assert.equal(S.listChats().length, 6, 'no duplicate chats after retry');
  assert.equal(S.listAssistants().length, 3, 'no duplicate assistants after retry');
  assert.ok(ls().getItem('asm.migration.v2'), 'retry completes the migration');
  console.log('ok  : half-written migration retries without duplicates');
}

// ── malformed records are skipped and counted ───────────────────────────
{
  fresh();
  legacyStore({ sessions: [SESSIONS[0], null, { title: 'no id' }, { id: 's-bad', title: 'bad', messages: 'nope' }], model: '' });
  const r = S.migrateIfNeeded();
  assert.equal(r.skippedMalformed, 3, 'three malformed records counted');
  assert.equal(r.chats, 1, 'the valid session still migrates');
  assert.equal(S.listChats().length, 1, 'only the valid chat exists');
  assert.equal(S.getChat('s-bad'), null, 'malformed id was not stored');
  console.log('ok  : malformed records skipped and counted');
}

// ── quota failure: legacy keys intact, no marker ────────────────────────
{
  fresh();
  seed();
  const settingsBefore = ls().getItem('asm.settings');
  const sessionsBefore = ls().getItem('asm.sessions');
  ls().failOn.add('asm.legacy.backup.v1');
  const r = S.migrateIfNeeded();
  assert.equal(r.ran, false, 'quota failure does not migrate');
  assert.equal(r.errors.length, 1, 'quota failure reported');
  assert.equal(ls().getItem('asm.migration.v2'), null, 'no marker after quota failure');
  assert.equal(ls().getItem('asm.settings'), settingsBefore, 'legacy settings untouched');
  assert.equal(ls().getItem('asm.sessions'), sessionsBefore, 'legacy sessions untouched');
  assert.equal(ss().getItem('asm.openrouter.key'), null, 'key not moved');
  assert.equal(S.listChats().length, 0, 'no chats written');
  assert.equal(S.listAssistants().length, 1, 'no assistants written');
  console.log('ok  : quota failure leaves legacy keys intact');
}

// ── existing v2 data is merged, never reset ─────────────────────────────
{
  fresh();
  localStorage.setItem('asm.chats.v2', JSON.stringify([
    { id: 'c-existing', title: 'New chat', created: 900, updated: 900, assistantId: BUILTIN_ID, assistantName: 'ASM::AGENT', instructions: 'x', model: { mode: 'auto', id: '' }, draft: '', messages: [{ role: 'user', content: 'kept' }] },
  ]));
  localStorage.setItem('asm.assistants.v2', JSON.stringify([
    { id: 'a-existing', name: 'Mine', instructions: 'Keep me.', rev: 3 },
  ]));
  seed();
  const r = S.migrateIfNeeded();
  assert.equal(r.chats, 6, 'legacy chats added next to the existing one');
  assert.equal(r.assistants, 2, 'imported assistants added next to the existing one');
  assert.equal(S.listChats().length, 7, 'existing chat preserved');
  assert.equal(S.getChat('c-existing').messages[0].content, 'kept', 'existing messages preserved');
  assert.equal(S.getAssistant('a-existing').rev, 3, 'existing assistant preserved');
  assert.equal(S.listAssistants().length, 4, 'builtin + existing + two imports');
  console.log('ok  : existing v2 data merged');
}

// ── trigger rules ───────────────────────────────────────────────────────
{
  fresh();
  assert.deepEqual(S.migrateIfNeeded(),
    { ran: false, notices: [], chats: 0, assistants: 0, skippedMalformed: 0, errors: [] },
    'nothing legacy, nothing to do');
  assert.equal(ls().getItem('asm.migration.v2'), null, 'no marker on a fresh store');

  fresh();
  localStorage.setItem('asm.settings', JSON.stringify({ key: 'sk-only-key', crt: { scan: false } }));
  const keyed = S.migrateIfNeeded();
  assert.equal(keyed.ran, true, 'a keyed legacy settings store triggers migration');
  assert.equal(keyed.chats, 0, 'no chats to migrate');
  assert.deepEqual(keyed.notices, [KEY_NOTICE], 'key notice only');
  assert.equal(ss().getItem('asm.openrouter.key'), 'sk-only-key', 'key moved');
  assert.equal(S.getSettings().key, '', 'key stripped');

  fresh();
  localStorage.setItem('asm.activeModel', 'vendor/only-model:free');
  const modelOnly = S.migrateIfNeeded();
  assert.equal(modelOnly.ran, true, 'activeModel alone triggers migration');
  assert.deepEqual(modelOnly.notices, [], 'nothing to announce');
  assert.equal(S.getSettings().key, '', 'settings written without a key');
  console.log('ok  : trigger rules');
}

console.log('ALL MIGRATION PASS');

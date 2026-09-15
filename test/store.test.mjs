// store.test.mjs — contract tests for js/store.js (v2 persistence, no network).
// Run: node --test test/store.test.mjs   (or: node test/store.test.mjs)
import assert from 'node:assert/strict';

// ── browser shims: store.js reads localStorage/sessionStorage only ───────
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
// Boot-order tripwire: with the placeholder still installed, a builtin bake
// refuses to run — the guard throws before anything is written.
assert.throws(() => S.createChat({ model: { mode: 'auto', id: 'x/y:free' } }),
  /setBuiltinInstructions/, 'boot order: createChat refuses the placeholder persona');
S.setBuiltinInstructions('BUILTIN PERSONA TEXT');

// Once installed, a builtin snapshot carries the persona, never the placeholder.
{
  fresh();
  const chat = S.createChat({ model: { mode: 'auto', id: 'x/y:free' } });
  assert.equal(chat.instructions, 'BUILTIN PERSONA TEXT', 'boot order: builtin snapshot bakes the installed persona');
}

const values = (store) => {
  const out = [];
  for (let i = 0; i < store.length; i++) out.push(store.getItem(store.key(i)));
  return out;
};
const exportFile = (assistants) => JSON.stringify({
  format: 'asm-agent.assistants', version: 1, exported: '2026-01-01T00:00:00.000Z', assistants,
});

// ── settings ────────────────────────────────────────────────────────────
{
  fresh();
  assert.deepEqual(S.getSettings(),
    { crt: { scan: true, curve: true, flicker: false, sound: false }, rememberKey: false, key: '' },
    'settings defaults');
  const saved = S.saveSettings({ crt: { flicker: true } });
  assert.deepEqual(saved,
    { crt: { scan: true, curve: true, flicker: true, sound: false }, rememberKey: false, key: '' },
    'saveSettings merges crt');
  assert.deepEqual(S.getSettings(), saved, 'settings round-trip');
  assert.equal(S.saveSettings({ crt: { scan: false }, rememberKey: true, key: ' sk-x ' }).key, 'sk-x', 'settings trim the key');
  assert.equal(S.getSettings().crt.flicker, true, 'settings keep earlier crt toggles');
  console.log('ok  : settings');
}

// ── key seam ────────────────────────────────────────────────────────────
{
  fresh();
  assert.equal(S.getKey(), '', 'no key yet');
  assert.equal(S.hasKey(), false, 'hasKey is false without a key');

  S.setSessionKey('sk-session');
  assert.equal(S.getKey(), 'sk-session', 'session key wins');
  assert.equal(S.hasKey(), true, 'hasKey sees the session key');
  for (const v of values(localStorage)) assert.ok(!String(v).includes('sk-session'), 'session key never lands in localStorage');

  S.setRememberedKey('sk-remembered');
  assert.equal(S.getSettings().rememberKey, true, 'setRememberedKey opts in');
  assert.equal(S.getKey(), 'sk-session', 'session still takes precedence');

  S.clearKeys({ session: true, remembered: false });
  assert.equal(S.getKey(), 'sk-remembered', 'remembered key survives a session clear');
  S.clearKeys({ session: false, remembered: true });
  assert.equal(S.getKey(), '', 'clearKeys removes the remembered copy');
  assert.equal(S.getSettings().key, '', 'remembered key cleared from settings');
  assert.equal(S.getSettings().rememberKey, false, 'rememberKey off after clear');

  // opt-in: a persistent key without rememberKey is never used
  fresh();
  localStorage.setItem('asm.settings', JSON.stringify({ key: 'sk-persisted' }));
  assert.equal(S.getKey(), '', 'persistent key needs rememberKey');
  S.saveSettings({ rememberKey: true });
  assert.equal(S.getKey(), 'sk-persisted', 'remembered key used after opt-in');
  console.log('ok  : key seam');
}

// ── assistant CRUD ──────────────────────────────────────────────────────
{
  fresh();
  assert.equal(S.listAssistants().length, 1, 'only the builtin at first');
  assert.equal(S.listAssistants()[0].id, BUILTIN_ID, 'builtin leads the list');
  assert.equal(S.getAssistant(BUILTIN_ID).instructions, 'BUILTIN PERSONA TEXT', 'builtin instructions come from boot');
  assert.equal(S.getAssistant('nope'), null, 'unknown assistant is null');

  assert.throws(() => S.saveAssistant({ name: '', instructions: 'x' }), /name/i, 'empty name throws');
  assert.throws(() => S.saveAssistant({ name: 'X', instructions: '   ' }), /instructions/i, 'empty instructions throw');
  assert.throws(() => S.saveAssistant({ id: BUILTIN_ID, name: 'X', instructions: 'y' }), /built-in/i, 'builtin protected from save');
  assert.throws(() => S.deleteAssistant(BUILTIN_ID), /built-in/i, 'builtin protected from delete');
  assert.throws(() => S.saveAssistant({ id: 'missing', name: 'X', instructions: 'y' }), /not found/i, 'unknown id throws');

  const first = S.saveAssistant({ name: 'Helper', instructions: 'Be helpful.' });
  assert.equal(first.rev, 1, 'new assistant rev 1');
  const updated = S.saveAssistant({ id: first.id, name: 'Helper', instructions: 'Be very helpful.' });
  assert.equal(updated.rev, 2, 'save bumps rev');
  assert.equal(S.getAssistant(first.id).instructions, 'Be very helpful.', 'update stored');

  const copy = S.duplicateAssistant(first.id);
  assert.equal(copy.name, 'Helper (copy)', 'duplicate name');
  assert.notEqual(copy.id, first.id, 'duplicate has its own id');
  assert.equal(S.duplicateAssistant(first.id).name, 'Helper (copy 2)', 'second duplicate is numbered');
  assert.equal(S.duplicateAssistant(BUILTIN_ID).name, 'ASM::AGENT (copy)', 'the builtin can be copied');

  assert.equal(S.deleteAssistant(copy.id), true, 'delete removes');
  assert.equal(S.getAssistant(copy.id), null, 'deleted assistant is gone');
  assert.equal(S.deleteAssistant('nope'), false, 'deleting an unknown id is a no-op');
  console.log('ok  : assistant CRUD');
}

// ── import / export ─────────────────────────────────────────────────────
{
  fresh();
  S.saveAssistant({ name: 'Helper', instructions: 'Be helpful.' });
  S.saveAssistant({ name: 'Coder', instructions: 'Write code.' });
  S.setSessionKey('sk-secret-value');
  const dump = S.exportAssistants();
  const parsed = JSON.parse(dump);
  assert.equal(parsed.format, 'asm-agent.assistants', 'export format');
  assert.equal(parsed.version, 1, 'export version');
  assert.equal(parsed.assistants.length, 2, 'export lists customs only');
  assert.deepEqual(parsed.assistants.map((a) => a.name), ['Helper', 'Coder'], 'export keeps order');
  assert.ok(!('key' in parsed) && !dump.includes('sk-secret-value'), 'export never carries the key');

  // round trip into an empty library
  fresh();
  assert.deepEqual(S.importAssistants(dump), { imported: 2, skipped: 0, errors: [] }, 'round-trip imports both');
  assert.deepEqual(S.listAssistants().map((a) => a.name), ['ASM::AGENT', 'Helper', 'Coder'], 'library after import');

  // the same file again -> skipped, not duplicated
  assert.deepEqual(S.importAssistants(dump), { imported: 0, skipped: 2, errors: [] }, 'identical records skipped');
  assert.equal(S.listAssistants().length, 3, 'no duplicates from a re-import');

  // name conflict with different text -> copy
  const conflict = S.importAssistants(exportFile([{ name: 'Helper', instructions: 'New text.', rev: 9 }]));
  assert.equal(conflict.imported, 1, 'conflict imported as a copy');
  const helperCopy = S.listAssistants().find((a) => a.name === 'Helper (copy)');
  assert.equal(helperCopy.instructions, 'New text.', 'copy keeps the imported text');
  assert.equal(S.listAssistants().find((a) => a.name === 'Helper').instructions, 'Be helpful.', 'existing record untouched');

  // the builtin is never overwritten
  const clash = S.importAssistants(exportFile([{ name: 'ASM::AGENT', instructions: 'EVIL' }]));
  assert.equal(clash.imported, 1, 'builtin clash imported as a copy');
  assert.equal(S.getAssistant(BUILTIN_ID).instructions, 'BUILTIN PERSONA TEXT', 'builtin instructions unchanged');
  assert.ok(S.listAssistants().some((a) => a.name === 'ASM::AGENT (copy)' && a.instructions === 'EVIL'), 'clash lands as a custom copy');

  // invalid payloads report errors, never throw
  const junk = S.importAssistants('{oops');
  assert.deepEqual({ imported: junk.imported, skipped: junk.skipped }, { imported: 0, skipped: 0 });
  assert.equal(junk.errors.length, 1, 'invalid JSON reports an error');
  assert.equal(S.importAssistants(JSON.stringify({ hello: 'world' })).errors.length, 1, 'foreign JSON reports an error');
  const oversized = S.importAssistants('x'.repeat(256 * 1024 + 1));
  assert.deepEqual({ imported: oversized.imported, skipped: oversized.skipped }, { imported: 0, skipped: 0 });
  assert.equal(oversized.errors.length, 1, 'oversized file reports an error');
  const partial = S.importAssistants(exportFile([{ name: '', instructions: 'x' }, { name: 'Fine', instructions: 'y' }]));
  assert.deepEqual({ imported: partial.imported, skipped: partial.skipped }, { imported: 1, skipped: 1 }, 'invalid entry skipped');
  assert.equal(partial.errors.length, 1, 'invalid entry reported');
  console.log('ok  : import / export');
}

// ── chats ───────────────────────────────────────────────────────────────
{
  fresh();
  const builtinChat = S.createChat();
  assert.equal(builtinChat.assistantId, BUILTIN_ID, 'default assistant');
  assert.equal(builtinChat.assistantName, 'ASM::AGENT', 'snapshot name');
  assert.equal(builtinChat.instructions, 'BUILTIN PERSONA TEXT', 'snapshot instructions');
  assert.equal(builtinChat.assistantRev, 1, 'snapshot rev');
  assert.deepEqual(builtinChat.model, { mode: 'auto', id: '' }, 'default model');
  assert.deepEqual(builtinChat.messages, [], 'chat starts empty');
  assert.equal(builtinChat.draft, '', 'draft starts empty');
  assert.equal(builtinChat.title, 'New chat', 'default title');

  const persona = S.saveAssistant({ name: 'Terse', instructions: 'Short answers.' });
  const manualChat = S.createChat({ assistantId: persona.id, model: { mode: 'manual', id: 'vendor/model:free' } });
  assert.equal(manualChat.assistantName, 'Terse', 'custom assistant snapshot');
  assert.equal(manualChat.assistantRev, persona.rev, 'snapshot rev matches');
  assert.deepEqual(manualChat.model, { mode: 'manual', id: 'vendor/model:free' }, 'manual model');
  assert.throws(() => S.createChat({ assistantId: 'nope' }), /not found/i, 'unknown assistant throws');

  // newest-updated first is a sort, not a storage order
  fresh();
  localStorage.setItem('asm.chats.v2', JSON.stringify([
    { id: 'older', updated: 10 },
    { id: 'newer', updated: 20 },
    { id: 'middle', updated: 15 },
  ]));
  assert.deepEqual(S.listChats().map((c) => c.id), ['newer', 'middle', 'older'], 'newest first');

  const edited = S.updateChat('middle', { title: 'Middle', draft: 'half typed' });
  assert.equal(edited.title, 'Middle', 'update merges');
  assert.equal(edited.draft, 'half typed', 'update adds fields');
  assert.ok(edited.updated >= 15, 'update bumps updated');
  assert.equal(S.listChats()[0].id, 'middle', 'updated chat moves to the top');
  assert.equal(S.updateChat('nope', { title: 'x' }), null, 'updating an unknown chat returns null');
  assert.equal(S.updateChat('middle', { id: 'stolen', created: 1 }).id, 'middle', 'id is protected');
  assert.equal(S.getChat('middle').created, undefined, 'created is protected');

  S.setActiveChat('middle');
  assert.equal(S.activeChat().id, 'middle', 'active chat');
  assert.equal(S.renameChat('middle', '  Renamed  ').title, 'Renamed', 'rename trims');
  S.renameChat('middle', '   ');
  assert.equal(S.getChat('middle').title, 'New chat', 'rename falls back to the default title');

  assert.equal(S.deleteChat('middle'), true, 'delete removes');
  assert.equal(S.getChat('middle'), null, 'deleted chat is gone');
  assert.equal(S.activeChat(), null, 'deleting the active chat clears it');
  assert.equal(S.deleteChat('nope'), false, 'deleting an unknown id is a no-op');
  S.setActiveChat(null);
  assert.equal(S.activeChat(), null, 'active chat can be cleared');
  console.log('ok  : chats');
}

// ── slice boundaries: store.js is the leaf (no persona/sessions imports) ──
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/store.js', import.meta.url), 'utf8');
  assert.ok(!/\bfrom\s+['"][^'"]*(sessions|persona)\.js/.test(src), 'store.js imports neither sessions.js nor persona.js');
  console.log('ok  : store.js imports are self-contained');
}

console.log('ALL STORE PASS');

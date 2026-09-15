// store.js — v2 persistence for ASM::AGENT: assistants, chats, settings, keys.
//
// This module owns every read and write of the asm.* keys. The UI renders; it
// never touches localStorage or sessionStorage directly.
//
// Built-in instructions arrive at boot: this module does not import
// js/persona.js. BUILTIN.instructions starts as a placeholder; the UI calls
// setBuiltinInstructions(DEFAULT_PERSONA) once at boot, before it creates a
// chat or runs migrateIfNeeded(). Every chat bakes a snapshot of its assistant,
// so a chat created before that call would keep the placeholder.
//
// Key handling: a key lives in sessionStorage for the current browser session,
// or in settings when the user opted in with Remember on this device. It never
// enters chats, assistants, exports, or the migration backup.
//
// Storage keys:
//   asm.chats.v2, asm.activeChat.v2, asm.assistants.v2, asm.settings,
//   asm.migration.v2, asm.legacy.backup.v1, sessionStorage asm.openrouter.key

export const SCHEMA_VERSION = 2;
export const BUILTIN_ID = 'asm-agent';

const K = {
  chats: 'asm.chats.v2',
  activeChat: 'asm.activeChat.v2',
  assistants: 'asm.assistants.v2',
  settings: 'asm.settings',
  migration: 'asm.migration.v2',
  backup: 'asm.legacy.backup.v1',
  sessionKey: 'asm.openrouter.key',
  legacySessions: 'asm.sessions',
  legacyActive: 'asm.activeSession',
  legacyModel: 'asm.activeModel',
};

const DEFAULT_CRT = { scan: true, curve: true, flicker: false, sound: false };
const DEFAULT_TITLE = 'New chat';
const IMPORT_FORMAT = 'asm-agent.assistants';
const IMPORT_LIMIT = 256 * 1024;

const NOTICE_KEY = 'Your API key now lasts only for this browser session. Use Remember on this device in Settings to keep it.';
const NOTICE_DEFAULT_ASSISTANT = 'Your default assistant is now ASM::AGENT';

const PERSONA_PLACEHOLDER = 'You are a helpful assistant.';
let builtinInstructions = PERSONA_PLACEHOLDER;

/** Boot hook: install the built-in assistant instructions (DEFAULT_PERSONA). */
export function setBuiltinInstructions(text) {
  if (text) builtinInstructions = String(text);
}
/** True until setBuiltinInstructions() installs the real persona at boot. */
const personaUnset = () => builtinInstructions === PERSONA_PLACEHOLDER;

export const BUILTIN = Object.freeze({
  id: BUILTIN_ID,
  name: 'ASM::AGENT',
  builtin: true,
  rev: 1,
  get instructions() { return builtinInstructions; },
});

// ── storage helpers ─────────────────────────────────────────────────────

function readRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeRaw(key, value) { localStorage.setItem(key, value); }
function removeRaw(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
function writeJSON(key, value) { writeRaw(key, JSON.stringify(value)); }
function writeIfChanged(key, value) {
  const next = JSON.stringify(value);
  if (readRaw(key) !== next) writeRaw(key, next);
}
function readJSON(key, fallback) {
  const raw = readRaw(key);
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
function readRecordList(key) {
  const value = readJSON(key, []);
  return Array.isArray(value)
    ? value.filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id !== '')
    : [];
}
function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function sessionWrite(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}
function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const encoder = new TextEncoder();
function byteLength(text) { return encoder.encode(text).length; }

/** First free name in the "<name> (copy)" / "<name> (copy 2)" series. */
function uniqueName(base, taken) {
  let name = `${base} (copy)`;
  for (let n = 2; taken.has(name); n++) name = `${base} (copy ${n})`;
  return name;
}
function normalizeCrt(crt) {
  const c = crt && typeof crt === 'object' ? crt : {};
  const pick = (key) => (c[key] === undefined ? DEFAULT_CRT[key] : !!c[key]);
  return { scan: pick('scan'), curve: pick('curve'), flicker: pick('flicker'), sound: pick('sound') };
}

// ── assistant library ───────────────────────────────────────────────────

function readAssistants() {
  return readRecordList(K.assistants)
    .filter((a) => a.id !== BUILTIN_ID && typeof a.name === 'string' && a.name !== '' && typeof a.instructions === 'string')
    .map((a) => ({
      id: a.id,
      name: a.name,
      instructions: a.instructions,
      rev: Number.isInteger(a.rev) && a.rev > 0 ? a.rev : 1,
    }));
}
function writeAssistants(list) { writeJSON(K.assistants, list); }

/** [BUILTIN, ...custom assistants]. The builtin never lives in storage. */
export function listAssistants() {
  return [{ ...BUILTIN }, ...readAssistants()];
}
export function getAssistant(id) {
  if (id === BUILTIN_ID) return { ...BUILTIN };
  return readAssistants().find((a) => a.id === id) || null;
}
/** Create (no id) or update (id) a custom assistant. Builtin is protected. */
export function saveAssistant({ id, name, instructions } = {}) {
  const trimmedName = String(name ?? '').trim();
  const trimmedInstructions = String(instructions ?? '').trim();
  if (!trimmedName) throw new Error('Assistant name is required.');
  if (!trimmedInstructions) throw new Error('Assistant instructions are required.');
  const list = readAssistants();
  if (id != null) {
    if (id === BUILTIN_ID) throw new Error('The built-in assistant cannot be changed.');
    const index = list.findIndex((a) => a.id === id);
    if (index < 0) throw new Error('Assistant not found.');
    const record = { ...list[index], name: trimmedName, instructions: trimmedInstructions, rev: list[index].rev + 1 };
    list[index] = record;
    writeAssistants(list);
    return record;
  }
  const record = { id: newId('a'), name: trimmedName, instructions: trimmedInstructions, rev: 1 };
  writeAssistants([...list, record]);
  return record;
}
/** Chats that used this assistant keep their baked snapshot. */
export function deleteAssistant(id) {
  if (id === BUILTIN_ID) throw new Error('The built-in assistant cannot be deleted.');
  const list = readAssistants();
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  writeAssistants(next);
  return true;
}
/** Copy an assistant (builtin included) under a free "<name> (copy)" name. */
export function duplicateAssistant(id) {
  const source = getAssistant(id);
  if (!source) throw new Error('Assistant not found.');
  const list = readAssistants();
  const taken = new Set([BUILTIN.name, ...list.map((a) => a.name)]);
  const record = { id: newId('a'), name: uniqueName(source.name, taken), instructions: source.instructions, rev: 1 };
  writeAssistants([...list, record]);
  return record;
}

// ── assistant import / export ───────────────────────────────────────────

function importPayload(parsed) {
  return parsed && typeof parsed === 'object' && parsed.format === IMPORT_FORMAT && Array.isArray(parsed.assistants);
}

/**
 * Import an exportAssistants() file. Duplicates are skipped; a name that is
 * already taken is imported as a copy. Never touches the builtin record.
 */
export function importAssistants(text) {
  const out = { imported: 0, skipped: 0, errors: [] };
  const raw = typeof text === 'string' ? text : '';
  if (byteLength(raw) > IMPORT_LIMIT) {
    out.errors.push('The file is larger than 256 KB.');
    return out;
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    out.errors.push('The file is not valid JSON.');
    return out;
  }
  if (!importPayload(parsed)) {
    out.errors.push('The file is not an ASM::AGENT assistant export.');
    return out;
  }
  const list = readAssistants();
  const taken = new Set([BUILTIN.name, ...list.map((a) => a.name)]);
  for (const [index, entry] of parsed.assistants.entries()) {
    const name = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
    const instructions = entry && typeof entry.instructions === 'string' ? entry.instructions.trim() : '';
    if (!name || !instructions) {
      out.skipped++;
      out.errors.push(`Record ${index + 1} was skipped: name and instructions are required.`);
      continue;
    }
    const duplicate = (name === BUILTIN.name && instructions === builtinInstructions)
      || list.some((a) => a.name === name && a.instructions === instructions);
    if (duplicate) { out.skipped++; continue; }
    const finalName = taken.has(name) ? uniqueName(name, taken) : name;
    taken.add(finalName);
    list.push({ id: newId('a'), name: finalName, instructions, rev: 1 });
    out.imported++;
  }
  if (out.imported) writeAssistants(list);
  return out;
}
export function exportAssistants() {
  const assistants = readAssistants().map(({ name, instructions, rev }) => ({ name, instructions, rev }));
  return JSON.stringify({
    format: IMPORT_FORMAT,
    version: 1,
    exported: new Date().toISOString(),
    assistants,
  }, null, 2);
}

// ── chats ───────────────────────────────────────────────────────────────

/** Chats, newest update first. */
export function listChats() {
  return readRecordList(K.chats).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}
export function getChat(id) { return readRecordList(K.chats).find((c) => c.id === id) || null; }
export function activeChat() {
  const id = readRaw(K.activeChat);
  return id ? getChat(id) : null;
}
export function setActiveChat(id) {
  if (id == null || id === '') removeRaw(K.activeChat);
  else writeRaw(K.activeChat, String(id));
}

/** New chat with a baked assistant snapshot and a model choice. */
export function createChat({ assistantId = BUILTIN_ID, model } = {}) {
  const assistant = assistantId == null ? null : getAssistant(assistantId);
  if (assistantId != null && !assistant) throw new Error('Assistant not found.');
  if (assistant && assistant.builtin && personaUnset()) {
    throw new Error('Built-in assistant not ready — call setBuiltinInstructions() before createChat().');
  }
  const now = Date.now();
  const chat = {
    id: newId('c'),
    title: DEFAULT_TITLE,
    created: now,
    updated: now,
    assistantId: assistant ? assistant.id : null,
    assistantRev: assistant ? assistant.rev : null,
    assistantName: assistant ? assistant.name : '',
    instructions: assistant ? assistant.instructions : '',
    model: { mode: model && model.mode === 'manual' ? 'manual' : 'auto', id: String((model && model.id) || '') },
    draft: '',
    messages: [],
  };
  const list = readRecordList(K.chats);
  writeJSON(K.chats, [...list, chat]);
  return chat;
}
/** Shallow merge a patch into one chat. id and created never change. */
export function updateChat(id, patch = {}) {
  const list = readRecordList(K.chats);
  const index = list.findIndex((c) => c.id === id);
  if (index < 0) return null;
  const next = { ...list[index], ...patch, id: list[index].id, created: list[index].created, updated: Date.now() };
  list[index] = next;
  writeJSON(K.chats, list);
  return next;
}
export function deleteChat(id) {
  const list = readRecordList(K.chats);
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  writeJSON(K.chats, next);
  if (readRaw(K.activeChat) === id) setActiveChat(null);
  return true;
}
export function renameChat(id, title) {
  return updateChat(id, { title: String(title ?? '').trim().slice(0, 60) || DEFAULT_TITLE });
}

// ── settings ────────────────────────────────────────────────────────────

export function getSettings() {
  const stored = readJSON(K.settings, null);
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    crt: normalizeCrt(s.crt),
    rememberKey: s.rememberKey === true,
    key: typeof s.key === 'string' ? s.key.trim() : '',
  };
}
export function saveSettings(patch = {}) {
  const current = getSettings();
  const next = {
    crt: normalizeCrt({ ...current.crt, ...(patch.crt && typeof patch.crt === 'object' ? patch.crt : {}) }),
    rememberKey: patch.rememberKey === undefined ? current.rememberKey : patch.rememberKey === true,
    key: patch.key === undefined ? current.key : String(patch.key || '').trim(),
  };
  writeJSON(K.settings, next);
  return next;
}

// ── key seam ────────────────────────────────────────────────────────────

/** Session key first, then the remembered key when the user opted in. */
export function getKey() {
  const session = (sessionGet(K.sessionKey) || '').trim();
  if (session) return session;
  const settings = getSettings();
  return settings.rememberKey ? settings.key : '';
}
export function setSessionKey(key) { sessionWrite(K.sessionKey, String(key || '').trim()); }
export function setRememberedKey(key) { saveSettings({ key: String(key || '').trim(), rememberKey: true }); }
export function clearKeys({ session = true, remembered = true } = {}) {
  if (session) sessionWrite(K.sessionKey, '');
  if (remembered) saveSettings({ key: '', rememberKey: false });
}
export function hasKey() { return getKey() !== ''; }

// ── v1 -> v2 migration ──────────────────────────────────────────────────

// Legacy preset templates, verbatim from js/sessions.js PRESETS. BASIC AGENT
// maps to the builtin assistant; the others are retired (kept on their chats
// only, never resurrected as selectable assistants).
const PRESET_BASIC = `You are a helpful assistant. You have one tool: web_search.

Use web_search when the answer depends on current or factual information that you are not sure about. Otherwise answer directly, with no search.

After a search, answer the question from the results you were given. Do not search again unless you need different information.

If the results do not answer the question, say what you found and what is still missing.

Keep answers short. Link your sources.`;
const PRESET_RETIRED = {
  'RESEARCH ANALYST': `You are a research analyst. Be concise and evidence-first. For anything time-sensitive or factual, use the web_search tool before answering. Cite sources as markdown links. Prefer markdown tables for comparisons and fenced code blocks for code.`,
  'ASSEMBLY GURU': `You are a systems programming guru specializing in WebAssembly, WAT, and low-level optimization. Explain memory layouts, opcodes, and trade-offs precisely. Show WAT or WASM code where relevant. Use the web_search tool for version-specific or recent information.`,
  'TERSE CODER': `You are a terse senior engineer. Answer in the fewest words that are complete. Code first, prose second. No filler, no warnings, no pleasantries. Use web_search only when the answer depends on current information.`,
};

function parseLegacySessions(raw, result) {
  if (raw == null) return { list: [], backup: null };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (parsed === undefined || !Array.isArray(parsed)) {
    result.errors.push('Legacy sessions could not be read.');
    return { list: [], backup: raw };
  }
  return { list: parsed, backup: parsed };
}

function legacyInstructions(session) {
  const system = session.messages.find((m) => m && typeof m === 'object' && m.role === 0 && typeof m.content === 'string');
  if (system) return system.content;
  return typeof session.system === 'string' ? session.system : '';
}

/** Parse "### [TAG] Title\nurl\nsnippet" blocks into sources. */
function parseSources(markdown) {
  const out = [];
  for (const block of String(markdown).split(/(?=### \[)/)) {
    const lines = block.split('\n');
    const head = (lines[0] || '').match(/^### \[([^\]]+)\]\s*(.*)$/);
    if (!head) continue;
    const url = (lines[1] || '').trim();
    if (!url) continue;
    out.push({ title: head[2].trim(), url, snippet: lines.slice(2).join('\n').trim() });
  }
  return out;
}

function attachSources(messages, markdown) {
  if (!markdown) return;
  let target = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { target = messages[i]; break; }
  }
  if (!target) return;
  const sources = parseSources(markdown);
  if (!sources.length) return;
  target.sources = target.sources || [];
  const seen = new Set(target.sources.map((s) => s.url));
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    target.sources.push(source);
  }
}

/** Numeric roles -> user/assistant; system and tool-call records are dropped. */
function legacyMessages(list) {
  const out = [];
  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    if (message.role === 1) {
      if (content) out.push({ role: 'user', content });
    } else if (message.role === 2) {
      if (content) out.push({ role: 'assistant', content });
    } else if (message.role === 3) {
      attachSources(out, content);
    }
  }
  return out;
}

/** Custom assistant for an edited or unknown legacy prompt, deduped by text. */
function ensureImportedAssistant(instructions, presetName, assistants, takenNames) {
  if (!instructions.trim()) return null;
  const id = `imp-${hash(instructions)}`;
  const existing = assistants.find((a) => a.id === id) || assistants.find((a) => a.instructions === instructions);
  if (existing) return { record: existing, created: false };
  const base = `${presetName || 'Custom assistant'} (imported)`;
  const name = takenNames.has(base) ? uniqueName(base, takenNames) : base;
  const record = { id, name, instructions, rev: 1 };
  assistants.push(record);
  takenNames.add(name);
  return { record, created: true };
}

function chatFromLegacy(session, assistants, takenNames, legacyModelId) {
  const instructions = legacyInstructions(session);
  const presetName = typeof session.preset === 'string' ? session.preset.trim() : '';
  const now = Date.now();
  const created = typeof session.created === 'number' && Number.isFinite(session.created) ? session.created : now;
  const messages = legacyMessages(session.messages);
  const firstUser = messages.find((m) => m.role === 'user');
  const chat = {
    id: session.id,
    title: typeof session.title === 'string' && session.title ? session.title : (firstUser ? firstUser.content.slice(0, 60) : DEFAULT_TITLE),
    created,
    updated: created,
    assistantId: null,
    assistantRev: null,
    assistantName: '',
    instructions,
    model: { mode: 'manual', id: legacyModelId, provenance: 'legacy' },
    draft: '',
    messages,
  };
  const out = { chat, usesDefaultAssistant: false, assistantCreated: false };

  if (instructions === PRESET_BASIC) {
    if (personaUnset()) {
      throw new Error('Built-in assistant not ready — call setBuiltinInstructions() before migrateIfNeeded().');
    }
    chat.assistantId = BUILTIN_ID;
    chat.assistantRev = BUILTIN.rev;
    chat.assistantName = BUILTIN.name;
    chat.instructions = BUILTIN.instructions;
    out.usesDefaultAssistant = true;
    return out;
  }
  const retiredName = Object.keys(PRESET_RETIRED).find((name) => PRESET_RETIRED[name] === instructions);
  if (retiredName) {
    // Retired built-in preset: inline on this chat, no library record.
    chat.assistantName = retiredName;
    return out;
  }
  const found = ensureImportedAssistant(instructions, presetName, assistants, takenNames);
  if (found) {
    chat.assistantId = found.record.id;
    chat.assistantRev = found.record.rev;
    chat.assistantName = found.record.name;
    chat.instructions = found.record.instructions;
    out.assistantCreated = found.created;
  } else {
    chat.assistantName = presetName || 'Custom assistant';
  }
  return out;
}

function stripKey(settings) {
  const copy = { ...settings };
  delete copy.key;
  return copy;
}

/**
 * One-time v1 -> v2 migration. Triggered by any legacy key while
 * asm.migration.v2 is absent. The whole plan is staged in memory, then written
 * per key: backup first, chats/assistants/settings next, marker last. Any
 * setItem failure leaves the legacy keys untouched and no marker behind, so a
 * later run retries safely. Legacy keys are not deleted; the backup keeps them.
 *
 * Result: ran means the marker was written by this run; chats and assistants
 * count the records this run created (0 on a retry that finds them already
 * migrated); skippedMalformed counts unreadable legacy session records.
 */
export function migrateIfNeeded() {
  const result = { ran: false, notices: [], chats: 0, assistants: 0, skippedMalformed: 0, errors: [] };
  if (readRaw(K.migration) != null) return result;

  const sessionsRaw = readRaw(K.legacySessions);
  const legacySettings = readJSON(K.settings, null);
  const legacyKey = legacySettings && typeof legacySettings.key === 'string' ? legacySettings.key.trim() : '';
  const legacyModelId = (readRaw(K.legacyModel) || '').trim();
  if (sessionsRaw == null && !legacyKey && !legacyModelId) return result;

  const { list: legacySessions, backup: backupSessions } = parseLegacySessions(sessionsRaw, result);
  const assistants = readAssistants();
  const takenNames = new Set([BUILTIN.name, ...assistants.map((a) => a.name)]);
  const existingChats = readRecordList(K.chats);
  const knownChatIds = new Set(existingChats.map((c) => c.id));
  const createdChats = [];
  let createdAssistants = 0;
  const notices = new Set();

  for (const session of legacySessions) {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id || !Array.isArray(session.messages)) {
      result.skippedMalformed++;
      continue;
    }
    if (knownChatIds.has(session.id)) continue;
    const built = chatFromLegacy(session, assistants, takenNames, legacyModelId);
    if (built.usesDefaultAssistant) notices.add(NOTICE_DEFAULT_ASSISTANT);
    if (built.assistantCreated) createdAssistants++;
    createdChats.push(built.chat);
    knownChatIds.add(built.chat.id);
  }

  const settingsAreV2 = legacySettings !== null && typeof legacySettings === 'object' && 'rememberKey' in legacySettings;
  const settingsOut = settingsAreV2 ? { ...getSettings() } : {
    crt: normalizeCrt(legacySettings && legacySettings.crt),
    rememberKey: false,
    key: '',
  };
  const backup = {
    migratedAt: new Date().toISOString(),
    sessions: backupSessions,
    activeSession: readRaw(K.legacyActive) || null,
    settings: legacySettings && typeof legacySettings === 'object' ? stripKey(legacySettings) : null,
    activeModel: readRaw(K.legacyModel) || null,
  };

  try {
    writeIfChanged(K.backup, backup); // safety copy before any change

    if (legacyKey && sessionGet(K.sessionKey) == null) {
      if (sessionWrite(K.sessionKey, legacyKey)) {
        notices.add(NOTICE_KEY);
        settingsOut.key = '';
        settingsOut.rememberKey = false;
      } else {
        // No sessionStorage: keep the key in Settings so it is not lost.
        settingsOut.key = legacyKey;
        settingsOut.rememberKey = true;
        result.errors.push('The API key could not be moved to this browser session, so it stays in Settings.');
      }
    }

    writeIfChanged(K.assistants, assistants);
    if (createdChats.length) writeIfChanged(K.chats, [...existingChats, ...createdChats]);
    writeIfChanged(K.settings, settingsOut);
    const legacyActive = readRaw(K.legacyActive);
    if (legacyActive && readRaw(K.activeChat) == null && knownChatIds.has(legacyActive)) {
      writeRaw(K.activeChat, legacyActive);
    }
    writeIfChanged(K.migration, { version: SCHEMA_VERSION, at: new Date().toISOString() });
  } catch (err) {
    result.errors.push(`Migration could not be saved: ${err && err.message ? err.message : err}`);
    return result;
  }

  result.ran = true;
  result.chats = createdChats.length;
  result.assistants = createdAssistants;
  result.notices = [NOTICE_KEY, NOTICE_DEFAULT_ASSISTANT].filter((notice) => notices.has(notice));
  return result;
}

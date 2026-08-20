// sessions.js — localStorage sessions, exports, system prompt presets.

const K_SESSIONS = 'asm.sessions';
const K_ACTIVE = 'asm.activeSession';
const K_SETTINGS = 'asm.settings';

export const PRESETS = {
  'BASIC AGENT': `You are a helpful assistant. You have one tool: web_search.

Use web_search when the answer depends on current or factual information that you are not sure about. Otherwise answer directly, with no search.

After a search, answer the question from the results you were given. Do not search again unless you need different information.

If the results do not answer the question, say what you found and what is still missing.

Keep answers short. Link your sources.`,
  'RESEARCH ANALYST': `You are a research analyst. Be concise and evidence-first. For anything time-sensitive or factual, use the web_search tool before answering. Cite sources as markdown links. Prefer markdown tables for comparisons and fenced code blocks for code.`,
  'ASSEMBLY GURU': `You are a systems programming guru specializing in WebAssembly, WAT, and low-level optimization. Explain memory layouts, opcodes, and trade-offs precisely. Show WAT or WASM code where relevant. Use the web_search tool for version-specific or recent information.`,
  'TERSE CODER': `You are a terse senior engineer. Answer in the fewest words that are complete. Code first, prose second. No filler, no warnings, no pleasantries. Use web_search only when the answer depends on current information.`,
};

export function loadSessions() {
  try { return JSON.parse(localStorage[K_SESSIONS] || '[]'); } catch { return []; }
}
export function saveSessions(list) { localStorage[K_SESSIONS] = JSON.stringify(list); }

export function activeId() { return localStorage[K_ACTIVE] || null; }
export function setActiveId(id) { localStorage[K_ACTIVE] = id; }

export function getActive(list = loadSessions()) {
  return list.find((s) => s.id === activeId()) || null;
}

export function newSession(preset = 'BASIC AGENT') {
  const s = {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: 'NEW SESSION',
    created: Date.now(),
    preset,
    system: PRESETS[preset],
    messages: [{ role: 0, content: PRESETS[preset] }],
  };
  const list = loadSessions();
  list.unshift(s);
  saveSessions(list);
  setActiveId(s.id);
  return s;
}

export function saveActiveSession(messages) {
  const list = loadSessions();
  const id = activeId();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  if (messages) s.messages = messages;
  const firstUser = s.messages.find((m) => m.role === 1);
  if (firstUser) s.title = firstUser.content.slice(0, 40);
  saveSessions(list);
}

export function deleteSession(id) {
  let list = loadSessions().filter((s) => s.id !== id);
  saveSessions(list);
  if (activeId() === id) {
    setActiveId(list[0]?.id || null);
    return list[0] || null;
  }
  return getActive(list);
}

export function renameSession(id, title) {
  const list = loadSessions();
  const s = list.find((x) => x.id === id);
  if (s) { s.title = title.slice(0, 60) || 'UNTITLED'; saveSessions(list); }
}

export function setSystemPrompt(id, preset, text) {
  const list = loadSessions();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.preset = preset;
  s.system = text;
  s.messages = [{ role: 0, content: text }, ...s.messages.filter((m) => m.role !== 0)];
  saveSessions(list);
}

// ── settings ────────────────────────────────────────────────────────────
export function loadSettings() {
  try { return { key: '', tavily: '', brave: '', jina: '', crt: { scan: true, curve: true, flicker: false, sound: false }, ...JSON.parse(localStorage[K_SETTINGS] || '{}') }; }
  catch { return { key: '', tavily: '', brave: '', jina: '', crt: { scan: true, curve: true, flicker: false, sound: false } }; }
}
export function saveSettings(s) { localStorage[K_SETTINGS] = JSON.stringify(s); }

export function clearAllData() {
  delete localStorage[K_SESSIONS];
  delete localStorage[K_ACTIVE];
  delete localStorage[K_SETTINGS];
  delete localStorage['asm.activeModel'];
}

// ── exports ─────────────────────────────────────────────────────────────

function download(name, mime, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function exportMarkdown(session) {
  const lines = [`# ${session.title}`, '', `*exported ${new Date().toISOString()} — ASM::AGENT*`, ''];
  for (const m of session.messages) {
    if (m.role === 0) lines.push(`> **SYSTEM** — preset ${session.preset}: ${m.content}`, '');
    else if (m.role === 1) lines.push('## USER', '', m.content, '');
    else if (m.role === 2) {
      lines.push('## ASSISTANT', '', m.content || '', '');
      if (m.tool_call_id) lines.push(`*(tool call: ${m.name}(${m.args}))*`, '');
    } else if (m.role === 3) lines.push('<details><summary>tool result</summary>', '', m.content, '', '</details>', '');
  }
  download(`${session.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'session'}.md`, 'text/markdown', lines.join('\n'));
}

export function exportJSON(session) {
  download(`${(session.title || 'session').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`,
    'application/json', JSON.stringify(session, null, 2));
}

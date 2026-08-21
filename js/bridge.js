// bridge.js — WASM instantiate + chat loop + request building.
// All engine I/O flows through linear memory: SSE bytes and tool results are
// staged into the scratch region before exports are called.

import { webSearch } from './search.js';
import { saveActiveSession } from './sessions.js';

/** @type {WebAssembly.Instance} */
let inst = null;
/** engine exports */ let E = null;
let drainedOff = 0;

export async function initEngine() {
  let instance;
  try {
    const res = await fetch('dist/agent.wasm');
    if (!res.ok) throw new Error(`agent.wasm fetch ${res.status}`);
    ({ instance } = await WebAssembly.instantiateStreaming(res));
  } catch {
    const bytes = await (await fetch('dist/agent.wasm')).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes, {}));
  }
  inst = instance;
  E = inst.exports;
  E.init();
  E.history_clear();
  return E;
}

export const eng = () => E;

// ── memory helpers (fresh views every call: growth detaches buffers) ────
export const memBuf = () => E.memory.buffer;
export const u8 = (ptr, len) => new Uint8Array(memBuf(), ptr, len);
export const str = (ptr, len) => new TextDecoder().decode(u8(ptr, len));

export function scratchWrite(bytes) {
  const SCRATCH = E.scratch();
  const chunk = bytes.subarray(0, Math.min(bytes.length, 0x10000));
  new Uint8Array(memBuf(), SCRATCH, chunk.length).set(chunk);
  return { ptr: SCRATCH, len: chunk.length };
}

export function appendHistory(role, content, meta = {}) {
  const enc = new TextEncoder();
  const c = enc.encode(content || '');
  const t = enc.encode(meta.tool_call_id || '');
  const nm = enc.encode(meta.name || '');
  const a = enc.encode(meta.args || '');
  const S = E.scratch();
  new Uint8Array(memBuf(), S, c.length).set(c);
  new Uint8Array(memBuf(), S + 0x4000, t.length).set(t);
  new Uint8Array(memBuf(), S + 0x6000, nm.length).set(nm);
  new Uint8Array(memBuf(), S + 0x8000, a.length).set(a);
  E.history_append(role, S, c.length, S + 0x4000, t.length,
    S + 0x6000, nm.length, S + 0x8000, a.length);
}

export function clearHistory() { E.history_clear(); }

/** Walk wasm history into JS message objects. */
export function historyMessages() {
  const out = [];
  const n = E.history_count();
  const S = E.scratch();
  const tmp = 0xF000;
  for (let i = 0; i < n; i++) {
    E.history_get(i, S + tmp);
    const dv = new DataView(memBuf(), S + tmp, 36);
    const m = {
      role: dv.getInt32(0, true),
      content: str(dv.getInt32(4, true), dv.getInt32(8, true)),
      tool_call_id: str(dv.getInt32(12, true), dv.getInt32(16, true)),
      name: str(dv.getInt32(20, true), dv.getInt32(24, true)),
      args: str(dv.getInt32(28, true), dv.getInt32(32, true)),
    };
    out.push(m);
  }
  return out;
}

/** Build OpenRouter `messages` payload from wasm history. */
export function buildMessages() {
  const hist = historyMessages();
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];
    if (m.role === 2) {
      if (m.tool_call_id) {
        const tool_calls = [{ id: m.tool_call_id, type: 'function', function: { name: m.name, arguments: m.args } }];
        while (i + 1 < hist.length && hist[i + 1].role === 4) {
          const n = hist[++i];
          tool_calls.push({ id: n.tool_call_id, type: 'function', function: { name: n.name, arguments: n.args } });
        }
        out.push({ role: 'assistant', content: m.content || '', tool_calls });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else if (m.role === 3) {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    } else if (m.role === 0) {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 1) {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 4) {
      // stray role-4 without preceding role-2 — skip, should not appear alone
      continue;
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

/** New render bytes since the last drain (empty string when none). */
export function renderDrain() {
  const len = E.render_len();
  if (len < drainedOff) drainedOff = 0; // buffer was reset
  if (len === drainedOff) return '';
  const out = str(E.render_ptr() + drainedOff, len - drainedOff);
  drainedOff = len;
  return out;
}

export function resetRender() { E.render_reset(); drainedOff = 0; }

// ── streaming chat loop ─────────────────────────────────────────────────

let aborter = null;

export function streaming() { return !!aborter; }

export function stop() { if (aborter) aborter.abort(); }

export const isFreeModel = (id) => typeof id === 'string' && id.endsWith(':free');
export const proxyUrl = () => {
  try { const v = localStorage['asm.proxyUrl']; if (v) return v; } catch {}
  return 'https://asm-agent-proxy.nicolas-6d9.workers.dev/api/chat';
};
export const shouldUseProxy = (key, model) => !key && isFreeModel(model);

export const MAX_TOOL_ROUNDS = 5;

/**
 * Ephemeral message injected only when the tool-round budget runs out. It is
 * never appended to wasm history — it scaffolds the final pass and must not
 * reappear on the next turn or in a saved session.
 */
export const BUDGET_NUDGE =
  'Search budget exhausted: the web_search tool is no longer available. '
  + 'Write your final answer now using only the search results already in this '
  + 'conversation. Do not attempt another search. If the results are '
  + 'insufficient, say what you found and what remains unknown.';

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Use for anything time-sensitive or factual.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};

/** Read the pending tool call staged in the control block by the scanner. */
function pendingToolCall() {
  const dv = new DataView(memBuf());
  const name = str(0x6040, dv.getInt32(0x34, true));
  const argsText = str(dv.getInt32(0x28, true), dv.getInt32(0x2C, true));
  let query = '';
  try { query = JSON.parse(argsText).query ?? ''; } catch {}
  return { name, query };
}

/**
 * One streamed completion into wasm history. `messages` is passed explicitly
 * so the final pass can append BUDGET_NUDGE without touching stored history.
 * Returns 'ok' | 'error' | 'abort' — the caller has already been notified via
 * cb for the two failure outcomes.
 */
async function runRound(messages, withTools, opts, cb) {
  const { key, model, useProxy } = opts;
  resetRender();
  E.begin_turn();

  const payload = { model, messages, stream: true };
  if (withTools) payload.tools = [WEB_SEARCH_TOOL];
  const body = JSON.stringify(payload);

  const headers = {
    'Content-Type': 'application/json',
    'HTTP-Referer': location.origin,
    'X-Title': 'ASM::AGENT',
  };
  if (!useProxy) headers.Authorization = `Bearer ${key}`;
  const url = useProxy ? proxyUrl() : 'https://openrouter.ai/api/v1/chat/completions';

  aborter = new AbortController();
  let res;
  try {
    res = await fetch(url, { method: 'POST', signal: aborter.signal, headers, body });
  } catch (err) {
    aborter = null; E.end_turn();
    if (err.name === 'AbortError') { cb.onAborted?.(); return 'abort'; }
    cb.onError?.(String(err)); return 'error';
  }

  if (!res.ok) {
    aborter = null;
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
    if (res.status === 429 && useProxy) msg += ' — Free tier busy — try again in a minute or add your own key in SET to bypass.';
    E.end_turn();
    cb.onError?.(msg); return 'error';
  }

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.length) {
        const piece = value.subarray(off, off + 60 * 1024);
        const { ptr, len } = scratchWrite(piece);
        E.sse_feed(ptr, len);
        off += piece.length;
      }
      const delta = renderDrain();
      if (delta) cb.onDelta?.(delta);
      const state = new DataView(memBuf(), 4, 4).getInt32(0, true);
      if (state === 3) {
        const msg = str(E.err_ptr(), E.err_len()) || 'STREAM ERROR';
        aborter = null; E.end_turn();
        cb.onError?.(msg); return 'error';
      }
      if (state === 2) break; // [DONE]
    }
  } catch (err) {
    aborter = null; E.end_turn();
    if (err.name === 'AbortError') { cb.onAborted?.(); return 'abort'; }
    cb.onError?.(String(err)); return 'error';
  }

  aborter = null;
  E.end_turn(); // finalize assistant entry (tool meta survives)
  return 'ok';
}

/** Content of the newest history entry — what the round actually produced. */
const lastContent = () => historyMessages().at(-1)?.content || '';

/**
 * send(text) — append user msg, stream the reply, run web_search tool rounds
 * (max MAX_TOOL_ROUNDS). When the budget runs out the turn does NOT end
 * silently: a final tools-disabled pass, nudged by BUDGET_NUDGE, forces an
 * answer from the results already gathered. Callbacks: onDelta(str),
 * onRoundStart(), onRoundFinal(text), onToolStart(name, argsObj),
 * onToolDone(name, result), onDone(), onError(message).
 *
 * opts.search — optional per-turn adapter replacing the Source Fan-out:
 *   async search(query) -> { markdown, sources, failures, perSource }, the
 *   exact record the loop forwards to onToolDone. Adapters never reject;
 *   failures ride the failures field, as in the Fan-out. Omitted, today's
 *   production behavior is byte-identical: the keyless Fan-out (webSearch)
 *   runs.
 */
export async function send(text, cb, opts) {
  const { key, model, search } = opts;
  const doSearch = search || webSearch;
  const useProxy = shouldUseProxy(key, model);
  const ropts = { key, model, useProxy };
  appendHistory(1, text);
  saveActiveSession(historyMessages());
  if (!key && !useProxy) {
    // paid model without key — blocked before network (Q9 A + Q11 A helper)
    cb.onError?.('This model needs your own key — open SET and add sk-or-… Anonymous users can use any :free model.');
    cb.onDone?.();
    return;
  }

  let exhausted = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    cb.onRoundStart?.(round);
    const status = await runRound(buildMessages(), true, ropts, cb);
    if (status !== 'ok') { cb.onDone?.(); return; }

    if (E.tool_pending() !== 1) {
      cb.onRoundFinal?.(lastContent());
      cb.onDone?.();
      saveActiveSession(historyMessages());
      return;
    }

    const count = E.tc_count();
    if (count > 1) {
      const out = E.scratch() + 0xF000;
      const calls = [];
      for (let i = 0; i < count; i++) {
        E.tc_get(i, out);
        const dv = new DataView(memBuf(), out, 24);
        const id = str(dv.getInt32(0, true), dv.getInt32(4, true));
        const name = str(dv.getInt32(8, true), dv.getInt32(12, true));
        const argsText = str(dv.getInt32(16, true), dv.getInt32(20, true));
        let query = '';
        try { query = JSON.parse(argsText).query ?? ''; } catch {}
        calls.push({ id, name, query });
      }
      for (const c of calls) cb.onToolStart?.(c.name, { query: c.query });
      const results = await Promise.all(calls.map((c) => doSearch(c.query || 'webassembly')));
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        const result = results[i];
        appendHistory(3, result.markdown, { tool_call_id: c.id, name: c.name });
        cb.onToolDone?.(c.name, result);
      }
    } else {
      const { name, query } = pendingToolCall();
      cb.onToolStart?.(name, { query });
      const result = await doSearch(query || 'webassembly');

      const rb = new TextEncoder().encode(result.markdown);
      const S = E.scratch();
      new Uint8Array(memBuf(), S, rb.length).set(rb);
      E.tool_result_append(S, rb.length);
      E.tool_result_flush();

      cb.onToolDone?.(name, result);
    }
    if (round === MAX_TOOL_ROUNDS - 1) exhausted = true;
  }

  if (exhausted) {
    // Budget spent on searches — force an answer instead of ending the turn
    // empty. The nudge is ephemeral: history keeps only the reply.
    cb.onRoundStart?.(MAX_TOOL_ROUNDS);
    const msgs = [...buildMessages(), { role: 'user', content: BUDGET_NUDGE }];
    const status = await runRound(msgs, false, ropts, cb);
    if (status !== 'ok') { cb.onDone?.(); return; }
    const final = lastContent();
    cb.onRoundFinal?.(final.trim()
      ? final
      : `Search budget (${MAX_TOOL_ROUNDS} rounds) spent without a usable answer. Try a narrower question, or add a Tavily/Brave/Jina key in SET for better search results.`);
  }

  saveActiveSession(historyMessages());
  cb.onDone?.();
}

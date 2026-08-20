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
  return historyMessages().map((m) => {
    if (m.role === 2 && m.tool_call_id) {
      return {
        role: 'assistant', content: m.content || '',
        tool_calls: [{ id: m.tool_call_id, type: 'function',
          function: { name: m.name, arguments: m.args } }],
      };
    }
    if (m.role === 3) return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    return { role: m.role === 0 ? 'system' : 'user', content: m.content };
  });
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

/**
 * send(text) — append user msg, stream the reply, run web_search tool rounds
 * (max 5). Callbacks: onDelta(str), onRoundStart(), onRoundFinal(text),
 * onToolStart(name, argsObj) -> card, onToolDone(name, result),
 * onDone(), onError(message).
 */
export async function send(text, cb, opts) {
  const { key, model } = opts;
  const useProxy = shouldUseProxy(key, model);
  appendHistory(1, text);
  saveActiveSession(historyMessages());
  if (!key && !useProxy) {
    // paid model without key — blocked before network (Q9 A + Q11 A helper)
    cb.onError?.('This model needs your own key — open SET and add sk-or-… Anonymous users can use any :free model.');
    cb.onDone?.();
    return;
  }
  for (let round = 0; round < 5; round++) {
    resetRender();
    E.begin_turn();
    cb.onRoundStart?.(round);

    const body = JSON.stringify({
      model,
      messages: buildMessages(),
      stream: true,
      tools: [{
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web for current information. Use for anything time-sensitive or factual.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      }],
    });

    aborter = new AbortController();
    let res;
    try {
      if (useProxy) {
        res = await fetch(proxyUrl(), {
          method: 'POST',
          signal: aborter.signal,
          headers: {
            'Content-Type': 'application/json',
            'HTTP-Referer': location.origin,
            'X-Title': 'ASM::AGENT',
          },
          body,
        });
      } else {
        res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          signal: aborter.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': location.origin,
            'X-Title': 'ASM::AGENT',
          },
          body,
        });
      }
    } catch (err) {
      aborter = null;
      if (err.name === 'AbortError') { E.end_turn(); cb.onAborted?.(); cb.onDone?.(); return; }
      cb.onError?.(String(err)); cb.onDone?.(); return;
    }

    if (!res.ok) {
      aborter = null;
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
      if (res.status === 429 && useProxy) msg += ' — Free tier busy — try again in a minute or add your own key in SET to bypass.';
      E.end_turn();
      cb.onError?.(msg); cb.onDone?.(); return;
    }

    // stream SSE bytes through the wasm scanner
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
          cb.onError?.(msg); cb.onDone?.(); return;
        }
        if (state === 2) break; // [DONE]
      }
    } catch (err) {
      aborter = null;
      if (err.name === 'AbortError') { E.end_turn(); cb.onAborted?.(); cb.onDone?.(); return; }
      cb.onError?.(String(err)); cb.onDone?.(); return;
    }
    aborter = null;

    E.end_turn(); // finalize assistant entry (tool meta survives)

    if (E.tool_pending() === 1) {
      const tcid = str(0x6000, new DataView(memBuf(), 0x30, 4).getInt32(0, true));
      const nameLen = new DataView(memBuf(), 0x34, 4).getInt32(0, true);
      const name = str(0x6040, nameLen);
      const argsLen = new DataView(memBuf(), 0x2C, 4).getInt32(0, true);
      const argsText = str(new DataView(memBuf(), 0x28, 4).getInt32(0, true), argsLen);

      let query = '';
      try { query = JSON.parse(argsText).query ?? ''; } catch {}
      cb.onToolStart?.(name, { query });

      const result = await webSearch(query || 'webassembly');

      // append into wasm history as role 3 with the pending tcid
      const enc = new TextEncoder();
      const rb = enc.encode(result.markdown);
      const S = E.scratch();
      new Uint8Array(memBuf(), S, rb.length).set(rb);
      E.tool_result_append(S, rb.length);
      E.tool_result_flush();

      cb.onToolDone?.(name, result);
      continue; // next round with tool results in history
    }

    // plain finish — full re-render from history
    const msgs = historyMessages();
    const last = msgs[msgs.length - 1];
    cb.onRoundFinal?.(last?.content || '');
    break;
  }
  saveActiveSession(historyMessages());
  cb.onDone?.();
}

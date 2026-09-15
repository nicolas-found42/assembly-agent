// bridge.js — WASM instantiate + Turn loop + request building.
// All engine I/O flows through linear memory: SSE bytes and tool results are
// staged into the scratch region before exports are called.

import { webSearch } from './search.js';
import { hedgeNeeded, HEDGE_PASS_NUDGE, repairToolArgs } from './guard.js';
import { MAX_RESEARCH_ROUNDS, planQuery, minimizeQuery } from './research.js';
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

/** Build the OpenRouter `messages` payload from wasm history. The system
 *  prompt is passed per turn by the caller and never stored in the history. */
export function buildMessages(system = '') {
  const hist = historyMessages();
  const out = [];
  if (system) out.push({ role: 'system', content: system });
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
let inTurn = false;         // true from runTurn() start (research included) to its return
let stopRequested = false;  // set by stop(); every turn clears it on start

/** A Turn is running — research and tool rounds count, not only the stream. */
export function streaming() { return inTurn; }

export function stop() { stopRequested = true; if (aborter) aborter.abort(); }

export const isFreeModel = (id) => typeof id === 'string' && id.endsWith(':free');
export const proxyUrl = () => {
  try { const v = localStorage['asm.proxyUrl']; if (v) return v; } catch {}
  return 'https://asm-agent-proxy.nicolas-6d9.workers.dev/api/chat';
};
export const shouldUseProxy = (key, model) => !key && isFreeModel(model);

/**
 * Single source of the paid-model gate: an Anonymous User may run Free Models
 * through the Proxy only; anything else needs a BYO key. Shared by the UI
 * pre-check and enforced authoritatively at the Turn boundary.
 */
export function checkAccess(model, key) {
  if (!key && !isFreeModel(model)) {
    return {
      ok: false,
      reason: 'This model needs your API key — add one in Settings, or choose a free model.',
    };
  }
  return { ok: true };
}

/**
 * Ephemeral message injected only when the research budget runs out. It is
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
    description: 'Search the web for current information. A web search already ran for this question and its results are in the conversation; call web_search only when those results are not enough. Use a short, focused query.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};

/** Query sent to the Fan-out when nothing usable can be derived from a call. */
const searchQuery = (q) => minimizeQuery(q) || planQuery(q);

/** doSearch(), but a rejecting adapter becomes a failure record instead of a
 *  broken turn: the model is told the search failed and answers without it. */
async function safeSearch(doSearch, query, searchOpts) {
  try {
    const rec = await doSearch(query, searchOpts);
    if (rec && typeof rec === 'object') return rec;
  } catch (err) {
    return { markdown: '', sources: 0, failures: [String(err?.message || err)], perSource: [] };
  }
  return { markdown: '', sources: 0, failures: ['empty search record'], perSource: [] };
}

/** Result blocks behind a search record (perSource hits, else markdown blocks). */
function countHits(rec) {
  if (Array.isArray(rec?.perSource) && rec.perSource.length) {
    return rec.perSource.reduce((n, s) => n + (Number(s?.hits) || 0), 0);
  }
  return ((String(rec?.markdown || '')).match(/^### \[/gm) || []).length;
}

/** The initial lookup enters the conversation as a plain user message. */
const RESEARCH_PREFIX = 'Web search results for "';
function researchMessage(query, rec) {
  const head = `${RESEARCH_PREFIX}${query}":`;
  const markdown = String(rec?.markdown || '').trim();
  if (markdown) return `${head}\n\n${markdown}`;
  const failed = Array.isArray(rec?.failures) && rec.failures.length
    ? ` (${rec.failures.length} source${rec.failures.length === 1 ? '' : 's'} failed)`
    : '';
  return `${head}\n\nThe search returned no usable results${failed}. `
    + 'Answer from what you know, and say clearly which parts you could not check.';
}

/** Read the pending tool call staged in the control block by the scanner. */
function pendingToolCall() {
  const dv = new DataView(memBuf());
  const name = str(0x6040, dv.getInt32(0x34, true));
  const argsText = str(dv.getInt32(0x28, true), dv.getInt32(0x2C, true));
  const repaired = repairToolArgs(argsText);
  const query = repaired ? repaired.query : '';
  return { name, query };
}

/**
 * One streamed completion into wasm history. `messages` is passed explicitly
 * so the final pass can append BUDGET_NUDGE without touching stored history.
 * Returns 'ok' | 'error' | 'abort' — the caller has already been notified via
 * emit() for the two failure outcomes.
 */
async function runRound(messages, withTools, opts, emit) {
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
    if (err.name === 'AbortError') { emit({ type: 'aborted' }); return 'abort'; }
    emit({ type: 'errored', message: String(err) }); return 'error';
  }

  if (!res.ok) {
    aborter = null;
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
    if (res.status === 429 && useProxy) msg += ' — Free tier busy — try again in a minute or add your own key in SET to bypass.';
    E.end_turn();
    emit({ type: 'errored', message: msg }); return 'error';
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
      if (delta) emit({ type: 'delta', text: delta });
      const state = new DataView(memBuf(), 4, 4).getInt32(0, true);
      if (state === 3) {
        const msg = str(E.err_ptr(), E.err_len()) || 'STREAM ERROR';
        aborter = null; E.end_turn();
        emit({ type: 'errored', message: msg }); return 'error';
      }
      if (state === 2) break; // [DONE]
    }
  } catch (err) {
    aborter = null; E.end_turn();
    if (err.name === 'AbortError') { emit({ type: 'aborted' }); return 'abort'; }
    emit({ type: 'errored', message: String(err) }); return 'error';
  }

  aborter = null;
  E.end_turn(); // finalize assistant entry (tool meta survives)
  return 'ok';
}

/** Content of the newest history entry — what the round actually produced. */
const lastContent = () => historyMessages().at(-1)?.content || '';

/**
 * runTurn(text, opts) — one Turn. The turn always starts with one mandated
 * web search (planQuery picks the query, minimizeQuery strips anything
 * private); its results enter the conversation as a plain user message before
 * the first model call. Model rounds then answer from those results and may
 * search again until MAX_RESEARCH_ROUNDS searches are spent — after which a
 * single tools-disabled pass, nudged by BUDGET_NUDGE, forces an answer. A
 * natural final may still trigger the Hedge Pass (guard.js).
 *
 * opts.system — system prompt for this turn; buildMessages() prepends it and
 *   it is never stored in wasm history.
 * opts.getKey() — read before EVERY round. A paid round (useProxy false)
 *   stops the turn when the key is empty or differs from the key the first
 *   paid round used.
 * opts.model / opts.useProxy — chat model, and whether to ride the Proxy.
 * opts.tools — false removes web_search from every model round; the initial
 *   research still runs.
 * opts.retry — true skips appending the user message and its persist point
 *   (Retry after an error); the turn still researches from scratch.
 * opts.correct — string, or (finalText) => instructions, for the single
 *   post-answer wording pass; an empty result skips the pass. It runs with
 *   tools disabled, cannot reopen research, and keeps the original answer on
 *   abort, error, empty output, or a rejected acceptCorrection check.
 * opts.acceptCorrection(original, rewritten) — optional final gate for the
 *   rewrite; returning false keeps the original and drops the rewrite from
 *   the model context.
 * opts.on(event) — tagged records, in order:
 *   { type: 'research-started', query }
 *   { type: 'research-finished', query, markdown, sources, failures, hits }
 *   { type: 'round-started', round }
 *   { type: 'delta', text }
 *   { type: 'tool-started', name, query }
 *   { type: 'tool-finished', name, query, result }
 *   { type: 'round-final', text }
 *   { type: 'aborted' }
 *   { type: 'errored', message }
 *   { type: 'done' }
 * opts.persist() — fires after the user message lands in history (even when
 *   access is denied below; not on retry) and after each settled final answer.
 *   Never past an error/abort.
 * opts.search — optional per-turn adapter replacing the Source Fan-out:
 *   async search(query, { fresh }) -> { markdown, sources, failures, perSource },
 *   the initial lookup carrying { fresh: true }. A rejecting adapter becomes a
 *   failure record (safeSearch), exactly as a failed source does. Omitted, the
 *   production Fan-out (webSearch) runs.
 *
 * TurnSummary: { ok, rounds, text, aborted?, error?, research } — `rounds`
 * counts model rounds; `research` always carries { query, sources, failures }.
 */
/** The Turn body; runTurn() wraps it with the in-flight flag. */
async function runOneTurn(text, opts) {
  const { system = '', getKey, model, on, persist, search, tools, retry = false, correct, acceptCorrection } = opts;
  const withTools = tools !== false;
  const doSearch = search || webSearch;

  let lastError = null;
  let aborted = false;
  const emit = (event) => {
    if (event.type === 'errored') lastError = event.message;
    if (event.type === 'aborted') aborted = true;
    on?.(event);
  };

  const research = { query: '', sources: 0, failures: [] };
  let rounds = 0;          // model rounds started (a round that fails still counts)
  let researchRounds = 0;  // searches spent; the initial lookup counts inside the cap
  let paidKey = null;      // key of the first paid round; a mid-turn change stops the turn

  const readKey = () => ((typeof getKey === 'function' ? getKey() : '') || '');
  const resolveRound = () => {
    const key = readKey();
    const useProxy = opts.useProxy !== undefined ? !!opts.useProxy : shouldUseProxy(key, model);
    if (!useProxy && paidKey !== null && key !== paidKey) {
      return { error: key
        ? 'Your API key changed mid-turn — the request stopped.'
        : 'Your API key was removed — the request stopped.' };
    }
    if (!useProxy && paidKey === null) paidKey = key;
    return { key, model, useProxy };
  };
  /** Round options with the key read fresh; null after emitting the failure. */
  const roundOpts = () => {
    const r = resolveRound();
    if (r.error) emit({ type: 'errored', message: r.error });
    return r.error ? null : r;
  };
  const failed = () => {
    emit({ type: 'done' });
    const summary = { ok: false, rounds, text: '', research };
    if (aborted) summary.aborted = true;
    else summary.error = lastError || 'error';
    return summary;
  };

  /** Rebuild wasm history without the last assistant-only answer entry. */
  const dropTrailingAnswer = () => {
    const msgs = historyMessages();
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 2 && !msgs[i].tool_call_id) { last = i; break; }
    }
    // Only the entry this round just appended may go: when the final entry
    // is not a plain assistant answer (e.g. the failed round appended
    // nothing, or left tool-call metadata), the last assistant-only entry is
    // the standing answer and must stay.
    if (last < 0 || last !== msgs.length - 1) return;
    clearHistory();
    for (let i = 0; i < msgs.length; i++) {
      if (i !== last) appendHistory(msgs[i].role, msgs[i].content, msgs[i]);
    }
  };
  /** Drop the superseded draft directly before the final assistant answer. */
  const dropDraftBeforeFinal = () => {
    const msgs = historyMessages();
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 2 && !msgs[i].tool_call_id) { last = i; break; }
    }
    if (last > 0 && msgs[last - 1].role === 2 && !msgs[last - 1].tool_call_id) {
      clearHistory();
      for (let i = 0; i < msgs.length; i++) {
        if (i !== last - 1) appendHistory(msgs[i].role, msgs[i].content, msgs[i]);
      }
    }
  };

  /** Final answer: emit it, save it, then run the single wording pass. */
  const settle = async (text, { superseded = false, allowCorrect = true } = {}) => {
    if (superseded) dropDraftBeforeFinal();
    emit({ type: 'round-final', text });
    persist?.();
    const instruction = typeof correct === 'function' ? (correct(text) || '') : (correct || '');
    if (allowCorrect && instruction && !stopRequested) {
      // A key that vanished here is not worth an error: the answer stands.
      const ropts = resolveRound();
      if (!ropts.error) {
        emit({ type: 'round-started', round: rounds });
        rounds++;
        // The wording pass is an extra: when it fails, the answer already
        // given stands, so its abort/error stays out of the event stream.
        const quiet = (ev) => { if (ev.type !== 'errored' && ev.type !== 'aborted') emit(ev); };
        const msgs = [...buildMessages(system), { role: 'user', content: instruction }];
        const before = historyMessages().length;
        const status = await runRound(msgs, false, ropts, quiet);
        const grew = historyMessages().length > before;
        const rewritten = status === 'ok' ? lastContent() : '';
        const accepted = rewritten.trim()
          && (!acceptCorrection || acceptCorrection(text, rewritten));
        if (accepted) {
          dropDraftBeforeFinal();
          emit({ type: 'round-final', text: rewritten });
          persist?.();
          emit({ type: 'done' });
          return { ok: true, rounds, text: rewritten, research };
        }
        if (grew) dropTrailingAnswer(); // failed or rejected rewrite never enters context
      }
    }
    emit({ type: 'done' });
    return { ok: true, rounds, text, research };
  };

  /** Budget spent: one tools-disabled pass, nudged by BUDGET_NUDGE (ephemeral). */
  const nudgedFinal = async () => {
    const ropts = roundOpts();
    if (!ropts) return failed();
    emit({ type: 'round-started', round: rounds });
    rounds++;
    const msgs = [...buildMessages(system), { role: 'user', content: BUDGET_NUDGE }];
    const status = await runRound(msgs, false, ropts, emit);
    if (status !== 'ok') return failed();
    const raw = lastContent();
    if (raw.trim()) return settle(raw);
    return settle(
      `Search budget (${MAX_RESEARCH_ROUNDS} rounds) spent without a usable answer. Try a narrower question.`,
      false,
    );
  };

  // ── user message + pre-turn gate ──────────────────────────────────────
  // Prior user messages feed the planner (a "continue" borrows the topic).
  // Search-result messages ride role 1 too; they are not things the user said.
  const priorUsers = historyMessages()
    .filter((m) => m.role === 1 && !m.content.startsWith(RESEARCH_PREFIX))
    .map((m) => m.content);
  if (retry && priorUsers.at(-1) === text) priorUsers.pop(); // retry: the question is already stored
  if (!retry) {
    appendHistory(1, text);
    persist?.();
  }

  const access = checkAccess(model, resolveRound().key);
  if (!access.ok) {
    emit({ type: 'errored', message: access.reason });
    emit({ type: 'done' });
    return { ok: false, rounds: 0, text: '', error: access.reason, research };
  }

  // ── mandatory initial research: round 1 of the research budget ────────
  research.query = planQuery(text, { history: priorUsers });
  emit({ type: 'research-started', query: research.query });
  const rec = await safeSearch(doSearch, research.query, { fresh: true });
  research.sources = Number(rec.sources) || 0;
  research.failures = Array.isArray(rec.failures) ? rec.failures : [];
  emit({
    type: 'research-finished', query: research.query, markdown: rec.markdown || '',
    sources: research.sources, failures: research.failures, hits: countHits(rec),
  });
  if (stopRequested) { emit({ type: 'aborted' }); return failed(); }
  researchRounds = 1;
  let evidence = `${rec.markdown || ''}\n`;
  appendHistory(1, researchMessage(research.query, rec));

  // ── model rounds: grounded on the results already in context ──────────
  for (;;) {
    if (researchRounds >= MAX_RESEARCH_ROUNDS) return await nudgedFinal();
    if (stopRequested) { emit({ type: 'aborted' }); return failed(); }
    const ropts = roundOpts();
    if (!ropts) return failed();
    emit({ type: 'round-started', round: rounds });
    rounds++;
    const status = await runRound(buildMessages(system), withTools, ropts, emit);
    if (status !== 'ok') return failed();

    if (E.tool_pending() !== 1) {
      let finalText = lastContent();
      let superseded = false;
      // once-per-turn Hedge Pass: denial without evidence -> tools-less rewrite via HEDGE_PASS_NUDGE
      if (hedgeNeeded(finalText, evidence)) {
        if (stopRequested) { emit({ type: 'aborted' }); return failed(); }
        const hropts = roundOpts();
        if (!hropts) return failed();
        emit({ type: 'round-started', round: rounds });
        rounds++;
        const msgs = [...buildMessages(system), { role: 'user', content: HEDGE_PASS_NUDGE }];
        const hBefore = historyMessages().length;
        const hStatus = await runRound(msgs, false, hropts, emit);
        if (hStatus !== 'ok') return failed();
        const hedged = lastContent();
        if (hedged.trim()) { finalText = hedged; superseded = true; }
        else if (historyMessages().length > hBefore) {
          dropTrailingAnswer(); // an empty hedge entry must not stand as the answer
        }
      }
      return await settle(finalText, { superseded });
    }

    researchRounds++;
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
        const repaired = repairToolArgs(argsText);
        calls.push({ id, name, query: searchQuery(repaired ? repaired.query : '') });
      }
      for (const c of calls) emit({ type: 'tool-started', name: c.name, query: c.query });
      const results = await Promise.all(calls.map((c) => safeSearch(doSearch, c.query)));
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        appendHistory(3, results[i].markdown, { tool_call_id: c.id, name: c.name });
        evidence += (results[i].markdown || '') + '\n';
        emit({ type: 'tool-finished', name: c.name, query: c.query, result: results[i] });
      }
    } else {
      const { name, query } = pendingToolCall();
      const cleaned = searchQuery(query);
      emit({ type: 'tool-started', name, query: cleaned });
      const result = await safeSearch(doSearch, cleaned);
      evidence += (result.markdown || '') + '\n';

      const rb = new TextEncoder().encode(result.markdown);
      const S = E.scratch();
      new Uint8Array(memBuf(), S, rb.length).set(rb);
      E.tool_result_append(S, rb.length);
      E.tool_result_flush();

      emit({ type: 'tool-finished', name, query: cleaned, result });
    }
  }
}

export async function runTurn(text, opts = {}) {
  inTurn = true;
  stopRequested = false;
  try {
    return await runOneTurn(text, opts);
  } finally {
    inTurn = false;
  }
}

#!/usr/bin/env node
// fixture-server.mjs — synthetic stand-in for the Worker proxy and for every
// external origin the app contacts during a browser test.
//
//   node test/browser/fixture-server.mjs [--port 4320]     (env FIXTURE_PORT)
//
// Why this exists: the app is a browser app that talks to a Cloudflare Worker
// (js/bridge.js proxyUrl()) and to ~28 third-party search Sources
// (js/search.js webSearch()). Tests must never touch the real internet, so this
// server answers both:
//
//   POST /api/chat                  streaming SSE, OpenRouter chunk shape
//   GET  /api/health                200 {ok:true,freeOnly:true}  (worker/api-chat.js)
//   OPTIONS /api/chat               204 + the worker's CORS echo policy
//   *    /api/*                     404 {error:{message:'Not found'}}
//   *    /__upstream/<host>/<path>  synthetic payload for one external origin
//   *    /__fixture/*              test control surface (below)
//
// Control surface (JSON in / JSON out, driven from the test process):
//   GET  /__fixture/health                 readiness + current configuration
//   POST /__fixture/reset                  defaults + clear the request log
//   POST /__fixture/catalog  {models:[…], sort:{latency:[ids],throughput:[ids]}}
//   POST /__fixture/source   {host, status?, body?, contentType?, delayMs?}
//   POST /__fixture/chat     {answer?, mode?:'auto'|'manual', status?, error?}
//   POST /__fixture/chat/release {count?}  release held SSE frames (manual mode)
//   GET  /__fixture/requests {requests:[…], misses:[…]}
//
// Chunk release is explicit: in `manual` chat mode no SSE frame is written until
// a release call arrives, so a spec holds a mid-stream turn open instead of
// racing a sleep. Nothing else in this file sleeps.
//
// Contract:
//   * binds 127.0.0.1 only; a taken port is a hard failure (never a silent
//     fall-through to another process's server);
//   * never contacts the internet — every upstream origin is answered locally;
//   * prints exactly `READY http://127.0.0.1:<port>/__fixture/health`.

import { createServer } from 'node:http';
import {
  DEFAULT_ANSWER, DEFAULT_CATALOG, DEFAULT_RANK, JSON_CT, UPSTREAM,
} from './fixtures/upstream.mjs';

const HOST = '127.0.0.1';

// ── the Worker contract this emulates (worker/api-chat.js, read-only there) ──
// Copied on purpose: worker/** belongs to another slice, and importing it would
// drag in its real upstream fetch.
function corsHeaders(origin) {
  const allow = origin && (
    origin.endsWith('.github.io') ||
    origin.endsWith('.pages.dev') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1')
  ) ? origin : '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,http-referer,x-title',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

// ── state ──────────────────────────────────────────────────────────────────
const state = {
  catalog: DEFAULT_CATALOG,
  rank: DEFAULT_RANK,
  chat: { answer: DEFAULT_ANSWER, mode: 'auto', status: 200, error: 'fixture error' },
  sources: new Map(),   // host -> { status, body, contentType, delayMs }
  requests: [],         // every request this server answered
  misses: [],           // upstream host+path pairs with no fixture
  sessions: [],         // live /api/chat streams (manual-mode release targets)
};

function resetState() {
  state.catalog = DEFAULT_CATALOG;
  state.rank = DEFAULT_RANK;
  state.chat = { answer: DEFAULT_ANSWER, mode: 'auto', status: 200, error: 'fixture error' };
  state.sources.clear();
  state.requests = [];
  state.misses = [];
  for (const s of state.sessions) { try { s.res.end(); } catch { /* already gone */ } }
  state.sessions = [];
}

// ── http plumbing ──────────────────────────────────────────────────────────
function sendJson(res, status, value, extra = {}) {
  const body = value === null ? '' : JSON.stringify(value);
  res.writeHead(status, { 'content-type': JSON_CT, 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function parseJson(raw) {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const record = (kind, method, url, host) => {
  state.requests.push({ at: new Date().toISOString(), kind, method, url, host });
};

// ── /api/chat: streaming SSE with explicit frame release ───────────────────
/** OpenRouter chunk shape read by the engine's SSE scanner (the same shape
 *  test/tool-loop.mjs drives the turn loop with): `data: {"choices":[{"delta":…}]}`
 *  frames closed by `data: [DONE]`. */
function chatFrames(answer) {
  const frames = String(answer).split(/(\s+)/).filter((s) => s !== '')
    .map((part) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part } }] })}\n\n`);
  frames.push('data: [DONE]\n\n');
  return frames;
}

function pump(session) {
  if (session.res.writableEnded || session.res.destroyed) return;
  while (session.sent < session.granted && session.sent < session.frames.length) {
    session.res.write(session.frames[session.sent]);
    session.sent += 1;
  }
  if (session.sent >= session.frames.length) session.res.end();
}

async function handleChat(req, res, origin) {
  const cors = corsHeaders(origin);
  const body = parseJson(await readBody(req));
  record('worker', req.method, req.url, HOST);
  if (body === null) return sendJson(res, 400, { error: { message: 'Invalid JSON' } }, cors);

  const conf = state.chat;
  if (conf.status !== 200) {
    return sendJson(res, conf.status, { error: { message: conf.error || `fixture status ${conf.status}` } }, cors);
  }
  if (!String(body?.model || '').endsWith(':free')) {
    return sendJson(res, 403, { error: { message: 'NOT_FREE — Proxy only serves Free Models (:free).' } }, cors);
  }

  res.writeHead(200, {
    ...cors,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const session = {
    frames: chatFrames(conf.answer),
    granted: conf.mode === 'manual' ? 0 : Number.POSITIVE_INFINITY, // auto: no sleeps, everything at once
    sent: 0,
    res,
  };
  state.sessions.push(session);
  req.on('close', () => { session.granted = session.sent; });
  return pump(session);
}

// ── /__upstream/<host>/<path>: one fixture per external origin ─────────────
function openrouterFixture(pathname) {
  if (pathname === '/api/v1/key') return { body: JSON.stringify({ data: { label: 'synthetic fixture key' } }), contentType: JSON_CT };
  if (pathname === '/api/v1/models') return { body: JSON.stringify({ data: state.catalog }), contentType: JSON_CT };
  const order = pathname.includes('latency') ? state.rank.latency : state.rank.throughput;
  const byId = new Map(state.catalog.map((m) => [m.id, m]));
  const sorted = order.map((id) => byId.get(id)).filter(Boolean);
  for (const m of state.catalog) if (!sorted.includes(m)) sorted.push(m);
  return { body: JSON.stringify({ data: sorted }), contentType: JSON_CT };
}

function handleUpstream(req, res, url) {
  const rest = url.pathname.slice('/__upstream/'.length);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const pathname = slash === -1 ? '/' : rest.slice(slash);
  record('upstream', req.method, url.pathname + url.search, host);

  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, null, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
    });
  }

  const override = state.sources.get(host);
  let out = override && {
    status: override.status,
    contentType: override.contentType,
    body: override.body,
  };
  if (!out) {
    const shaped = host === 'openrouter.ai'
      ? openrouterFixture(pathname)
      : (UPSTREAM[host] ? UPSTREAM[host](pathname, url.searchParams) : null);
    if (!shaped) {
      state.misses.push(`${host}${pathname}`);
      return sendJson(res, 404, { error: { message: `UNREGISTERED FIXTURE ${host}${pathname}` } }, {
        'access-control-allow-origin': '*',
      });
    }
    out = { status: shaped.status ?? 200, contentType: shaped.contentType ?? JSON_CT, body: shaped.body };
  }

  const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  const headers = {
    'content-type': out.contentType,
    'content-length': Buffer.byteLength(body),
    // A fetch from the staged site (127.0.0.1:4319) to this server (127.0.0.1:4320)
    // is cross-origin, so every upstream answer carries CORS.
    'access-control-allow-origin': '*',
    'access-control-expose-headers': '*',
  };
  const status = out.status ?? 200;
  const delayMs = override?.delayMs ?? 0;
  if (delayMs > 0) {
    setTimeout(() => { res.writeHead(status, headers); res.end(body); }, delayMs);
    return undefined;
  }
  res.writeHead(status, headers);
  res.end(body);
  return undefined;
}

// ── /__fixture/*: the control surface ─────────────────────────────────────
async function handleControl(req, res, url) {
  const path = url.pathname;
  record('control', req.method, url.pathname, HOST);
  const conf = req.method === 'GET' ? {} : parseJson(await readBody(req));
  if (conf === null) return sendJson(res, 400, { error: { message: 'Invalid JSON' } });

  if (path === '/__fixture/health') {
    return sendJson(res, 200, {
      ok: true,
      chat: { ...state.chat },
      catalog: state.catalog.map((m) => m.id),
      sources: [...state.sources.keys()],
      requests: state.requests.length,
      misses: state.misses.length,
    });
  }
  if (path === '/__fixture/reset') {
    resetState();
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/__fixture/catalog') {
    if (Array.isArray(conf.models)) state.catalog = conf.models;
    if (conf.sort && typeof conf.sort === 'object') state.rank = { ...state.rank, ...conf.sort };
    return sendJson(res, 200, { ok: true, models: state.catalog.length });
  }
  if (path === '/__fixture/source') {
    const host = String(conf.host || '');
    if (!host) return sendJson(res, 400, { error: { message: 'host is required' } });
    state.sources.set(host, {
      status: conf.status ?? 200,
      contentType: conf.contentType ?? JSON_CT,
      body: typeof conf.body === 'string' ? conf.body : (conf.body === undefined ? '' : JSON.stringify(conf.body)),
      delayMs: Number(conf.delayMs) || 0,
    });
    return sendJson(res, 200, { ok: true, host });
  }
  if (path === '/__fixture/chat') {
    if (typeof conf.answer === 'string') state.chat.answer = conf.answer;
    if (conf.mode === 'auto' || conf.mode === 'manual') state.chat.mode = conf.mode;
    if (typeof conf.status === 'number') state.chat.status = conf.status;
    if (typeof conf.error === 'string') state.chat.error = conf.error;
    return sendJson(res, 200, { ok: true, chat: { ...state.chat } });
  }
  if (path === '/__fixture/chat/release') {
    const live = state.sessions.filter((s) => !s.res.writableEnded && !s.res.destroyed);
    if (!live.length) return sendJson(res, 409, { error: { message: 'no pending chat stream' } });
    const count = conf.count === undefined ? Infinity : Math.max(1, Number(conf.count) || 1);
    for (const session of live) {
      session.granted = count === Infinity ? Infinity : session.granted + count;
      pump(session);
    }
    return sendJson(res, 200, { ok: true, streams: live.length, released: count === Infinity ? 'all' : count });
  }
  if (path === '/__fixture/requests') {
    return sendJson(res, 200, { requests: state.requests, misses: state.misses });
  }
  return sendJson(res, 404, { error: { message: 'Not found' } });
}

// ── router ─────────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}/`);
  const origin = req.headers.origin || '';

  if (url.pathname.startsWith('/__upstream/')) return handleUpstream(req, res, url);
  if (url.pathname.startsWith('/__fixture/')) return handleControl(req, res, url);

  if (url.pathname === '/api/chat' || url.pathname === '/api/chat/') {
    if (req.method === 'OPTIONS') return sendJson(res, 204, null, corsHeaders(origin));
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method not allowed' } }, corsHeaders(origin));
    return handleChat(req, res, origin);
  }
  if (url.pathname === '/api/health') {
    record('worker', req.method, url.pathname, HOST);
    return sendJson(res, 200, { ok: true, freeOnly: true }, corsHeaders(origin));
  }
  return sendJson(res, 404, { error: { message: 'Not found' } }, corsHeaders(origin));
});

const portFlag = process.argv.indexOf('--port');
const port = Number(portFlag === -1 ? (process.env.FIXTURE_PORT || 4320) : process.argv[portFlag + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`FIXTURE FAIL: bad --port ${process.argv[portFlag + 1]}`);
  process.exit(2);
}

server.on('error', (err) => {
  console.error(`FIXTURE FAIL: cannot listen on 127.0.0.1:${port} — ${err.code} ${err.message}`);
  process.exit(1);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const s of state.sessions) { try { s.res.end(); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(port, HOST, () => {
  console.log(`READY http://${HOST}:${server.address().port}/__fixture/health`);
});

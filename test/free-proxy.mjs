// free-proxy.mjs — tests for Q1–Q13 seams: isFreeModel, shouldUseProxy, worker handleChat
import assert from 'node:assert/strict';

// Mock globals before any app code loads (bridge -> search.js uses window)
globalThis.window = globalThis;
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => {} } };
globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k,v){ this._s[k]=v; },
};
const store = globalThis.localStorage._s;
Object.defineProperty(globalThis, 'localStorage', {
  value: new Proxy(globalThis.localStorage, {
    get(t, p) { if (p in t) return t[p]; return store[p]; },
    set(t, p, v) { if (p in t) t[p]=v; else store[p]=v; return true; },
  }),
  writable: true, configurable: true,
});
global.localStorage = globalThis.localStorage;
global.window = globalThis.window;

const { isFreeModel: bridgeIsFree, shouldUseProxy, proxyUrl } = await import('../js/bridge.js');
const { isFreeModel: workerIsFree, handleChat } = await import('../worker/api-chat.js');

// ——— isFreeModel ———
assert.equal(bridgeIsFree('nvidia/nemotron-3.5-lightning:free'), true, 'bridge free :free');
assert.equal(bridgeIsFree('openai/gpt-4o'), false, 'bridge not free');
assert.equal(bridgeIsFree(''), false, 'bridge empty false');
assert.equal(workerIsFree('a:free'), true, 'worker free');
assert.equal(workerIsFree('a:freee'), false, 'worker not free suffix');

// ——— shouldUseProxy ———
assert.equal(shouldUseProxy('', 'x:free'), true, 'anon free -> proxy');
assert.equal(shouldUseProxy('', 'x'), false, 'anon paid -> no proxy');
assert.equal(shouldUseProxy('sk-or-123', 'x:free'), false, 'BYO free -> direct');
assert.equal(shouldUseProxy('sk-or-123', 'x'), false, 'BYO paid -> direct');
assert.equal(shouldUseProxy(null, 'x:free'), true, 'null key treated anon');

// ——— proxyUrl default + override ———
delete global.localStorage._s['asm.proxyUrl'];
assert.equal(proxyUrl(), '/api/chat', 'default proxy url');
global.localStorage._s['asm.proxyUrl'] = 'https://proxy.example/api/chat';
assert.equal(proxyUrl(), 'https://proxy.example/api/chat', 'override via localStorage');

// ——— worker handleChat: 403 for non-free ———
{
  const req = new Request('https://example.com/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-4o', messages: [] }),
  });
  const env = { OPENROUTER_KEY: 'sk-or-test' };
  const res = await handleChat(req, env, {});
  assert.equal(res.status, 403, 'non-free -> 403');
  const j = await res.json();
  assert.match(j.error.message, /NOT_FREE/, '403 message');
  assert.equal(res.headers.get('access-control-allow-origin'), '*', 'CORS on 403');
}

// ——— 500 when Operator Key missing ———
{
  const req = new Request('https://example.com/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x:free', messages: [] }),
  });
  const res = await handleChat(req, {}, {});
  assert.equal(res.status, 500, 'missing key -> 500');
}

// ——— success passthrough (mock upstream) ———
{
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions', 'upstream url');
    assert.equal(init.headers.authorization, 'Bearer sk-or-test', 'adds operator key');
    assert.equal(init.headers['http-referer'], 'https://example.com', 'passes referer');
    assert.equal(init.method, 'POST', 'post');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'y:free', 'forward model');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const req = new Request('https://example.com/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.com', 'http-referer': 'https://example.com', 'x-title': 'ASM::AGENT' },
    body: JSON.stringify({ model: 'y:free', messages: [{role:'user',content:'hi'}], stream:true }),
  });
  const res = await handleChat(req, { OPENROUTER_KEY: 'sk-or-test' }, {});
  assert.equal(res.status, 200, 'proxy 200');
  assert.equal(res.headers.get('content-type'), 'text/event-stream', 'sse preserved');
  const txt = await res.text();
  assert.match(txt, /\[DONE\]/, 'stream body preserved');
  global.fetch = origFetch;
}

// ——— CORS preflight ———
{
  const req = new Request('https://example.com/api/chat', { method: 'OPTIONS', headers: { origin: 'https://foo.github.io' } });
  const res = await handleChat(req, {}, {});
  assert.equal(res.status, 204, 'preflight 204');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://foo.github.io', 'echo github.io');
}

// ——— invalid JSON ———
{
  const req = new Request('https://example.com/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  const res = await handleChat(req, { OPENROUTER_KEY: 'sk' }, {});
  assert.equal(res.status, 400, 'bad json 400');
}

console.log('ALL FREE-PROXY PASS');

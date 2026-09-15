// test/worker/chat.test.mjs — worker/api-chat.js under the real Worker runtime (S3 / R09).
//
// These tests execute inside workerd (see vitest.config.mjs), not in Node with a fetch stub. Two entry
// paths are used deliberately:
//   * SELF.fetch(...) — the pool's service binding to the Worker's deployed entry point. Used for
//     routing/preflight/method/free-only cases so those run through the same boundary Cloudflare runs.
//   * worker.fetch(request, env, ctx) — the module's exported default entry point, imported into the
//     test, so per-test env can vary (the missing-key case needs an empty env, and bindings are fixed
//     when the runtime starts).
// Both run in the same isolate; every outbound fetch() either path makes is dispatched to the mock
// upstream Worker (outboundService), so no test can contact OpenRouter.
import { beforeEach, describe, expect, test } from "vitest";
import { SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../worker/api-chat.js";

const CONTROL = "https://mock-upstream.control";
const UPSTREAM = "https://openrouter.ai/api/v1/chat/completions";
const CHAT_URL = "https://asm-agent-proxy.example.workers.dev/api/chat";
const DUMMY_KEY = "sk-or-v1-test-dummy-key-not-real";
const GITHUB_ORIGIN = "https://nicolas-found42.github.io";

const control = (path, init = {}) => fetch(CONTROL + path, { method: "POST", ...init });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

async function setScenario(scenario) {
  const res = await control("/__scenario", { body: JSON.stringify(scenario) });
  expect(res.status, "mock upstream scenario control endpoint").toBe(200);
}

async function upstreamCalls() {
  return (await fetch(`${CONTROL}/__calls`)).json();
}

function chatRequest({ body, headers = {} } = {}) {
  return new Request(CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", origin: GITHUB_ORIGIN, ...headers },
    body: body === undefined ? JSON.stringify({ model: "test/model:free", messages: [{ role: "user", content: "hi" }] }) : body,
  });
}

// Direct entry-point call with an explicit environment.
async function callWorker(request, environment = { OPENROUTER_KEY: DUMMY_KEY }) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  const res = await control("/__reset");
  expect(res.status).toBe(200);
});

describe("entry point routing through the deployed boundary (SELF)", () => {
  test("OPTIONS /api/chat → 204 with CORS preflight headers", async () => {
    const res = await SELF.fetch(
      new Request(CHAT_URL, { method: "OPTIONS", headers: { origin: GITHUB_ORIGIN } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(GITHUB_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST,OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "content-type,authorization,http-referer,x-title",
    );
    expect(res.headers.get("access-control-max-age")).toBe("86400");
    expect(res.headers.get("vary")).toBe("origin");
    expect(await res.text()).toBe("");
  });

  test.each(["GET", "PUT", "DELETE", "PATCH"])("%s /api/chat → 405 JSON error", async (method) => {
    const res = await SELF.fetch(new Request(CHAT_URL, { method, headers: { origin: GITHUB_ORIGIN } }));
    expect(res.status).toBe(405);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe(GITHUB_ORIGIN);
    expect(await res.json()).toEqual({ error: { message: "Method not allowed" } });
  });

  test("GET /api/health → 200 liveness payload", async () => {
    const res = await SELF.fetch("https://asm-agent-proxy.example.workers.dev/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, freeOnly: true });
  });

  test("unknown route → 404 JSON", async () => {
    const res = await SELF.fetch("https://asm-agent-proxy.example.workers.dev/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: "Not found" } });
  });

  test("POST /api/chat/ (trailing slash) reaches the same handler", async () => {
    const res = await SELF.fetch(
      new Request("https://asm-agent-proxy.example.workers.dev/api/chat/", {
        method: "POST",
        headers: { "content-type": "application/json", origin: GITHUB_ORIGIN },
        body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
      }),
    );
    // Free-only rejection, i.e. the request was routed, not 404'd.
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("NOT_FREE");
  });

  test("/api/chat/<anything> is not routed", async () => {
    const res = await SELF.fetch(
      new Request("https://asm-agent-proxy.example.workers.dev/api/chat/v2", {
        method: "POST",
        headers: { "content-type": "application/json", origin: GITHUB_ORIGIN },
        body: JSON.stringify({ model: "test/model:free", messages: [] }),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: "Not found" } });
  });

  test("malformed JSON body → 400 Invalid JSON", async () => {
    const res = await SELF.fetch(chatRequest({ body: "this is not json" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: { message: "Invalid JSON" } });
  });

  test("non-free model → 403 NOT_FREE and the upstream is never called", async () => {
    const res = await SELF.fetch(
      chatRequest({ body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }) }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe(GITHUB_ORIGIN);
    const body = await res.json();
    expect(body.error.message).toContain("NOT_FREE");
    // Proof, from the mock itself, that the rejected request never left the Worker.
    const log = await upstreamCalls();
    console.info(`[not-called evidence] mock upstream call log after 403 NOT_FREE: count=${log.count}`);
    expect(log).toEqual({ count: 0, calls: [] });
  });
});

describe("upstream contract (direct entry point, per-test env)", () => {
  test("missing OPENROUTER_KEY → 500 Operator Key not configured, no upstream call", async () => {
    const res = await callWorker(chatRequest(), {});
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: { message: "Operator Key not configured" } });
    const log = await upstreamCalls();
    console.info(`[not-called evidence] mock upstream call log after missing-key 500: count=${log.count}`);
    expect(log).toEqual({ count: 0, calls: [] });
  });

  test("the OPENROUTER_API_KEY alias is accepted as the Operator Key", async () => {
    await setScenario({ kind: "json", status: 200, body: JSON.stringify({ ok: true }) });

    const res = await callWorker(chatRequest(), { OPENROUTER_API_KEY: DUMMY_KEY });

    expect(res.status).toBe(200);
    const { count, calls } = await upstreamCalls();
    expect(count).toBe(1);
    expect(calls[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`);
  });

  test("free model + operator key → 200 verbatim passthrough of body and headers", async () => {
    const upstreamBody = JSON.stringify({
      id: "gen-mock-1",
      choices: [{ message: { role: "assistant", content: "hello" } }],
    });
    await setScenario({
      kind: "json",
      status: 200,
      body: upstreamBody,
      contentType: "application/json",
      cacheControl: "no-store",
    });

    const res = await callWorker(
      chatRequest({
        body: JSON.stringify({ model: "test/model:free", messages: [{ role: "user", content: "hi" }], stream: false }),
        headers: { "http-referer": GITHUB_ORIGIN, "x-title": "ASM::AGENT TEST" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(GITHUB_ORIGIN);
    expect(await res.text()).toBe(upstreamBody);

    // The request that reached the (mock) upstream: endpoint, method, operator key, passthrough headers,
    // and the client payload forwarded unchanged.
    const { count, calls } = await upstreamCalls();
    expect(count).toBe(1);
    expect(calls[0].url).toBe(UPSTREAM);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`);
    expect(calls[0].headers["http-referer"]).toBe(GITHUB_ORIGIN);
    expect(calls[0].headers["x-title"]).toBe("ASM::AGENT TEST");
    expect(JSON.parse(calls[0].body)).toEqual({
      model: "test/model:free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
  });

  test("only reviewed request fields reach upstream: a billed plugin never rides on the Operator Key", async () => {
    await setScenario({ kind: "json", body: JSON.stringify({ ok: true }) });
    const res = await callWorker(
      chatRequest({
        body: JSON.stringify({
          model: "test/model:free",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          tools: [{ type: "function", function: { name: "web_search" } }],
          // OpenRouter bills request-shaping fields — the `web` plugin costs
          // $4 per 1,000 results — so a field this repository has not reviewed
          // must never reach upstream on the Operator Key.
          plugins: [{ id: "web" }],
          provider: { order: ["SomeThirdParty"], allow_fallbacks: true },
          usage: { include: true },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const { count, calls } = await upstreamCalls();
    expect(count).toBe(1);
    const forwarded = JSON.parse(calls[0].body);
    // The forwarded body is exactly the reviewed field set, with the caller's
    // values for the fields that passed the allowlist.
    expect(Object.keys(forwarded).sort()).toEqual(["messages", "model", "stream", "tools"]);
    expect(forwarded.model).toBe("test/model:free");
    expect(forwarded.tools).toEqual([{ type: "function", function: { name: "web_search" } }]);
  });

  test("upstream 429 → status, content-type, cache-control and body pass through", async () => {
    const upstreamBody = JSON.stringify({ error: { message: "Free tier busy" } });
    await setScenario({
      kind: "json",
      status: 429,
      body: upstreamBody,
      contentType: "application/json",
      cacheControl: "no-store",
      headers: { "retry-after": "30" },
    });

    const res = await callWorker(chatRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(GITHUB_ORIGIN);
    expect(await res.text()).toBe(upstreamBody);
    // Current behaviour (characterised, not asserted): only content-type and cache-control are copied
    // from the upstream response, so retry-after does not reach the browser today.
    console.info(`[429 evidence] upstream retry-after=30 forwarded to client: ${res.headers.get("retry-after")}`);
  });

  test("SSE chunks are forwarded incrementally: the tail arrives only after it is released", async () => {
    const chunk1 = 'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n';
    const chunk2 = 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n';
    await setScenario({ kind: "sse", chunks: [chunk1, chunk2] });

    const t0 = performance.now();
    const ctx = createExecutionContext();
    const res = await withTimeout(
      worker.fetch(chatRequest({ body: JSON.stringify({ model: "test/model:free", messages: [], stream: true }) }), { OPENROUTER_KEY: DUMMY_KEY }, ctx),
      2_000,
      "response headers never arrived: the Worker appears to buffer the upstream body",
    );
    const tHeaders = performance.now();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("access-control-allow-origin")).toBe(GITHUB_ORIGIN);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const first = await withTimeout(reader.read(), 2_000, "first SSE chunk never arrived");
    const tChunk1 = performance.now();
    expect(decoder.decode(first.value)).toBe(chunk1);

    // Second read stays pending while the mock upstream still holds the tail chunk.
    let secondResolved = false;
    const secondRead = reader.read().then((result) => {
      secondResolved = true;
      return result;
    });
    await sleep(150);
    const tailPendingBeforeRelease = !secondResolved;
    expect(
      secondResolved,
      "tail chunk arrived before the mock upstream released it — the stream was buffered or reordered",
    ).toBe(false);

    const tRelease = performance.now();
    expect((await control("/__release")).status).toBe(200);
    const second = await withTimeout(secondRead, 2_000, "released tail chunk never arrived");
    const tChunk2 = performance.now();
    expect(decoder.decode(second.value)).toBe(chunk2);
    expect(second.done).toBe(false);
    expect((await reader.read()).done).toBe(true);
    await waitOnExecutionContext(ctx);

    const at = (t) => `${Math.round(t - t0)}ms`;
    console.info(
      `[sse evidence] headers=${at(tHeaders)} chunk1=${at(tChunk1)} release=${at(tRelease)} chunk2=${at(tChunk2)}; ` +
        `tail pending before release: ${tailPendingBeforeRelease}; headers+chunk1 delivered while upstream stream still open: ${tChunk1 < tRelease}`,
    );
    expect(tHeaders).toBeLessThan(tRelease);
    expect(tChunk1).toBeLessThan(tRelease);
    // The runtime clock here has 1ms resolution (performance.now() is epoch-ms), so equality is allowed;
    // the ordering proof is the pending-read check above, not the timestamps.
    expect(tChunk2).toBeGreaterThanOrEqual(tRelease);

    const { count, calls } = await upstreamCalls();
    expect(count).toBe(1);
    expect(JSON.parse(calls[0].body).stream).toBe(true);
    expect(calls[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`);
  });

  // Not asserted here: interruption of an already-open SSE body. The Worker does propagate it (it pipes
  // upstream.body verbatim, so the client reader rejects with the upstream error), but reading an errored
  // streaming body inside the vitest-pool isolate makes workerd's runtime report an unhandled rejection,
  // which vitest turns into a suite-level error (exit 1) regardless of the test handling the rejection.
  // Re-verified: `res.body.pipeTo(new WritableStream(...))` with a rejection handler still produces two
  // runtime-level "Errors" and exit 1 (that path is deliberately not re-run here).
  // What IS covered: an upstream that ends the body mid-stream without `data: [DONE]` (truncation), and
  // upstream failure *before* headers (the 502 case below).
  test("an upstream that truncates the SSE body is forwarded as a truncated body (no fabricated [DONE])", async () => {
    const head = 'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n';
    await setScenario({ kind: "sse", chunks: [head], closeAfterHead: true });

    const ctx = createExecutionContext();
    const res = await withTimeout(
      worker.fetch(
        chatRequest({ body: JSON.stringify({ model: "test/model:free", messages: [], stream: true }) }),
        { OPENROUTER_KEY: DUMMY_KEY },
        ctx,
      ),
      2_000,
      "headers for the truncated stream never arrived",
    );
    expect(res.status).toBe(200);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const first = await withTimeout(reader.read(), 2_000, "head chunk never arrived");
    expect(decoder.decode(first.value)).toBe(head);
    const end = await withTimeout(reader.read(), 2_000, "truncated body never ended");
    expect(end.done).toBe(true);
    expect(end.value).toBeUndefined();
    await waitOnExecutionContext(ctx);
    // The browser's stream loop (js/bridge.js runRound) treats end-of-body as the end of the round, so
    // an interrupted upstream surfaces there as a short/partial answer, never as invented content.
    const { count } = await upstreamCalls();
    expect(count).toBe(1);
  });

  test("upstream failure before any headers → 502 with upstream-fetch-error body, no key leak", async () => {
    await setScenario({ kind: "throw", message: "simulated connection reset" });

    const res = await callWorker(chatRequest());

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe(GITHUB_ORIGIN);
    const body = await res.json();
    // The 502 body is a stable, sanitised contract: one message for every transport failure, and no
    // provider exception text (it can carry upstream internals) and no credential. The truncated
    // exception stays in the Worker log line (status "upstream_fetch_error") — see
    // docs/adr/0001-proxy-for-free-models.md.
    expect(body).toEqual({ error: { message: "Upstream fetch failed" } });
    expect(JSON.stringify(body)).not.toContain("simulated connection reset");
    expect(JSON.stringify(body)).not.toContain("sk-or-");
  });
});

describe("CORS policy (characterised, see comments)", () => {
  // Observed behaviour of worker/api-chat.js today: the listed origins are echoed back exactly, and any
  // other origin (including a missing Origin header) falls back to the `*` wildcard. That is a fallback,
  // not a strict allowlist; these tests record it rather than changing it.
  const echoed = [
    "https://nicolas-found42.github.io",
    "https://asm-agent.pages.dev",
    "http://localhost:8788",
    "http://127.0.0.1:8080",
  ];

  test.each(echoed)("origin %s is echoed", async (origin) => {
    const res = await SELF.fetch(
      chatRequest({ body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }), headers: { origin } }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("vary")).toBe("origin");
  });

  test("unknown origin falls back to the wildcard", async () => {
    const res = await SELF.fetch(
      chatRequest({ body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }), headers: { origin: "https://evil.example" } }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBe("origin");
  });

  test("missing Origin header also falls back to the wildcard", async () => {
    const res = await SELF.fetch(
      new Request(CHAT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("free-only boundary covers model routing, not just the model id", () => {
  // OpenRouter's `models` array is a failover list: it is tried when the primary model is rate-limited,
  // down, or moderated, and the request is billed to the model that ultimately answered
  // (openrouter.ai/docs/guides/routing/model-fallbacks, read 2026-09-14). Before the fix below, a request
  // with `model: "<free>"` plus a paid `models` entry passed the `:free` suffix check and was forwarded
  // with the Operator Key — the mock records no call for it now.
  const paidFallback = JSON.stringify({
    model: "meta-llama/llama-3.3-70b-instruct:free",
    models: ["meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-4o", "anthropic/claude-sonnet-4.5"],
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  test("a free primary model with a paid fallback list is refused and never reaches upstream", async () => {
    const res = await SELF.fetch(chatRequest({ body: paidFallback }));

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe(GITHUB_ORIGIN);
    expect((await res.json()).error.message).toContain("NOT_FREE");
    const log = await upstreamCalls();
    console.info(`[not-called evidence] paid-fallback request reached upstream: count=${log.count}`);
    expect(log).toEqual({ count: 0, calls: [] });
  });

  test("a paid primary model with a free fallback list is also refused", async () => {
    const res = await SELF.fetch(
      chatRequest({
        body: JSON.stringify({ model: "openai/gpt-4o", models: ["meta-llama/llama-3.3-70b-instruct:free"], messages: [] }),
      }),
    );

    expect(res.status).toBe(403);
    expect((await upstreamCalls()).count).toBe(0);
  });

  test("route: 'fallback' is refused: the model field no longer determines what serves the request", async () => {
    const res = await SELF.fetch(
      chatRequest({
        body: JSON.stringify({ model: "meta-llama/llama-3.3-70b-instruct:free", route: "fallback", messages: [] }),
      }),
    );

    expect(res.status).toBe(403);
    expect((await upstreamCalls()).count).toBe(0);
  });

  test("an all-free fallback list still passes through unchanged", async () => {
    const body = {
      model: "meta-llama/llama-3.3-70b-instruct:free",
      models: ["meta-llama/llama-3.3-70b-instruct:free", "qwen/qwen3-8b:free"],
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    };
    await setScenario({ kind: "json", status: 200, body: JSON.stringify({ ok: true }) });

    const res = await SELF.fetch(chatRequest({ body: JSON.stringify(body) }));

    expect(res.status).toBe(200);
    const { count, calls } = await upstreamCalls();
    expect(count).toBe(1);
    // The client payload is forwarded verbatim (the browser's contract is untouched by the guard).
    expect(JSON.parse(calls[0].body)).toEqual(body);
  });

  test.each([
    ["a non-array models field", { model: "meta-llama/llama-3.3-70b-instruct:free", models: "openai/gpt-4o" }],
    ["an empty-string fallback entry", { model: "meta-llama/llama-3.3-70b-instruct:free", models: [""] }],
    ["a null fallback entry", { model: "meta-llama/llama-3.3-70b-instruct:free", models: [null] }],
  ])("%s is refused", async (_label, body) => {
    const res = await SELF.fetch(chatRequest({ body: JSON.stringify(body) }));

    expect(res.status).toBe(403);
    expect((await upstreamCalls()).count).toBe(0);
  });

  test("an empty fallback list is a no-op and keeps the free path working", async () => {
    await setScenario({ kind: "json", status: 200, body: JSON.stringify({ ok: true }) });

    // `models: []` is the documented no-fallback shape and must not trip the guard.
    const res = await SELF.fetch(
      chatRequest({
        body: JSON.stringify({ model: "meta-llama/llama-3.3-70b-instruct:free", models: [], messages: [] }),
      }),
    );

    expect(res.status).toBe(200);
    expect((await upstreamCalls()).count).toBe(1);
  });
});

// test/worker/mock-upstream.worker.mjs — auxiliary Worker standing in for https://openrouter.ai.
//
// Wired up by vitest.config.mjs (`miniflare.workers` + `outboundService: "mock-upstream"`), so every
// outbound fetch() performed by the Worker under test is dispatched here *inside workerd* instead of
// touching the network. The mock performs no I/O at all: an unrecognised URL gets a loud 500 and is
// recorded, which is what makes the suite hermetic (nothing can escape to the real OpenRouter).
//
// Control plane (called by the test file; these requests travel the same outbound path):
//   POST https://mock-upstream.control/__reset       clear recorded calls + scenario + held stream
//   POST https://mock-upstream.control/__scenario    { kind: "json" | "sse" | "throw", ... }
//                                                    sse: { chunks: [head, ...tail], closeAfterHead? }
//                                                    (closeAfterHead ends the body right after the head
//                                                    chunk: the provider dropped the connection)
//   POST https://mock-upstream.control/__release     resolve the controlled promise holding the tail
//   GET  https://mock-upstream.control/__calls       -> { count, calls: [{ method, url, headers, body }] }
// Control requests are addressed to this hostname; it never resolves, it only routes here through the
// outbound service. (Only `default` may be exported from a Worker entry module.)
const CONTROL_HOST = "mock-upstream.control";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const state = {
  calls: [],
  scenario: { kind: "unconfigured" },
  gate: null, // { resolve } for the held SSE stream, if any
};

function reset() {
  state.calls = [];
  state.scenario = { kind: "unconfigured" };
  state.gate = null;
}

async function handleControl(url, request) {
  switch (url.pathname) {
    case "/__reset":
      reset();
      return json(200, { ok: true });
    case "/__scenario":
      state.scenario = JSON.parse(await request.text());
      return json(200, { ok: true, kind: state.scenario.kind });
    case "/__release":
      if (!state.gate) return json(409, { ok: false, released: false });
      state.gate.resolve();
      return json(200, { ok: true, released: true });
    case "/__calls":
      return json(200, { count: state.calls.length, calls: state.calls });
    default:
      return json(404, { ok: false, error: `unknown control path ${url.pathname}` });
  }
}

function sseResponse(scenario) {
  const encoder = new TextEncoder();
  const [head, ...tail] = scenario.chunks;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(head));
        if (scenario.closeAfterHead) {
          // The provider dropped the connection right after the head chunk: the body ends without
          // the terminal `data: [DONE]` event. Nothing is enqueued afterwards.
          controller.close();
          return;
        }
        // The tail stays in the mock until the test releases it: the "controlled promise".
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        // A held-open response with no pending events is treated as a hung handler by the local
        // runtime, so keep one timer alive while the gate is unresolved (what a real SSE provider
        // does with keep-alives anyway).
        const keepAlive = setInterval(() => {}, 1000);
        gate.then(() => {
          clearInterval(keepAlive);
          for (const chunk of tail) controller.enqueue(encoder.encode(chunk));
          controller.close();
        });
        state.gate = { resolve: () => release() };
      },
    }),
    {
      status: scenario.status ?? 200,
      headers: {
        "content-type": scenario.contentType ?? "text/event-stream",
        "cache-control": scenario.cacheControl ?? "no-cache",
      },
    },
  );
}

async function handleUpstream(request) {
  state.calls.push({
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: await request.text(),
  });

  const scenario = state.scenario;
  switch (scenario.kind) {
    case "json":
      return new Response(
        typeof scenario.body === "string" ? scenario.body : JSON.stringify(scenario.body),
        {
          status: scenario.status ?? 200,
          headers: {
            "content-type": scenario.contentType ?? "application/json",
            ...(scenario.cacheControl ? { "cache-control": scenario.cacheControl } : {}),
            ...(scenario.headers ?? {}),
          },
        },
      );
    case "sse":
      return sseResponse(scenario);
    case "throw":
      // A thrown handler rejects the caller's fetch() — the "upstream unreachable before headers" case.
      throw new Error(scenario.message ?? "mock-upstream: simulated connection failure");
    case "unconfigured":
    default:
      return json(500, {
        error: { message: "MOCK-UPSTREAM: no scenario configured — unexpected outbound call" },
      });
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === CONTROL_HOST) return handleControl(url, request);
    return handleUpstream(request);
  },
};

#!/usr/bin/env node
// live-health.mjs — scheduled/manual health checks for the deployed site and Worker (R09 §12.3–12.4).
//
// Two clearly separated modes:
//   * health (default) — non-generating: deployed base path, critical assets + MIME behaviour, JS boot and
//     WASM artefact identity, model-catalog shape, Worker liveness, and the Worker's free-only boundary.
//     Bounded retries are used for these transient checks; nothing is generated and no quota is spent.
//   * generation probe — off unless explicitly enabled (--generate / --mode generate|both /
//     LIVE_HEALTH_ENABLE_GENERATION=1). At most ONE real generation request per run, through the Worker,
//     with a catalog-verified free model, a small output-token cap, no automatic retry, and no paid
//     fallback: budget exhaustion is a reported outcome, never permission to exceed the limit. A single
//     upstream probe is upstream verification — it is not proof that a multi-round browser chat works.
//
// Only sanitised data is written (status, latency, version, diagnostic codes). Requests, model responses,
// browser storage and authorization headers are never persisted.
//
// Usage:
//   node scripts/live-health.mjs [--mode health|generate|both] [--generate] [--base-url URL]
//                                [--worker-url URL] [--expect-commit SHA] [--model ID] [--json PATH]
// Exit codes: 0 pass · 2 usage · 10 deployment/artifact · 11 application · 12 catalog/provider
//             13 worker configuration · 14 infrastructure · 15 budget

import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_URL = 'https://nicolas-found42.github.io/assembly-agent/';
const DEFAULT_WORKER_URL = 'https://asm-agent-proxy.nicolas-6d9.workers.dev';
const DEFAULT_CATALOG_URL = 'https://openrouter.ai/api/v1/models';

/** Exit code per failure category (see the header). */
export const EXIT = { ok: 0, usage: 2, deployment: 10, application: 11, catalog: 12, workerConfig: 13, infrastructure: 14, budget: 15 };
/** Reported classification, highest priority first: the first failing category decides the exit code. */
const PRIORITY = ['deployment', 'workerConfig', 'catalog', 'application', 'infrastructure', 'budget'];

/** Centrally configured generation budget, and the ceilings a caller may not raise it past. */
export const LIMITS = { requests: 1, tokens: 32, durationMs: 30_000, concurrency: 1 };
const HARD_LIMITS = { requests: 1, tokens: 128, durationMs: 60_000, concurrency: 1 };

/** Synthetic prompt: fixed text, no user data, no identifiers. */
const PROBE_PROMPT = 'Health probe. Reply with the single word: ok';

const SITE_ASSETS = [
  { id: 'site.entry', path: 'js/main.js', category: 'application', mime: /^(application|text)\/javascript/ },
  { id: 'site.wasm-loader', path: 'js/bridge.js', category: 'application', mime: /^(application|text)\/javascript/, mustContain: 'dist/agent.wasm' },
  { id: 'site.wasm', path: 'dist/agent.wasm', category: 'deployment', mime: /^application\/wasm/ },
  { id: 'site.vendor.marked', path: 'vendor/marked.min.js', category: 'deployment', mime: /^(application|text)\/javascript/ },
  { id: 'site.vendor.purify', path: 'vendor/purify.min.js', category: 'deployment', mime: /^(application|text)\/javascript/ },
  { id: 'site.vendor.highlight', path: 'vendor/highlight.min.js', category: 'deployment', mime: /^(application|text)\/javascript/ },
  { id: 'site.font', path: 'assets/fonts/vt323-latin-400.woff2', category: 'deployment', mime: /^font\/woff2$/ },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = {
    mode: 'health',
    baseUrl: process.env.LIVE_HEALTH_BASE_URL || DEFAULT_BASE_URL,
    workerUrl: process.env.LIVE_HEALTH_WORKER_URL || DEFAULT_WORKER_URL,
    catalogUrl: DEFAULT_CATALOG_URL,
    expectCommit: process.env.GITHUB_SHA || '',
    model: '',
    json: resolve('artifacts/results/live-health.json'),
    generate: ['1', 'true'].includes(String(process.env.LIVE_HEALTH_ENABLE_GENERATION ?? '').toLowerCase()),
    overrides: {},
  };
  const take = (i) => {
    if (i + 1 >= argv.length) throw new Error(`missing value for ${argv[i]}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') { args.mode = take(i); i += 1; }
    else if (arg === '--generate') args.generate = true;
    else if (arg === '--base-url') { args.baseUrl = take(i); i += 1; }
    else if (arg === '--worker-url') { args.workerUrl = take(i); i += 1; }
    else if (arg === '--expect-commit') { args.expectCommit = take(i); i += 1; }
    else if (arg === '--model') { args.model = take(i); i += 1; }
    else if (arg === '--json') { args.json = resolve(take(i)); i += 1; }
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!['health', 'generate', 'both'].includes(args.mode)) throw new Error(`unknown mode ${args.mode}`);
  if (args.mode === 'generate') args.generate = true;
  if (args.mode === 'both') args.generate = true;
  for (const [key, envName] of Object.entries({
    requests: 'LIVE_HEALTH_MAX_REQUESTS',
    tokens: 'LIVE_HEALTH_MAX_TOKENS',
    durationMs: 'LIVE_HEALTH_MAX_DURATION_MS',
    concurrency: 'LIVE_HEALTH_MAX_CONCURRENCY',
  })) {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${envName} must be a non-negative integer (got ${JSON.stringify(raw)})`);
    if (value > HARD_LIMITS[key]) throw new Error(`${envName}=${value} exceeds the hard ceiling ${HARD_LIMITS[key]}`);
    args.overrides[key] = value;
  }
  return args;
}

const USAGE = `usage: node scripts/live-health.mjs [--mode health|generate|both] [--generate] [--base-url URL]
       [--worker-url URL] [--expect-commit SHA] [--model ID] [--json PATH]

Non-generating checks always run. The generation probe is opt-in (--generate, --mode generate|both, or
LIVE_HEALTH_ENABLE_GENERATION=1), sends at most ${LIMITS.requests} real request, and never retries or falls
back to a paid model. Budget overrides: LIVE_HEALTH_MAX_REQUESTS/${HARD_LIMITS.requests},
LIVE_HEALTH_MAX_TOKENS/${HARD_LIMITS.tokens}, LIVE_HEALTH_MAX_DURATION_MS/${HARD_LIMITS.durationMs},
LIVE_HEALTH_MAX_CONCURRENCY/${HARD_LIMITS.concurrency}.`;

/** GET/POST with a per-check deadline; returns a compact result and never throws. */
async function request(url, { method = 'GET', body, headers = {}, timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      contentType: (res.headers.get('content-type') || '').toLowerCase(),
      headers: res.headers,
      bytes,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 120), latencyMs: Date.now() - started };
  }
}

/** Bounded retry for non-generating transient checks (network errors and 5xx only). */
async function requestWithRetry(url, options = {}, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await request(url, options);
    const transient = !last.ok || last.status >= 500;
    if (!transient) return { ...last, attempts: attempt };
    if (attempt < attempts) await sleep(250 * attempt);
  }
  return { ...last, attempts };
}

const text = (bytes) => Buffer.from(bytes).toString('utf8');

/** A request that never reached the service is infrastructure; a wrong answer is the service's own category. */
const categoryFor = (res, category) => (res.ok ? category : 'infrastructure');

function check(id, category, status, extra = {}) {
  return { id, category, status, ...extra };
}

// ── site checks ─────────────────────────────────────────────────────────
async function checkSite(args, checks) {
  const base = args.baseUrl.endsWith('/') ? args.baseUrl : `${args.baseUrl}/`;
  const page = await requestWithRetry(base);
  const html = page.ok ? text(page.bytes) : '';
  const pageOk = page.ok && page.status === 200 && page.contentType.startsWith('text/html')
    && /<title>/i.test(html) && html.includes('js/main.js');
  checks.push(check('site.base', categoryFor(page, 'deployment'), pageOk ? 'pass' : 'fail',
    { latencyMs: page.latencyMs, attempts: page.attempts,
      detail: page.ok ? `HTTP ${page.status} ${page.contentType}` : `no response: ${page.error}`,
      code: pageOk ? undefined : (page.ok ? 'site.base-path' : 'site.unreachable') }));

  for (const asset of SITE_ASSETS) {
    const res = await requestWithRetry(base + asset.path);
    const body = res.ok ? text(res.bytes) : '';
    let status = 'pass';
    let code;
    if (!res.ok || res.status !== 200) { status = 'fail'; code = 'site.asset-missing'; }
    else if (!asset.mime.test(res.contentType)) { status = 'fail'; code = 'site.asset-mime'; }
    else if (asset.mustContain && !body.includes(asset.mustContain)) { status = 'fail'; code = 'site.asset-contract'; }
    else if ((res.bytes?.length ?? 0) < 64) { status = 'fail'; code = 'site.asset-empty'; }
    checks.push(check(asset.id, categoryFor(res, asset.category), status, {
      latencyMs: res.latencyMs, attempts: res.attempts, bytes: res.bytes?.length ?? 0,
      detail: res.ok ? `HTTP ${res.status} ${res.contentType || '(no content-type)'}` : `no response: ${res.error}`,
      code,
    }));
  }

  const wasm = await requestWithRetry(`${base}dist/agent.wasm`);
  const magic = wasm.ok && wasm.bytes.length >= 8
    && wasm.bytes[0] === 0x00 && wasm.bytes[1] === 0x61 && wasm.bytes[2] === 0x73 && wasm.bytes[3] === 0x6d
    && wasm.bytes[4] === 0x01 && wasm.bytes[5] === 0x00 && wasm.bytes[6] === 0x00 && wasm.bytes[7] === 0x00;
  checks.push(check('site.wasm-valid', categoryFor(wasm, 'deployment'), wasm.ok && wasm.status === 200 && magic ? 'pass' : 'fail', {
    latencyMs: wasm.latencyMs, attempts: wasm.attempts, bytes: wasm.bytes?.length,
    detail: magic ? 'wasm magic + version 1' : 'response is not a WASM module',
    code: magic ? undefined : 'site.wasm-invalid',
  }));

  // Build identity: the served build-info.json must describe the bytes actually being served.
  const info = await requestWithRetry(`${base}build-info.json`);
  if (!info.ok || info.status !== 200) {
    checks.push(check('site.build-info', categoryFor(info, 'deployment'), 'fail', {
      latencyMs: info.latencyMs, attempts: info.attempts,
      detail: info.ok ? `HTTP ${info.status}: the deployed tree carries no build identity (an artifact published before the staged _site build)` : `no response: ${info.error}`,
      code: info.ok ? 'site.build-info-missing' : 'site.unreachable',
    }));
    return;
  }
  let parsed = null;
  try { parsed = JSON.parse(text(info.bytes)); } catch { /* reported below */ }
  const shapeOk = parsed && typeof parsed.commit === 'string' && typeof parsed.wasmSha256 === 'string'
    && typeof parsed.lockfileSha256 === 'string' && parsed.toolchain && parsed.deps;
  if (!shapeOk) {
    checks.push(check('site.build-info', 'deployment', 'fail', { latencyMs: info.latencyMs, attempts: info.attempts, detail: 'build-info.json does not match the expected shape', code: 'site.build-info-shape' }));
    return;
  }
  const servedWasm = wasm.ok && wasm.status === 200
    ? createHash('sha256').update(wasm.bytes).digest('hex')
    : null;
  const digestMatches = servedWasm !== null && servedWasm === parsed.wasmSha256;
  const commitMatches = !args.expectCommit || parsed.commit === args.expectCommit;
  const detail = `commit ${parsed.commit}${args.expectCommit ? ` (expected ${args.expectCommit})` : ''}; wasm ${digestMatches ? 'digest matches served bytes' : 'digest MISMATCH'}`;
  checks.push(check('site.build-info', 'deployment', digestMatches && commitMatches ? 'pass' : 'fail', {
    latencyMs: info.latencyMs, attempts: info.attempts,
    detail,
    version: { siteCommit: parsed.commit, wasmSha256: parsed.wasmSha256, expectedCommit: args.expectCommit || null },
    code: !digestMatches ? 'site.wasm-digest-mismatch' : (!commitMatches ? 'site.stale-artifact' : undefined),
  }));
}

// ── catalog + worker checks ─────────────────────────────────────────────
async function fetchCatalog(args, checks) {
  const res = await requestWithRetry(args.catalogUrl, {}, 2);
  if (!res.ok || res.status !== 200) {
    checks.push(check('catalog.shape', 'catalog', 'fail', {
      latencyMs: res.latencyMs, attempts: res.attempts,
      detail: res.ok ? `HTTP ${res.status}` : `no response: ${res.error}`,
      code: 'catalog.unreachable',
    }));
    return [];
  }
  let data = null;
  try { data = JSON.parse(text(res.bytes))?.data; } catch { /* reported below */ }
  const wellFormed = Array.isArray(data) && data.length > 0
    && data.every((m) => m && typeof m.id === 'string' && m.pricing && m.architecture);
  const freeIds = wellFormed ? data.filter(isCatalogFree).map((m) => m.id) : [];
  checks.push(check('catalog.shape', 'catalog', wellFormed && freeIds.length > 0 ? 'pass' : 'fail', {
    latencyMs: res.latencyMs, attempts: res.attempts,
    detail: wellFormed ? `${data.length} models, ${freeIds.length} free` : 'catalog payload does not match the expected shape',
    code: wellFormed ? (freeIds.length ? undefined : 'catalog.no-free-model') : 'catalog.shape',
  }));
  return wellFormed ? data : [];
}

/** A model the proxy may use: `:free` suffix and zero prompt/completion pricing in the live catalog. */
function isCatalogFree(m) {
  const p = m?.pricing ?? {};
  return typeof m?.id === 'string' && m.id.endsWith(':free')
    && String(p.prompt) === '0' && String(p.completion) === '0';
}

function catalogFreeTextModels(data) {
  return data.filter((m) => isCatalogFree(m) && Array.isArray(m.architecture?.output_modalities) && m.architecture.output_modalities.includes('text'))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || (a.id < b.id ? 1 : -1));
}

async function checkWorker(args, checks) {
  const base = args.workerUrl.replace(/\/+$/, '');
  const health = await requestWithRetry(`${base}/api/health`);
  let body = null;
  if (health.ok && health.status === 200) {
    try { body = JSON.parse(text(health.bytes)); } catch { /* reported below */ }
  }
  const healthy = health.ok && health.status === 200 && body?.ok === true && body?.freeOnly === true;
  checks.push(check('worker.health', health.ok ? 'workerConfig' : 'infrastructure', healthy ? 'pass' : 'fail', {
    latencyMs: health.latencyMs, attempts: health.attempts,
    detail: health.ok ? `HTTP ${health.status} ${text(health.bytes).slice(0, 80)}` : `no response: ${health.error}`,
    version: health.ok ? { workerLiveness: body ?? null } : undefined,
    code: healthy ? undefined : (health.ok ? 'worker.health-shape' : 'worker.unreachable'),
  }));

  // The free-only boundary, exercised with a paid model id. No generation: the Worker must refuse before it
  // reaches upstream, which is why this is part of the non-generating checks. max_tokens is 1 so that a
  // regressed Worker cannot spill more than a token if this ever did reach a provider.
  const paid = await request(`${base}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: PROBE_PROMPT }], max_tokens: 1, stream: false }),
    timeoutMs: 10_000,
  });
  let err = null;
  if (paid.ok) { try { err = JSON.parse(text(paid.bytes))?.error?.message ?? null; } catch { /* keep null */ } }
  const refused = paid.ok && paid.status === 403 && typeof err === 'string' && err.includes('NOT_FREE');
  checks.push(check('worker.free-only-boundary', paid.ok ? 'workerConfig' : 'infrastructure', refused ? 'pass' : 'fail', {
    latencyMs: paid.latencyMs,
    detail: paid.ok ? `HTTP ${paid.status}` : `no response: ${paid.error}`,
    code: refused ? undefined : (paid.ok ? 'worker.paid-request-accepted' : 'worker.unreachable'),
  }));
}

// ── optional generation probe ───────────────────────────────────────────
async function generationProbe(args, limits, checks) {
  const budget = {
    requests: { limit: limits.requests, used: 0 },
    tokens: { limit: limits.tokens, used: 0 },
    durationMs: { limit: limits.durationMs, used: 0 },
    concurrency: { limit: limits.concurrency, used: 0 },
  };

  if (limits.requests < 1) {
    checks.push(check('probe.generation', 'budget', 'not-run', { detail: `request budget is ${limits.requests}: the probe does not run`, code: 'budget.requests' }));
    return { probe: 'budget-exhausted', budget };
  }
  if (limits.tokens < 1) {
    checks.push(check('probe.generation', 'budget', 'not-run', { detail: `output-token budget is ${limits.tokens}: a probe would be meaningless`, code: 'budget.tokens' }));
    return { probe: 'budget-exhausted', budget };
  }
  if (limits.concurrency < 1) {
    checks.push(check('probe.generation', 'budget', 'not-run', { detail: `concurrency budget is ${limits.concurrency}: the probe does not run`, code: 'budget.concurrency' }));
    return { probe: 'budget-exhausted', budget };
  }

  const catalog = await fetchCatalog(args, checks);
  const candidates = catalogFreeTextModels(catalog);
  const model = args.model ? candidates.find((m) => m.id === args.model) : candidates[0];
  if (!model) {
    checks.push(check('probe.generation', 'catalog', 'fail', {
      detail: args.model
        ? `--model ${args.model} is not a catalog-verified free text model; refusing to send a paid or unverified model`
        : 'the live catalog has no free text model to probe with',
      code: 'catalog.probe-model-unavailable',
    }));
    return { probe: 'failed', budget };
  }

  // Bounded read of the SSE stream: byte-capped, one request, no retry.
  const started = Date.now();
  let firstByteMs = null;
  let bytes = 0;
  let events = 0;
  let done = false;
  let status = 0;
  let abortReason = null;
  try {
    // Counted at send, not at response: a probe aborted by the duration budget
    // still issued its one request, and the budget line must not report 0/1 for
    // a request that left the building.
    budget.requests.used = 1;
    const res = await fetch(`${args.workerUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: PROBE_PROMPT }], max_tokens: limits.tokens, stream: true }),
      signal: AbortSignal.timeout(limits.durationMs),
    });
    status = res.status;
    if (res.status === 200 && res.body) {
      const reader = res.body.getReader();
      let off = 0;
      const decoder = new TextDecoder();
      let carry = '';
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (firstByteMs === null) firstByteMs = Date.now() - started;
        bytes += value.length;
        carry += decoder.decode(value, { stream: true });
        const parts = carry.split('\n\n');
        carry = parts.pop() ?? '';
        for (const part of parts) {
          if (part.startsWith('data:')) {
            events += 1;
            if (part.includes('[DONE]')) done = true;
          }
        }
        off += value.length;
        if (off > 64 * 1024) break; // bounded: a health probe is not a load test
      }
    }
  } catch (err) {
    abortReason = String(err?.name === 'TimeoutError' ? 'duration' : err?.message || err).slice(0, 120);
  }
  const totalMs = Date.now() - started;
  budget.durationMs.used = totalMs;
  budget.concurrency.used = 1;
  budget.tokens.used = limits.tokens; // the cap is what we authorised; the provider's usage is not persisted

  const passed = status === 200 && events > 0 && done && !abortReason;
  const category = abortReason === 'duration' ? 'budget' : status === 0 || status === 429 || status === 502 ? 'catalog' : 'catalog';
  checks.push(check('probe.generation', passed ? 'catalog' : category, passed ? 'pass' : (abortReason === 'duration' ? 'not-run' : 'fail'), {
    latencyMs: totalMs,
    detail: passed
      ? `upstream verification: 1 request, ${events} SSE events, ${bytes} bytes`
      : `status ${status || 'none'}${abortReason ? ` (${abortReason})` : ''} events ${events}`,
    version: { probeModel: model.id, tokensCappedAt: limits.tokens },
    code: passed ? undefined : (abortReason === 'duration' ? 'budget.duration-exceeded' : status === 429 ? 'provider.rate-limited' : 'provider.probe-failed'),
  }));

  return {
    probe: abortReason === 'duration' ? 'budget-exhausted' : (passed ? 'completed' : 'failed'),
    budget,
    probeDetail: { model: model.id, requests: 1, events, bytes, firstByteMs, totalMs, upstreamVerification: true },
  };
}

// ── report ──────────────────────────────────────────────────────────────
function writeRecord(path, record) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch (err) {
    console.warn(`LIVE-HEALTH warn: could not write ${path} (${String(err?.message).slice(0, 120)})`);
    return false;
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`LIVE-HEALTH usage error: ${err.message}`);
    console.error(USAGE);
    process.exit(EXIT.usage);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const limits = { ...LIMITS, ...args.overrides };
  const checks = [];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  await checkSite(args, checks);
  await checkWorker(args, checks);

  let probe = 'not-configured';
  let budget = null;
  let probeDetail = null;
  if (args.generate) {
    const result = await generationProbe(args, limits, checks);
    ({ probe, budget, probeDetail } = result);
  } else {
    await fetchCatalog(args, checks);
    checks.push(check('probe.generation', 'catalog', 'not-configured', {
      detail: 'generation probe not configured (enable with --generate, --mode generate|both, or LIVE_HEALTH_ENABLE_GENERATION=1)',
    }));
  }

  const failed = checks.filter((c) => c.status === 'fail');
  // A probe that the configured budget stopped is a visible failure outcome, not a pass: the operator
  // enabled generation and did not get it.
  const budgetStopped = checks.some((c) => c.status === 'not-run' && c.category === 'budget');
  const classification = PRIORITY.find((cat) => failed.some((c) => c.category === cat))
    ?? (budgetStopped ? 'budget' : null);
  const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY && process.env.GITHUB_SERVER_URL
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

  const record = {
    schema: 'live-health/1',
    startedAt,
    durationMs: Date.now() - t0,
    mode: args.generate ? 'health+generate' : 'health',
    target: { site: args.baseUrl, worker: args.workerUrl, catalog: args.catalogUrl },
    expectedCommit: args.expectCommit || null,
    generationProbe: probe,
    budget,
    probeDetail,
    summary: {
      passed: checks.filter((c) => c.status === 'pass').length,
      failed: failed.length,
      notConfigured: checks.filter((c) => c.status === 'not-configured').length,
      notRun: checks.filter((c) => c.status === 'not-run').length,
    },
    classification,
    exitCode: classification ? EXIT[classification] : 0,
    runUrl,
    checks,
  };
  writeRecord(args.json, record);

  console.log(`LIVE-HEALTH ${classification ? 'FAIL' : 'PASS'} (${record.mode}, ${record.durationMs}ms)`);
  for (const c of checks) {
    const detail = c.detail ? ` — ${c.detail}` : '';
    const code = c.code ? ` [${c.code}]` : '';
    console.log(`  ${c.status === 'pass' ? 'pass' : c.status.padEnd(4)} ${c.id.padEnd(26)} ${c.category.padEnd(19)}${detail}${code}`);
  }
  if (probe === 'not-configured') console.log('  probe: not configured — this run proves nothing about generation');
  if (probeDetail) {
    console.log(`  probe: upstream verification only (1 request, ${probeDetail.events} SSE events); not an end-to-end browser chat`);
  }
  if (budget) {
    console.log(`  budget: requests ${budget.requests.used}/${budget.requests.limit}, tokens ${budget.tokens.used}/${budget.tokens.limit}, duration ${budget.durationMs.used}ms/${budget.durationMs.limit}ms, concurrency ${budget.concurrency.used}/${budget.concurrency.limit}`);
  }
  console.log(`  wrote ${args.json}`);
  if (classification) {
    console.log(`LIVE-HEALTH classification: ${classification} (exit ${EXIT[classification]})`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### live-health: ${classification} failure\n\n` +
          checks.filter((c) => c.status === 'fail').map((c) => `- \`${c.id}\` (${c.category}) ${c.detail ?? ''}${c.code ? ` [${c.code}]` : ''}`).join('\n') +
          `\n\nSite commit: ${record.checks.find((c) => c.version?.siteCommit)?.version?.siteCommit ?? 'unknown'}${args.expectCommit ? ` (expected ${args.expectCommit})` : ''}\n`, { flag: 'a' });
      } catch { /* the summary is best-effort */ }
    }
    console.log(`  rollback: Pages is published independently of the Worker — re-run the "Deploy to GitHub Pages" workflow for the last verified commit (or re-deploy that run's \`github-pages\` artifact) to restore the site; the Worker is rolled back with \`npx wrangler versions deploy <previous-version-id>@100 --yes\`${runUrl ? ` (this run: ${runUrl})` : ''}.`);
  }
  process.exit(record.exitCode);
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(`LIVE-HEALTH failed: ${String(err?.message).slice(0, 200)}`);
    process.exit(1);
  });
}

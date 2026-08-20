// worker/api-chat.js — stateless Cloudflare Worker proxy for Free Models.
// Q6 A / Q7 C / Q9 A / Q10 A / Q11 A / Q13 A
// - POST /api/chat -> forward to OpenRouter with Operator Key only if model endsWith(':free')
// - 403 NOT_FREE otherwise, 500 if key missing
// - SSE streamed verbatim, no buffering
// - CORS echo, OPTIONS handled
// - Stateless log with salted ip hash

const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function corsHeaders(origin) {
  // Echo Pages origin, allow workers.dev + localhost for dev
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

// FNV-1a 32-bit + salt for ipHash (privacy-safe, no raw IP in logs)
function hashIp(ip, salt) {
  const s = (salt || 'asm-salt') + '|' + (ip || '0.0.0.0');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function isFreeModel(id) { return typeof id === 'string' && id.endsWith(':free'); }

export async function handleChat(request, env, ctx) {
  const origin = request.headers.get('origin') || '';
  const cors = corsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'POST') {
    return json(405, { error: { message: 'Method not allowed' } }, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: { message: 'Invalid JSON' } }, cors); }

  const model = String(body?.model || '');
  if (!isFreeModel(model)) {
    return json(403, { error: { message: 'NOT_FREE — Proxy only serves Free Models (:free). Add your own key in SET for paid models.' } }, cors);
  }

  const key = env?.OPENROUTER_KEY || env?.OPENROUTER_API_KEY || '';
  if (!key) {
    return json(500, { error: { message: 'Operator Key not configured' } }, cors);
  }

  // Logging (Q13 A) — salted hash, no raw IP/messages
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0';
  const ipHash = hashIp(ip, env?.LOG_SALT);
  const t0 = Date.now();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ at: new Date().toISOString(), ipHash, model, stream: !!body.stream }));

  const upstreamHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    // Preserve spec headers — use client origin or worker origin
    'http-referer': request.headers.get('http-referer') || origin || 'https://asm-agent.pages.dev',
    'x-title': request.headers.get('x-title') || 'ASM::AGENT',
  };

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ipHash, model, status: 'upstream_fetch_error', err: String(e).slice(0, 200) }));
    return json(502, { error: { message: 'Upstream fetch failed: ' + String(e).slice(0, 300) } }, cors);
  }

  // If upstream is SSE streaming, pipe verbatim (no buffering) per ADR
  // Preserve upstream status and headers for 429/403 etc so client sees "Free tier busy"
  const outHeaders = { ...cors };
  // Pass through content-type and cache-control for SSE
  const ct = upstream.headers.get('content-type');
  if (ct) outHeaders['content-type'] = ct;
  const cc = upstream.headers.get('cache-control');
  if (cc) outHeaders['cache-control'] = cc;

  // Log completion
  // ctx.waitUntil not needed as we are stateless, but keep for CF
  if (ctx?.waitUntil) {
    ctx.waitUntil((async () => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ipHash, model, status: upstream.status, ms: Date.now() - t0 }));
    })());
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ipHash, model, status: upstream.status, ms: Date.now() - t0 }));
  }

  // For SSE, are we able to stream? Return upstream body directly
  // Cloudflare Workers support streaming Response bodies
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Only serve /api/chat (and /api/chat/* for versioning)
    if (url.pathname === '/api/chat' || url.pathname === '/api/chat/') {
      return handleChat(request, env, ctx);
    }
    // Health check
    if (url.pathname === '/api/health') {
      const origin = request.headers.get('origin') || '';
      return json(200, { ok: true, freeOnly: true }, corsHeaders(origin));
    }
    // Fallback 404 with CORS
    const origin = request.headers.get('origin') || '';
    return json(404, { error: { message: 'Not found' } }, corsHeaders(origin));
  },
};

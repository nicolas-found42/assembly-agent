#!/usr/bin/env node
// baseline-search.mjs — measures js/search.js fan-out against live APIs.
// Mirrors search.js pipeline (timed/jfetch/fmt + dedupe+12k slice) with instrumentation.
// Run: node test/baseline-search.mjs  (Node 18+ with fetch)
// Output: test/fixtures/baseline-search.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const TIMEOUT = 8000;

function fmt(tag, title, url, snippet) {
  let out = `### [${tag}] ${title}\n`;
  if (url) out += `${url}\n`;
  if (snippet) out += `${snippet}\n`;
  return out + '\n';
}
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();
const norm = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();

async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function wikipedia(q, sig) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3`;
  const j = await jfetch(u, { signal: sig });
  return (j?.query?.search || []).map((s) =>
    fmt('WIKIPEDIA', s.title, `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`, stripTags(s.snippet))).join('');
}
async function hackernews(q, sig) {
  const u = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=4`;
  const j = await jfetch(u, { signal: sig });
  return (j?.hits || []).map((h) =>
    fmt('HACKER NEWS', h.title || h.story_title || '', h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      `${h.points || 0} points · ${h.num_comments || 0} comments`)).join('');
}
async function duckduckgo(q, sig) {
  const u = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
  const j = await jfetch(u, { signal: sig });
  let out = '';
  if (j?.AbstractText) out += fmt('DUCKDUCKGO', j.Heading || q, j.AbstractURL, j.AbstractText);
  const rel = (j?.RelatedTopics || []).map((r) => r?.Text).filter(Boolean).slice(0, 3);
  for (const r of rel) out += fmt('DUCKDUCKGO', r.split(' - ')[0].slice(0, 80), '', r);
  return out;
}
async function stackexchange(q, sig) {
  const u = `https://api.stackexchange.com/2.3/search/advanced?q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=4&order=desc&sort=relevance`;
  const j = await jfetch(u, { signal: sig });
  return (j?.items || []).map((i) =>
    fmt('STACK OVERFLOW', i.title, i.link, `score ${i.score} · ${i.is_answered ? 'answered' : 'unanswered'}`)).join('');
}
async function github(q, sig) {
  const u = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=4`;
  const j = await jfetch(u, { signal: sig, headers: { Accept: 'application/vnd.github+json' } });
  return (j?.items || []).map((r) =>
    fmt('GITHUB', r.full_name, r.html_url, `★ ${r.stargazers_count} — ${r.description || ''}`)).join('');
}
async function tavily(q, sig, key) {
  const j = await jfetch('https://api.tavily.com/search', {
    method: 'POST', signal: sig,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: 5 }),
  });
  return (j?.results || []).map((r) => fmt('TAVILY', r.title, r.url, r.content)).join('');
}
async function brave(q, sig, key) {
  const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`;
  const j = await jfetch(u, { signal: sig, headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
  return (j?.web?.results || []).map((r) => fmt('BRAVE', r.title, r.url, r.description)).join('');
}
async function jina(q, sig, key) {
  const r = await fetch(`https://s.jina.ai/${encodeURIComponent(q)}`, {
    signal: sig, headers: { Authorization: `Bearer ${key}`, Accept: 'text/plain' },
  });
  if (!r.ok) throw new Error(String(r.status));
  const text = (await r.text()).slice(0, 4000);
  return fmt('JINA', q, '', text);
}

const SOURCES = [
  { name: 'wikipedia', fn: wikipedia, keyless: true },
  { name: 'hn', fn: hackernews, keyless: true },
  { name: 'ddg', fn: duckduckgo, keyless: true },
  { name: 'stackexchange', fn: stackexchange, keyless: true },
  { name: 'github', fn: github, keyless: true },
  { name: 'tavily', fn: tavily, keyless: false },
  { name: 'brave', fn: brave, keyless: false },
  { name: 'jina', fn: jina, keyless: false },
];

const QUERIES = [
  "WebAssembly SIMD",
  "CRISPR prime editing",
  "Rust borrow checker",
  "quantum error correction surface code",
  "React Server Components",
  "black hole information paradox",
  "TypeScript 5.5 decorators",
  "mRNA vaccine stability",
  "Kubernetes sidecar pattern",
  "large language model quantization",
  "gravitational wave detection LIGO",
  "WASI preview 2",
  "perovskite solar cell efficiency",
  "SQLite WAL mode",
  "protein folding AlphaFold 3",
  "WebGPU compute shaders",
  "dark matter direct detection",
  "Bun runtime vs Node",
  "fusion tokamak ITER",
  "prompt caching anthropic",
];

function p50(a) { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length*0.5)]; }
function p95(a) { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length*0.95)] ?? s[s.length-1]; }
function avg(a) { if (!a.length) return null; return Math.round(a.reduce((x,y)=>x+y,0)/a.length); }

async function timedSource(name, fn, query) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  const t0 = performance.now();
  try {
    const r = await fn(query, ctl.signal);
    const ms = Math.round(performance.now() - t0);
    clearTimeout(t);
    return { ok: true, ms, bytes: r ? Buffer.byteLength(r, 'utf8') : 0, block: r || '', error: null };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    clearTimeout(t);
    const msg = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)).slice(0, 120);
    return { ok: false, ms, bytes: 0, block: '', error: msg };
  }
}

async function runOne(query, keys) {
  const t0 = performance.now();
  const perSource = {};
  const failures = [];
  const jobs = [];
  for (const s of SOURCES) {
    if (!s.keyless) {
      const k = keys[s.name];
      if (!k) { perSource[s.name] = { skipped: true, reason: 'no key' }; continue; }
      jobs.push({ name: s.name, p: timedSource(s.name, (q, sig) => s.fn(q, sig, k), query) });
    } else jobs.push({ name: s.name, p: timedSource(s.name, s.fn, query) });
  }
  const settled = await Promise.all(jobs.map(j => j.p));
  const blocks = [];
  settled.forEach((res, i) => {
    const name = jobs[i].name;
    perSource[name] = { ok: res.ok, ms: res.ms, bytes: res.bytes, error: res.error, skipped: false };
    if (!res.ok) failures.push(name);
    else if (res.bytes > 0) blocks.push(res.block);
    else perSource[name].empty = true;
  });
  const beforeDedupe = blocks.length;
  const seen = new Set();
  const deduped = [];
  let dedupHits = 0;
  for (const b of blocks) {
    const url = (b.match(/^https?:\S+/m) || [''])[0];
    if (url) { const n = norm(url); if (seen.has(n)) { dedupHits++; continue; } seen.add(n); }
    deduped.push(b);
  }
  const totalBeforeSlice = deduped.join('').length;
  const markdown = deduped.join('').slice(0, 12000);
  const totalMs = Math.round(performance.now() - t0);
  return { query, totalMs, sources: deduped.length, failures, totalBeforeSlice, truncated: totalBeforeSlice > 12000, slicedLen: markdown.length, dedup: { before: beforeDedupe, after: deduped.length, hits: dedupHits }, perSource, markdownSample: markdown.slice(0, 500) };
}

async function main() {
  console.log(`Baseline fan-out: ${QUERIES.length} queries × 5 keyless (+3 keyed if keys present)`);
  const keys = { tavily: process.env.TAVILY_KEY || '', brave: process.env.BRAVE_KEY || '', jina: process.env.JINA_KEY || '' };
  console.log('Keys:', Object.entries(keys).map(([k,v]) => `${k}:${v?'yes':'no'}`).join(' '));
  const results = [];
  for (let i=0;i<QUERIES.length;i++) {
    const q=QUERIES[i];
    console.log(`\n[${i+1}/${QUERIES.length}] "${q}"`);
    const r=await runOne(q, keys);
    console.log(`  total ${r.totalMs}ms  sources=${r.sources}  beforeSlice=${r.totalBeforeSlice}  failures=[${r.failures.join(',')||'—'}]  dedup ${r.dedup.before}->${r.dedup.after}`);
    for (const [name,s] of Object.entries(r.perSource)) {
      if (s.skipped) console.log(`    ${name}: skipped`); else console.log(`    ${name}: ${s.ok?'ok':'FAIL'} ${s.ms}ms ${s.bytes}B${s.error?' err='+s.error:''}${s.empty?' (empty)':''}`);
    }
    results.push(r);
    if (i<QUERIES.length-1) await new Promise(r=>setTimeout(r,600));
  }
  const bySource={};
  for (const s of SOURCES) {
    const vals=results.map(r=>r.perSource[s.name]).filter(v=>v&&!v.skipped);
    const latOk=vals.filter(v=>v.ok).map(v=>v.ms);
    const latAll=vals.map(v=>v.ms);
    const bytesOk=vals.filter(v=>v.ok&&v.bytes>0).map(v=>v.bytes);
    const okCount=vals.filter(v=>v.ok).length;
    const emptyCount=vals.filter(v=>v.ok&&v.empty).length;
    bySource[s.name]={ attempted: vals.length, skipped: results.filter(r=>r.perSource[s.name]?.skipped).length, successRate: vals.length?+(okCount/vals.length).toFixed(3):null, emptyRate: vals.length?+(emptyCount/vals.length).toFixed(3):null, p50_ms: p50(latOk), p95_ms: p95(latOk), p50_all_ms: p50(latAll), p95_all_ms: p95(latAll), avg_ms: avg(latAll), avg_bytes: avg(bytesOk), p50_bytes: p50(bytesOk), p95_bytes: p95(bytesOk), min_bytes: bytesOk.length?Math.min(...bytesOk):null, max_bytes: bytesOk.length?Math.max(...bytesOk):null, failures: vals.filter(v=>!v.ok).map(v=>v.error).slice(0,5) };
  }
  const totals={ queries: results.length, avgTotalMs: avg(results.map(r=>r.totalMs)), p50TotalMs: p50(results.map(r=>r.totalMs)), p95TotalMs: p95(results.map(r=>r.totalMs)), avgSourcesPerQuery: +(results.reduce((a,r)=>a+r.sources,0)/results.length).toFixed(2), avgTotalBeforeSlice: avg(results.map(r=>r.totalBeforeSlice)), maxBeforeSlice: Math.max(...results.map(r=>r.totalBeforeSlice)), truncatedQueries: results.filter(r=>r.truncated).length, totalDedupHits: results.reduce((a,r)=>a+r.dedup.hits,0), avgDedupHits: +(results.reduce((a,r)=>a+r.dedup.hits,0)/results.length).toFixed(2), failureFrequency: Object.fromEntries(SOURCES.map(s=>[s.name, results.filter(r=>r.failures.includes(s.name)).length])) };
  const out={ meta:{ generatedAt: new Date().toISOString(), nodeVersion: process.version, timeoutMs: TIMEOUT, queries: QUERIES, note: "Live fan-out via Node timed/jfetch/fmt pipeline mirroring js/search.js; keyed sources skipped when env keys absent; 600ms inter-query delay.", env: "node-direct (no CORS enforcement); browser vs Worker differences noted in markdown report" }, totals, bySource, results };
  mkdirSync('test/fixtures', { recursive: true });
  writeFileSync('test/fixtures/baseline-search.json', JSON.stringify(out, null, 2));
  console.log('\n— wrote test/fixtures/baseline-search.json');
  console.log(JSON.stringify({ totals, bySource }, null, 2));
}
main().catch(e=>{ console.error(e); process.exit(1); });

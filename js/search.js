// search.js — parallel fan-out meta-search (keyless-first, spread load).
// Every source is failure-tolerant: a failure simply omits that block.

const TIMEOUT = 8000;

function fmt(tag, title, url, snippet) {
  let out = `### [${tag}] ${title}\n`;
  if (url) out += `${url}\n`;
  if (snippet) out += `${snippet}\n`;
  return out + '\n';
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();
const norm = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();

async function timed(name, fn, failures) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    const r = await fn(ctl.signal);
    clearTimeout(t);
    return r;
  } catch {
    failures.push(name);
    return null;
  }
}

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

/** Keys read from settings each call so modal edits apply immediately. */
function keys() {
  try { return JSON.parse(localStorage['asm.settings'] || '{}'); } catch { return {}; }
}

export async function webSearch(query) {
  const failures = [];
  const s = keys();
  const jobs = [
    timed('wikipedia', (sig) => wikipedia(query, sig), failures),
    timed('hn', (sig) => hackernews(query, sig), failures),
    timed('ddg', (sig) => duckduckgo(query, sig), failures),
    timed('stackexchange', (sig) => stackexchange(query, sig), failures),
    timed('github', (sig) => github(query, sig), failures),
  ];
  if (s.tavily) jobs.push(timed('tavily', (sig) => tavily(query, sig, s.tavily), failures));
  if (s.brave) jobs.push(timed('brave', (sig) => brave(query, sig, s.brave), failures));
  if (s.jina) jobs.push(timed('jina', (sig) => jina(query, sig, s.jina), failures));

  const blocks = (await Promise.allSettled(jobs))
    .map((r) => (r.status === 'fulfilled' ? r.value : ''))
    .filter(Boolean);

  // dedupe blocks by normalized URL line
  const seen = new Set();
  const deduped = [];
  for (const b of blocks) {
    const url = (b.match(/^https?:\S+/m) || [''])[0];
    if (url) {
      const n = norm(url);
      if (seen.has(n)) continue;
      seen.add(n);
    }
    deduped.push(b);
  }

  const markdown = deduped.join('').slice(0, 12000);
  return { markdown, sources: deduped.length, failures };
}

// debug hook
window.__asm = window.__asm || {};
window.__asm.search = webSearch;

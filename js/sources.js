// js/sources.js — the Source registry for the keyless research pipeline.
// One deduped record per canonical URL, kept in first-seen order, carrying its
// provenance (first provider + alsoBy), its read outcome, and evidence units.
// Zero imports: pure ESM, safe for the drawer, persistence and the evidence
// checker to share.

const FAILURE_STATUS = ['blocked', 'failed', 'empty'];
const DATE_FIELDS = ['publishedAt', 'updatedAt', 'dataAsOf'];
const SNIPPET_CAP = 280;

/** Canonical dedup key: strip the fragment and any trailing slash. The scheme
 *  and host are lowercased; the PATH keeps its case and every query param is
 *  preserved — parameterised and signed URLs must stay distinct. */
export function canonicalUrl(u) {
 const s = String(u == null ? '' : u).trim();
 if (!s) return '';
 const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/);
 if (!m) return s.replace(/#[\s\S]*$/, '').replace(/\/+$/, '');
 const at = m[2].lastIndexOf('@');
 const userinfo = at === -1 ? '' : m[2].slice(0, at + 1);
 const host = (at === -1 ? m[2] : m[2].slice(at + 1)).toLowerCase();
 const rest = m[3].replace(/#[\s\S]*$/, '').replace(/\/+$/, '');
 const path = rest && !rest.startsWith('/') ? `/${rest}` : rest;
 return `${m[1].toLowerCase()}://${userinfo}${host}${path}`;
}

/** Parse the `### [TAG] title\nurl\nsnippet` blocks Sources emit. Local copy
 *  of js/search.js parseBlocks so the registry stays import-free. */
export function parseFmtBlocks(markdown) {
 const out = [];
 for (const block of String(markdown == null ? '' : markdown).split(/(?=### \[)/)) {
  const m = block.match(/^### \[([^\]]+)\] (.+)\n(\S*)\n?([\s\S]*)$/);
  if (m) out.push({ tag: m[1], title: m[2].trim(), url: m[3], snippet: m[4].trim() });
 }
 return out;
}

/** Only ok records count as supporting sources: a blocked/failed/empty read
 *  is a retrieval outcome, never evidence. */
export function supporting(records) {
 return (Array.isArray(records) ? records : []).filter((r) => r.status === 'ok');
}

const excerpt = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CAP);

export function createSourceRegistry() {
 const records = [];
 const byKey = new Map();
 let seq = 0;

 const find = (url) => {
  const k = canonicalUrl(url);
  return k ? byKey.get(k) || null : null;
 };

 // Insert as a new record (caller has already checked for an existing one).
 const keep = (rec) => {
  const k = canonicalUrl(rec.url);
  if (!k) return null;
  byKey.set(k, rec);
  records.push(rec);
  return rec;
 };

 // A redirect's original URL points at the record its finalUrl created.
 const alias = (url, rec) => {
  const k = canonicalUrl(url);
  if (k && !byKey.has(k)) byKey.set(k, rec);
 };

 const noteProvider = (rec, provider) => {
  if (!provider || provider === rec.provider) return;
  if (!rec.alsoBy) rec.alsoBy = [];
  if (!rec.alsoBy.includes(provider)) rec.alsoBy.push(provider);
 };

 const make = ({ url, title, provider, origin, status, snippet = '', page, fetched = false }) => {
  const rec = { id: `s${++seq}`, url, title: title || url, provider, origin, status, snippet };
  if (page) for (const f of DATE_FIELDS) if (page[f] != null && page[f] !== '') rec[f] = page[f];
  rec.discoveredAt = Date.now();
  if (fetched) rec.fetchedAt = Date.now();
  return rec;
 };

 const copy = (r) => {
  const c = { ...r };
  if (r.evidence) c.evidence = r.evidence.map((e) => ({ ...e }));
  return c;
 };

 /** Fold a webSearch() result in: one record per fmt block, deduped by
  *  canonical URL with the later provider kept in alsoBy. */
 function addSearchRecord(rec, origin = 'initial') {
  const added = [];
  for (const b of parseFmtBlocks(rec && rec.markdown)) {
   if (!b.url) continue;
   const existing = find(b.url);
   if (existing) {
    noteProvider(existing, b.tag);
    added.push(existing);
    continue;
   }
   added.push(keep(make({
    url: b.url,
    title: b.title,
    provider: b.tag || 'web',
    origin,
    status: 'ok',
    snippet: b.snippet,
   })));
  }
  return added;
 }

 /** Fold a readPage() ok result in. A URL a search already discovered is
  *  promoted in place (its provider and snippet survive), never duplicated. */
 function addPage(page, origin = 'auto-read') {
  if (!page || !page.url) return null;
  const url = page.finalUrl || page.url;
  const existing = find(url) || find(page.url);
  if (existing) {
   existing.status = 'ok';
   existing.fetchedAt = Date.now();
   if (page.title && existing.title === existing.url) existing.title = page.title;
   if (!existing.snippet) existing.snippet = excerpt(page.text);
   for (const f of DATE_FIELDS) if (page[f] != null && page[f] !== '' && existing[f] == null) existing[f] = page[f];
   noteProvider(existing, 'read');
   alias(url, existing);
   alias(page.url, existing);
   return existing;
  }
  const rec = make({
   url,
   title: page.title,
   provider: 'read',
   origin,
   status: 'ok',
   snippet: excerpt(page.text),
   page,
   fetched: true,
  });
  keep(rec);
  alias(page.url, rec);
  return rec;
 }

 /** Record a retrieval outcome that produced no usable body. A URL already
  *  discovered keeps its status: a failed read never demotes a source. */
 function addReadFailure(url, status = 'failed', origin = 'auto-read') {
  if (!url) return null;
  const existing = find(url);
  if (existing) return existing;
  return keep(make({
   url,
   title: url,
   provider: 'read',
   origin,
   status: FAILURE_STATUS.includes(status) ? status : 'failed',
  }));
 }

 /** Attach an evidence unit ({ field, value, unit?, scope?, period?, excerpt? })
  *  to a source by id. Returns the record, or null when the id is unknown. */
 function addEvidence(id, item) {
  const rec = records.find((r) => r.id === id);
  if (!rec || !item) return null;
  if (!rec.evidence) rec.evidence = [];
  rec.evidence.push({ ...item });
  return rec;
 }

 /** Ok records first, then the failed/blocked/empty ones, each group in
  *  first-seen order. Copies: callers cannot corrupt the registry. */
 function snapshot() {
  const ok = [];
  const rest = [];
  for (const r of records) (r.status === 'ok' ? ok : rest).push(copy(r));
  return ok.concat(rest);
 }

 return {
  addSearchRecord,
  addPage,
  addReadFailure,
  addEvidence,
  snapshot,
  canonicalUrl,
  size: () => records.length,
 };
}

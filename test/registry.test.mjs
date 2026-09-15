// registry.test.mjs — TDD contract for js/sources.js (the Source registry).
// Pure module, no network, no browser shims: the registry dedups discovered
// sources by canonical URL, keeps their provenance and evidence, and is the
// only place that decides which records count as supporting sources.

import assert from 'node:assert/strict';

const mod = await import('../js/sources.js');
const { createSourceRegistry, supporting, canonicalUrl, parseFmtBlocks } = mod;

const fmt = (tag, title, url, snip) => `### [${tag}] ${title}\n${url}\n${snip}\n\n`;
const searchRec = (md) => ({ markdown: md, sources: 1, failures: [], perSource: [] });

// ── canonicalUrl ──
{
  assert.equal(canonicalUrl('HTTPS://Example.COM/Path/'), 'https://example.com/Path', 'scheme+host lowercased, path case and trailing slash kept apart');
  assert.equal(canonicalUrl('https://a.example/x#section'), 'https://a.example/x', 'fragment stripped');
  assert.equal(canonicalUrl('https://a.example/x?b=2&A=1'), 'https://a.example/x?b=2&A=1', 'query params preserved verbatim');
  assert.equal(canonicalUrl('https://a.example/x/?p=1'), 'https://a.example/x/?p=1', 'a slash before a query is not a trailing slash');
  assert.equal(canonicalUrl('https://a.example'), 'https://a.example', 'bare host survives');
  assert.equal(canonicalUrl('https://a.example/q?x=1'), 'https://a.example/q?x=1', 'pathless query normalised without loss');
  assert.equal(canonicalUrl('not a url/'), 'not a url', 'non-URL input still loses its trailing slash');
  assert.equal(canonicalUrl(''), '', 'empty input -> empty key');
  console.log('ok  : canonicalUrl strips fragments and trailing slashes only');
}

// ── parseFmtBlocks (local parser, zero imports) ──
{
  const md = 'preamble junk\n'
    + fmt('WIKIPEDIA', 'Ada Lovelace', 'https://en.wikipedia.org/wiki/Ada_Lovelace', 'mathematician')
    + fmt('JINA WEB', 'Two words', 'https://b.example/x', 'a snippet\nover two lines');
  const blocks = parseFmtBlocks(md);
  assert.equal(blocks.length, 2, 'one entry per fmt block, junk outside a block dropped');
  assert.deepEqual(blocks[0], { tag: 'WIKIPEDIA', title: 'Ada Lovelace', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', snippet: 'mathematician' });
  assert.equal(blocks[1].tag, 'JINA WEB');
  assert.equal(blocks[1].snippet, 'a snippet\nover two lines');
  assert.deepEqual(parseFmtBlocks(''), [], 'no blocks -> empty');
  console.log('ok  : parseFmtBlocks reads the fmt-block shape locally');
}

// ── stable ids across records ──
{
  const reg = createSourceRegistry();
  reg.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'A', 'https://a.example/1', 'alpha')), 'initial');
  reg.addSearchRecord(searchRec(fmt('JINA WEB', 'B', 'https://b.example/2', 'beta')), 'follow-up');
  const snap = reg.snapshot();
  assert.deepEqual(snap.map((r) => r.id), ['s1', 's2'], 'ids assigned s1..sN in discovery order');
  assert.equal(reg.size(), 2, 'size() counts records');
  assert.equal(snap[0].origin, 'initial', 'origin recorded per discovery');
  assert.equal(snap[1].origin, 'follow-up');
  assert.equal(snap[0].provider, 'WIKIPEDIA', 'provider is the fmt tag');
  assert.equal(snap[0].status, 'ok');
  assert.equal(typeof snap[0].discoveredAt, 'number', 'discoveredAt is a timestamp');
  assert.deepEqual(Object.keys(snap[0]).filter((k) => ['publishedAt', 'updatedAt', 'dataAsOf', 'fetchedAt'].includes(k)), [], 'unknown timestamps stay absent');

  const again = reg.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'A', 'https://a.example/1', 'alpha')), 'initial');
  assert.equal(again[0].id, 's1', 're-discovery keeps the original id');
  assert.equal(reg.size(), 2, 're-discovery does not grow the registry');
  assert.deepEqual(reg.snapshot().map((r) => r.id), ['s1', 's2'], 'ids are stable across snapshots');

  const snap2 = reg.snapshot();
  snap2[0].title = 'mutated';
  assert.equal(reg.snapshot()[0].title, 'A', 'snapshot() hands out copies');
  console.log('ok  : stable s1..sN ids, dedup never renumbers');
}

// ── dedup is case-sensitive on the path, not the host ──
{
  const reg = createSourceRegistry();
  reg.addSearchRecord(searchRec(fmt('X', 'Path', 'https://Example.com/Path', 'one')));
  reg.addSearchRecord(searchRec(fmt('Y', 'path', 'https://example.com/path', 'two')));
  assert.equal(reg.size(), 2, 'Path and path are different resources');
  assert.deepEqual(reg.snapshot().map((r) => r.provider), ['X', 'Y']);
  reg.addSearchRecord(searchRec(fmt('Z', 'Path', 'https://EXAMPLE.com/Path#frag', 'three')));
  assert.equal(reg.size(), 2, 'host case + fragment are not part of identity');
  assert.equal(reg.snapshot()[0].provider, 'X', 'first provider kept');
  assert.deepEqual(reg.snapshot()[0].alsoBy, ['Z'], 'later provider recorded as provenance');
  console.log('ok  : dedup lowercases scheme+host only, never the path');
}

// ── query params are identity ──
{
  const reg = createSourceRegistry();
  reg.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'Rev', 'https://en.wikipedia.org/w/index.php?title=Nba&oldid=123', 'old revision')));
  reg.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'Rev', 'https://en.wikipedia.org/w/index.php?title=Nba&oldid=124', 'new revision')));
  assert.equal(reg.size(), 2, 'distinct query params stay distinct');
  reg.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'Rev', 'https://en.wikipedia.org/w/index.php?title=Nba&oldid=123&utm_source=x', 'extra param')));
  assert.equal(reg.size(), 3, 'an extra query param is a different URL');
  reg.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'A', 'https://a.example/x/', 'a')));
  reg.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'A', 'https://a.example/x#frag', 'a again')));
  assert.equal(reg.size(), 4, 'trailing slash and fragment are the same URL');
  assert.equal(reg.snapshot().filter((r) => r.snippet === 'a').length, 1, 'the first snippet is the one kept');
  console.log('ok  : query params survive canonicalisation and keep URLs apart');
}

// ── provenance via alsoBy ──
{
  const reg = createSourceRegistry();
  reg.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'Ada Lovelace', 'https://en.wikipedia.org/wiki/Ada_Lovelace', 'mathematician')), 'initial');
  reg.addSearchRecord(searchRec(fmt('JINA WEB', 'Ada Lovelace – Wikipedia', 'https://en.wikipedia.org/wiki/Ada_Lovelace#Life', 'mathematician and writer')), 'follow-up');
  assert.equal(reg.size(), 1, 'one record for one canonical URL across providers');
  const rec = reg.snapshot()[0];
  assert.equal(rec.provider, 'WIKIPEDIA', 'the first provider stays the record provider');
  assert.deepEqual(rec.alsoBy, ['JINA WEB'], 'every other discovering provider is provenance');
  assert.equal(rec.snippet, 'mathematician', 'the first snippet wins');
  reg.addSearchRecord(searchRec(fmt('JINA WEB', 'again', 'https://en.wikipedia.org/wiki/Ada_Lovelace', 'third')));
  assert.deepEqual(reg.snapshot()[0].alsoBy, ['JINA WEB'], 'a repeat provider is not listed twice');
  console.log('ok  : multi-provider discovery keeps one record plus alsoBy');
}

// ── addEvidence ──
{
  const reg = createSourceRegistry();
  reg.addSearchRecord(searchRec(fmt('ESPN', 'Leaders', 'https://www.espn.com/nba/stats', 'points leaders')), 'initial');
  const ev = { field: 'career points', value: 40474, unit: 'points', scope: 'regular season', excerpt: 'all-time scoring list' };
  const rec = reg.addEvidence('s1', ev);
  assert.equal(rec.id, 's1', 'addEvidence returns the record');
  assert.deepEqual(reg.snapshot()[0].evidence, [ev], 'the evidence unit is attached verbatim');
  reg.addEvidence('s1', { field: 'career points', value: 40474, period: '2026' });
  assert.equal(reg.snapshot()[0].evidence.length, 2, 'evidence units accumulate');
  assert.equal(reg.addEvidence('s9', ev), null, 'unknown id -> null, never a throw');
  const snap = reg.snapshot();
  snap[0].evidence.push({ field: 'tamper' });
  assert.equal(reg.snapshot()[0].evidence.length, 2, 'evidence in snapshots is copied');
  console.log('ok  : addEvidence attaches units to a source by id');
}

// ── page records ──
{
  const reg = createSourceRegistry();
  const page = {
    ok: true,
    url: 'https://www.nba.com/stats/leaders',
    finalUrl: 'https://www.nba.com/stats/leaders',
    title: 'NBA Stats',
    text: '  Career   points leaders\n  LeBron James 40474  ',
    headings: [],
    tables: [],
    publishedAt: '2026-09-01',
  };
  const rec = reg.addPage(page);
  assert.equal(rec.id, 's1');
  assert.equal(rec.provider, 'read', "a directly read page is provider 'read'");
  assert.equal(rec.origin, 'auto-read');
  assert.equal(rec.status, 'ok');
  assert.equal(rec.title, 'NBA Stats');
  assert.equal(rec.publishedAt, '2026-09-01', 'publishedAt carried when the page has one');
  assert.equal(typeof rec.fetchedAt, 'number', 'a read page is fetched');
  assert.equal(rec.snippet, 'Career points leaders LeBron James 40474', 'excerpt collapses whitespace');
  assert.deepEqual(supporting(reg.snapshot()).map((r) => r.id), ['s1'], 'a read page supports');

  const reg2 = createSourceRegistry();
  reg2.addSearchRecord(searchRec(fmt('JINA WEB', 'NBA Stats', 'https://www.nba.com/stats/leaders/', 'search snippet')), 'initial');
  assert.equal(reg2.snapshot()[0].fetchedAt, undefined, 'a search hit is not fetched yet');
  const promoted = reg2.addPage({ ok: true, url: 'https://www.nba.com/stats/leaders', finalUrl: 'https://www.nba.com/stats/leaders', title: 'NBA Stats', text: 'full body' });
  assert.equal(reg2.size(), 1, 'reading a discovered URL does not duplicate it');
  assert.equal(promoted.id, 's1', 'the read promotes the existing record');
  assert.equal(promoted.provider, 'JINA WEB', 'the discovering provider survives the read');
  assert.deepEqual(promoted.alsoBy, ['read'], 'the read is recorded as provenance');
  assert.equal(promoted.snippet, 'search snippet', 'the first snippet survives the read');
  assert.equal(typeof promoted.fetchedAt, 'number');
  assert.equal(reg2.addPage(null), null, 'a page without a url is ignored');

  const reg3 = createSourceRegistry();
  const moved = reg3.addPage({ ok: true, url: 'http://example.com/old', finalUrl: 'https://example.com/new', title: 'Moved', text: 'body' });
  assert.equal(moved.url, 'https://example.com/new', 'the record is keyed by the final URL');
  reg3.addSearchRecord(searchRec(fmt('MWMBL', 'Moved', 'http://example.com/old', 'hit')));
  assert.equal(reg3.size(), 1, 'the pre-redirect URL resolves to the same record');
  assert.equal(reg3.snapshot()[0].id, moved.id, 'the alias keeps the original id');
  console.log('ok  : addPage records reads, promotes search hits, follows redirects');
}

// ── read-failure records ──
{
  const reg = createSourceRegistry();
  const blocked = reg.addReadFailure('https://www.nba.com/blocked-page', 'blocked');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.provider, 'read');
  assert.equal(blocked.snippet, '');
  assert.equal(reg.addReadFailure('https://gone.example/1', 'weird').status, 'failed', 'unknown status degrades to failed');
  assert.equal(reg.addReadFailure(''), null, 'a failure without a url is ignored');
  assert.deepEqual(supporting(reg.snapshot()), [], 'failed reads never support a fact');

  const reg2 = createSourceRegistry();
  reg2.addSearchRecord(searchRec(fmt('WIKIPEDIA', 'Ada', 'https://en.wikipedia.org/wiki/Ada', 'snippet')));
  const same = reg2.addReadFailure('https://en.wikipedia.org/wiki/Ada', 'blocked');
  assert.equal(same.id, 's1', 'a failed read of a known URL is not a new record');
  assert.equal(same.status, 'ok', 'a failed read never demotes a discovered source');
  assert.equal(reg2.size(), 1, 'no duplicate record either');
  assert.equal(reg2.snapshot()[0].alsoBy, undefined, 'a failed read adds no provenance');
  console.log('ok  : addReadFailure records outcomes without demoting sources');
}

// ── snapshot ordering + supporting() ──
{
  const reg = createSourceRegistry();
  reg.addSearchRecord(searchRec(fmt('A', 'One', 'https://a.example/1', 'a')), 'initial');           // s1 ok
  reg.addReadFailure('https://blocked.example/page', 'blocked');                                    // s2 blocked
  reg.addSearchRecord(searchRec(fmt('B', 'Two', 'https://b.example/2', 'b')), 'follow-up');          // s3 ok
  reg.addReadFailure('https://gone.example/page', 'failed');                                        // s4 failed
  reg.addPage({ ok: true, url: 'https://c.example/3', title: 'Three', text: 'read body' });          // s5 ok
  reg.addReadFailure('https://blank.example/page', 'empty');                                        // s6 empty
  const snap = reg.snapshot();
  assert.deepEqual(snap.map((r) => r.status), ['ok', 'ok', 'ok', 'blocked', 'failed', 'empty'], 'ok records come first');
  assert.deepEqual(snap.map((r) => r.id), ['s1', 's3', 's5', 's2', 's4', 's6'], 'each group keeps insertion order');
  assert.equal(reg.size(), 6);
  assert.deepEqual(supporting(snap).map((r) => r.id), ['s1', 's3', 's5'], 'supporting() keeps only ok records');
  assert.deepEqual(supporting(null), [], 'supporting() tolerates a missing snapshot');
  console.log('ok  : snapshot() orders ok first, supporting() filters the rest out');
}

console.log('ALL SOURCES REGISTRY PASS');

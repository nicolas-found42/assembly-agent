// search-read.test.mjs — TDD contract for the read path of js/search.js:
// readPage/parseReaderPage/assertReadableUrl, the per-result JINA parsing, and
// the smartSlice relevance filter. No real network; transport faked by URL
// substring (reader URL first, target URL second: the reader URL contains the
// target, so insertion order decides which fixture matches).

import assert from 'node:assert/strict';

// ── browser shims ──
globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost:8000' };
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => { } } };
globalThis.localStorage = {};
globalThis.sessionStorage = {
  _s: Object.create(null),
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
  clear() { this._s = Object.create(null); }
};
globalThis.sessionStorage.clear();
if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };

const mod = await import('../js/search.js');
const { webSearch, smartSlice, readPage, parseReaderPage, assertReadableUrl, parseJinaResults, decodeReaderLink, jinaLimiter } = mod;

// fake transport keyed by URL substring
function makeFake(map, counts = {}) {
  return async (url) => {
    for (const [sub, payload] of Object.entries(map)) {
      if (!url.includes(sub)) continue;
      counts[sub] = (counts[sub] || 0) + 1;
      if (payload && payload.__error) throw new Error(payload.msg || 'network down');
      if (payload && payload.__status) return { ok: false, status: payload.__status, url, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
      const isStr = typeof payload === 'string';
      return {
        ok: true, status: 200, url,
        headers: { get: () => (isStr ? 'text/plain; charset=utf-8' : 'application/json') },
        json: async () => (isStr ? JSON.parse(payload) : payload),
        text: async () => (isStr ? payload : JSON.stringify(payload))
      };
    }
    return { ok: true, status: 200, url, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
  };
}
const resetLimiter = () => { if (jinaLimiter && jinaLimiter._reset) jinaLimiter._reset(); globalThis.sessionStorage.clear(); };

// ── assertReadableUrl ──
{
  assert.equal(assertReadableUrl('https://example.com/page'), true, 'public https allowed');
  assert.equal(assertReadableUrl('http://example.com/page?q=1'), true, 'public http allowed');
  assert.equal(assertReadableUrl('https://user:pass@example.com/'), false, 'userinfo rejected');
  assert.equal(assertReadableUrl('http://user@example.com/'), false, 'bare username rejected');
  assert.equal(assertReadableUrl('http://localhost:8080/x'), false, 'localhost rejected');
  assert.equal(assertReadableUrl('http://sub.localhost/x'), false, 'localhost subdomain rejected');
  assert.equal(assertReadableUrl('http://127.0.0.1/x'), false, '127.0.0.1 rejected');
  assert.equal(assertReadableUrl('http://127.1/x'), false, '127.1 rejected');
  assert.equal(assertReadableUrl('http://10.0.0.5/x'), false, '10.x rejected');
  assert.equal(assertReadableUrl('http://172.16.3.4/x'), false, '172.16 rejected');
  assert.equal(assertReadableUrl('http://172.31.9.9/x'), false, '172.31 rejected');
  assert.equal(assertReadableUrl('http://172.32.0.1/x'), true, '172.32 is outside the private block');
  assert.equal(assertReadableUrl('http://192.168.1.10/x'), false, '192.168.x rejected');
  assert.equal(assertReadableUrl('http://169.254.169.254/latest/meta-data/'), false, 'link-local metadata rejected');
  assert.equal(assertReadableUrl('http://[::1]/x'), false, 'IPv6 loopback rejected');
  assert.equal(assertReadableUrl('http://[fc00::1]/x'), false, 'IPv6 ULA rejected');
  assert.equal(assertReadableUrl('http://2130706433/x'), false, 'decimal IP rejected');
  assert.equal(assertReadableUrl('javascript:alert(1)'), false, 'javascript: rejected');
  assert.equal(assertReadableUrl('file:///etc/passwd'), false, 'file: rejected');
  assert.equal(assertReadableUrl('data:text/html,<b>x</b>'), false, 'data: rejected');
  assert.equal(assertReadableUrl(''), false, 'empty rejected');
  assert.equal(assertReadableUrl(null), false, 'null rejected');
}
console.log('assertReadableUrl PASS');

// ── readPage: direct GET first (plain request, credentials omitted) ──
{
  const seen = [];
  const transport = async (url, opts = {}) => {
    seen.push({ url, opts });
    return {
      ok: true, status: 200, url,
      headers: { get: (k) => (k === 'content-type' ? 'text/markdown; charset=utf-8' : '') },
      text: async () => '# Release notes\n\nThe API returns `ok` since 2024.\n\nUpdated 2024-05-06\n'
    };
  };
  const r = await readPage('https://example.com/notes', { transport });
  assert.equal(r.ok, true, 'direct read ok');
  assert.equal(r.url, 'https://example.com/notes', 'url echoed');
  assert.equal(r.finalUrl, 'https://example.com/notes', 'finalUrl from the response');
  assert.equal(seen.length, 1, 'no reader fallback when the direct read works');
  assert.equal(seen[0].opts.credentials, 'omit', 'credentials omitted');
  assert.ok(!('headers' in seen[0].opts), 'no custom headers on the direct GET');
  assert.ok(r.text.includes('The API returns'), 'body text kept');
  assert.deepEqual(r.headings, [{ level: 1, text: 'Release notes' }], 'heading parsed');
  assert.equal(r.updatedAt, '2024-05-06', 'date stated by the page');
  assert.ok(r.tables.length === 0, 'no phantom table');
}
console.log('readPage direct PASS');

// ── readPage: direct fetch of HTML (a page that allows cross-origin reads) ──
{
  const html = '<!doctype html><html><head><title>Doc</title><style>p{color:red}</style></head><body>'
    + '<h1>Doc</h1><p>Hello &amp; welcome</p>'
    + '<table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>'
    + '<script>window.x=1</script></body></html>';
  const counts = {};
  const r = await readPage('https://example.com/html', { transport: makeFake({ 'https://example.com/html': html }, counts) });
  assert.equal(r.ok, true, 'direct html read ok');
  assert.equal(r.title, 'Doc', 'title tag');
  assert.deepEqual(r.headings, [{ level: 1, text: 'Doc' }], 'html heading');
  assert.deepEqual(r.tables, [{ headers: ['K', 'V'], rows: [['a', '1']] }], 'html table');
  assert.ok(r.text.includes('Hello & welcome'), 'entities decoded');
  assert.ok(!r.text.includes('window.x'), 'script content dropped');
  assert.equal(counts['https://example.com/html'], 1, 'single direct fetch');
}
console.log('readPage html PASS');

// ── readPage: reader fallback keeps the answer past the old 800-char cap ──
{
  const filler = 'Paragraph text. '.repeat(205); // ~3300 chars before the answer
  const answer = 'The answer you asked for is 42.';
  const table = '| Team | Points |\n| --- | --- |\n| A | 10 |\n| B | 20 |\n| C | 30 |\n';
  const body = 'Title: Long page\n\nURL Source: https://example.com/long\n\nPublished Time: 2024-01-02\n\nMarkdown Content:\n\n'
    + `# Overview\n\n${filler}\n\n${answer}\n\n## Result table\n\n${table}`;
  const counts = {};
  resetLimiter();
  const r = await readPage('https://example.com/long', {
    transport: makeFake({
      'r.jina.ai/https://example.com/long': body,
      'https://example.com/long': { __error: true, msg: 'CORS' }
    }, counts)
  });
  assert.equal(r.ok, true, 'reader read ok');
  assert.equal(r.title, 'Long page', 'reader title header');
  assert.equal(r.publishedAt, '2024-01-02', 'reader published header');
  assert.equal(r.finalUrl, 'https://example.com/long', 'finalUrl from the URL Source header');
  assert.equal(counts['https://example.com/long'], 1, 'direct GET tried first');
  assert.equal(counts['r.jina.ai/https://example.com/long'], 1, 'reader fetched once');
  assert.ok(r.text.indexOf(answer) > 800, `answer sits past 800 chars (at ${r.text.indexOf(answer)})`);
  assert.ok(r.text.includes(answer), 'answer content preserved by the page read');
  assert.ok(r.headings.some((h) => h.text === 'Overview') && r.headings.some((h) => h.text === 'Result table'), 'headings parsed');
  assert.deepEqual(r.tables, [{ headers: ['Team', 'Points'], rows: [['A', '10'], ['B', '20'], ['C', '30']] }], 'table header + rows kept together');
  assert.ok(r.text.includes('| C | 30 |'), 'table stays in the text it bounds');
  assert.ok(!('urlSource' in r), 'reader URL Source is reported as finalUrl, not a field');
}
console.log('readPage reader fallback PASS');

// ── readPage: truncation never splits a table from its header ──
{
  const filler = 'A filler line of prose. '.repeat(1000); // ~25k chars
  const table = '| Model | Year |\n| --- | --- |\n| One | 2024 |\n| Two | 2025 |\n';
  const body = `Markdown Content:\n\n${filler}\n${table}`;
  const page = parseReaderPage(body);
  assert.ok(page.text.length <= 24000, `bounded text (${page.text.length})`);
  assert.deepEqual(page.tables, [{ headers: ['Model', 'Year'], rows: [['One', '2024'], ['Two', '2025']] }], 'table parsed whole from the full body');
  assert.ok(!page.text.includes('| One | 2024 |'), 'a straddling table is not half-included in the text');
  assert.ok(!/Model \| Year/.test(page.text), 'no partial header row in the text');
}
console.log('table intact at the cap PASS');

// ── readPage: the reader path shares the jina limiter ──
{
  resetLimiter();
  const orig = jinaLimiter.take.bind(jinaLimiter);
  let takes = 0;
  jinaLimiter.take = async () => { takes++; return orig(); };
  const r = await readPage('https://example.com/lim', {
    transport: makeFake({
      'r.jina.ai/https://example.com/lim': 'Title: x\n\nMarkdown Content:\n\ncontent that parses',
      'https://example.com/lim': { __error: true }
    })
  });
  jinaLimiter.take = orig;
  assert.equal(r.ok, true, 'reader read ok');
  assert.equal(takes, 1, 'reader path takes the shared 20/min jina limiter');
}
console.log('readPage limiter PASS');

// ── readPage failure outcomes are never evidence ──
{
  // HTTP 200 challenge page
  resetLimiter();
  const r1 = await readPage('https://example.com/cf', {
    transport: makeFake({
      'r.jina.ai/https://example.com/cf': 'Title: Just a moment...\n\nMarkdown Content:\n\nEnable JavaScript and cookies to continue\n',
      'https://example.com/cf': { __error: true, msg: 'CORS' }
    })
  });
  assert.equal(r1.ok, false, 'challenge page is not ok');
  assert.equal(r1.status, 'blocked', 'challenge page status blocked');
  assert.ok(!('text' in r1), 'no evidence text on a blocked read');

  // reader abuse block (403 JSON) vs a plain failure (404) vs empty body
  resetLimiter();
  const r2 = await readPage('https://example.com/x', {
    transport: makeFake({
      'r.jina.ai/https://example.com/x': { __status: 403 }, 'https://example.com/x': { __error: true }
    })
  });
  assert.equal(r2.status, 'blocked', 'reader 403 is a block');
  assert.equal(r2.ok, false, 'reader 403 not ok');
  resetLimiter();
  const r3 = await readPage('https://example.com/y', {
    transport: makeFake({
      'r.jina.ai/https://example.com/y': { __status: 404 }, 'https://example.com/y': { __error: true }
    })
  });
  assert.equal(r3.status, 'failed', 'reader 404 is a failure');
  resetLimiter();
  const r4 = await readPage('https://example.com/e', {
    transport: makeFake({
      'r.jina.ai/https://example.com/e': '  \n   ', 'https://example.com/e': { __error: true }
    })
  });
  assert.equal(r4.ok, false, 'empty reader text is not ok');
  assert.equal(r4.status, 'empty', 'empty status');
  resetLimiter();
  const r5 = await readPage('https://example.com/n', {
    transport: makeFake({
      'r.jina.ai/https://example.com/n': { __error: true, msg: 'offline' }, 'https://example.com/n': { __error: true }
    })
  });
  assert.equal(r5.status, 'failed', 'unreachable reader is a failure');
  assert.ok(!('text' in r5), 'no evidence text on a failed read');
}
console.log('readPage failure outcomes PASS');

// ── readPage: unreadable URLs are never fetched ──
{
  let called = 0;
  const transport = async (url) => { called++; return { ok: true, status: 200, url, headers: { get: () => '' }, text: async () => 'x' }; };
  const r = await readPage('http://127.0.0.1:9999/admin', { transport });
  assert.equal(r.ok, false, 'private host not read');
  assert.equal(r.status, 'error', 'error status for an unreadable url');
  assert.equal(r.url, 'http://127.0.0.1:9999/admin', 'url echoed');
  assert.equal(called, 0, 'no fetch attempted for an unreadable url');
  const r2 = await readPage('javascript:alert(1)', { transport });
  assert.equal(r2.status, 'error', 'non-http scheme never fetched');
  assert.equal(called, 0, 'still no fetch');
}
console.log('readPage url gate PASS');

// ── parseReaderPage: header block, headings, tables, dates, malformed input ──
{
  const page = parseReaderPage('Title: Example page\n\nURL Source: https://example.com/p\n\nPublished Time: 2024-01-02\n\nMarkdown Content:\n\n# One\n\ntext\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  assert.equal(page.title, 'Example page', 'title header');
  assert.equal(page.urlSource, 'https://example.com/p', 'url source header');
  assert.equal(page.publishedAt, '2024-01-02', 'published header');
  assert.deepEqual(page.headings, [{ level: 1, text: 'One' }], 'heading');
  assert.deepEqual(page.tables, [{ headers: ['A', 'B'], rows: [['1', '2']] }], 'table');
  assert.ok(page.text.startsWith('# One'), 'header block stripped from the text');
  assert.ok(!page.text.includes('URL Source'), 'no header leakage into the text');
  assert.ok(!('updatedAt' in page) && !('dataAsOf' in page), 'absent dates stay absent');
  assert.equal(parseReaderPage('Data as of Jan 3, 2024: population 4.1M').dataAsOf, 'Jan 3, 2024', 'as-of date sniffed from the text');
  assert.equal(parseReaderPage(null).text, '', 'null tolerated');
  assert.deepEqual(parseReaderPage(undefined).tables, [], 'undefined tolerated');
  // malformed markdown cannot throw and cannot half-parse a table
  const weird = 'Title: broken\n\nMarkdown Content:\n| x | y |\n| --- | nope |\n\u0000\u0001 odd \uFFFD\n# \n#######\n[unclosed\n';
  const m = parseReaderPage(weird);
  assert.equal(typeof m.text, 'string', 'malformed text still yields a string');
  assert.equal(m.tables.length, 0, 'a table without a separator row is dropped, not half-parsed');
  resetLimiter();
  const r = await readPage('https://example.com/m', {
    transport: makeFake({
      'r.jina.ai/https://example.com/m': weird, 'https://example.com/m': { __error: true }
    })
  });
  assert.equal(r.ok, true, 'malformed but non-empty content still reads');
  assert.ok(r.text.length > 0, 'text present');
}
console.log('parseReaderPage PASS');

// ── JINA results: real destination URLs, wrapper never the source ──
{
  const serp = 'Title: query at DuckDuckGo\n\nURL Source: https://lite.duckduckgo.com/lite/?q=query\n\nMarkdown Content:\n'
    + '1.[First result](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FFirst&rut=abc)\nFirst description\nen.wikipedia.org\n'
    + `2.[Second result](https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/second?q=1&x=2')}&rut=def)\nSecond description\nexample.com\n`
    + '3.[Sponsored](https://duckduckgo.com/y.js?ad_provider=bing&u=3)\nAd copy here\n'
    + '4.[Settings](https://duckduckgo.com/settings)\n'
    + '*[Bullet result](https://example.org/bullet)\nBullet description\n';
  const results = parseJinaResults(serp);
  assert.equal(results.length, 3, 'numbered and bullet results kept, ad and nav dropped');
  assert.equal(results[0].url, 'https://en.wikipedia.org/wiki/First', 'uddg destination decoded');
  assert.equal(results[0].title, 'First result', 'link text is the title');
  assert.equal(results[0].snippet, 'First description', 'description line is the snippet');
  assert.equal(results[1].url, 'https://example.com/second?q=1&x=2', 'destination query params survive the decode');
  assert.equal(results[2].url, 'https://example.org/bullet', 'bullet line parses');
  assert.ok(!results.some((r) => r.url.includes('uddg')), 'no wrapper URL survives');
  assert.ok(!results.some((r) => r.url.includes('duckduckgo.com')), 'no DuckDuckGo nav/wrapper URL survives');
  assert.ok(!results.some((r) => /sponsored|settings/i.test(r.title)), 'ad and nav titles dropped');

  const many = Array.from({ length: 9 }, (_, i) => `${i + 1}.[R${i}](https://example.com/r${i})\n`).join('');
  assert.equal(parseJinaResults(many).length, 5, 'capped at 5 results');
  assert.deepEqual(parseJinaResults('no links at all here'), [], 'plain text yields no results');
  assert.deepEqual(parseJinaResults(''), [], 'empty yields no results');
  assert.equal(decodeReaderLink('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x'), 'https://example.com/a?b=1', 'wrapper decoded');
  assert.equal(decodeReaderLink('javascript:alert(1)'), '', 'non-http href rejected');
  assert.equal(decodeReaderLink('https://duckduckgo.com/l/?rut=x'), '', 'wrapper without uddg rejected');
}
console.log('parseJinaResults PASS');

// ── webSearch: one JINA WEB block per result, real URLs in the markdown ──
{
  resetLimiter();
  const serp = 'Title: python at DuckDuckGo\n\nURL Source: https://lite.duckduckgo.com/lite/?q=python\n\nMarkdown Content:\n'
    + `1.[python programming guide](https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://docs.example.com/python')}&rut=1)\npython programming reference\n`
    + `2.[python programming course](https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://courses.example.com/py')}&rut=2)\npython programming lessons\n`;
  const transport = makeFake({ 'r.jina.ai/https://lite.duckduckgo.com': serp, 'endoflife.date/api/all.json': [] });
  const r = await webSearch('python programming results', { transport });
  assert.equal((r.markdown.match(/### \[JINA WEB\]/g) || []).length, 2, 'one block per result');
  assert.ok(r.markdown.includes('https://docs.example.com/python'), 'decoded destination URL is the block URL');
  assert.ok(!r.markdown.includes('uddg='), 'the redirect wrapper never reaches the markdown');
  assert.ok(r.markdown.includes('— via Jina Reader'), 'attribution kept on every result');
  const ps = r.perSource.find((p) => p.tag === 'JINA WEB');
  assert.ok(ps && ps.hits === 2, 'perSource counts both JINA WEB hits');
}
console.log('jinaweb per-result PASS');

// ── smartSlice: relevance filter ──
{
  const block = (tag, title, url, snip) => `### [${tag}] ${title}\n${url}\n${snip}\n\n`;
  const scored = block('JINA WEB', 'python guide', 'https://python.example', 'python python');
  const noise = block('WIKIPEDIA', 'kubernetes', 'https://k8s.example', 'containers and pods');
  const filtered = smartSlice(noise + scored, 'python', 20000);
  assert.ok(filtered.includes('https://python.example'), 'scored block kept');
  assert.ok(!filtered.includes('https://k8s.example'), 'zero-overlap block dropped when a scored block exists');
  const kept = smartSlice(noise, 'python', 20000);
  assert.ok(kept.includes('https://k8s.example'), 'top block kept when nothing scores');
  assert.ok(smartSlice(noise, '', 10).length > 0, 'non-empty input never yields an empty slice');
  assert.equal(smartSlice('', 'python', 100), '', 'empty input still yields empty');
}
console.log('smartSlice relevance PASS');

console.log('ALL SEARCH READ PASS');

// fixtures/upstream.mjs — synthetic payloads for every external origin the app
// contacts, in the exact shapes the app's own parsing code reads.
//
// Data only, no server, no imports: test/browser/fixture-server.mjs serves it
// and test/browser/lib/network.mjs reads UPSTREAM_HOSTS from it, so the routing
// table and the fixture table cannot drift apart.
//
// Field sources (read from the app, not guessed):
//   openrouter.ai        js/models.js toRecords(), js/main.js Settings "Test"
//   en.wikipedia.org     js/search.js wikipedia(), cepSource(), wikiOpenSearchSource()
//   hn.algolia.com       js/search.js hackernews()
//   api.stackexchange.com js/search.js stackexchange()
//   api.github.com       js/search.js github()
//   www.wikidata.org     js/search.js wikidata()
//   api.openalex.org     js/search.js openalex()
//   api.crossref.org     js/search.js crossref()
//   doaj.org             js/search.js doaj()
//   openlibrary.org      js/search.js openlibrary()
//   lookup.dbpedia.org   js/search.js dbpedia()
//   lobste.rs            js/search.js lobsters()
//   endoflife.date       js/search.js endoflifeSource()
//   www.basketball-reference.com  js/search.js readPage() direct read (SERP destinations)
//   r.jina.ai            js/search.js jinaHelper(), readPage() reader fallback
//   api.duckduckgo.com   js/search.js ddgiaSource()
//   api.openverse.org    js/search.js openverseSource()
//   api.mwmbl.org        js/search.js mwmblSource()
//   api.tvmaze.com       js/search.js tvmazeSource()
//   query.wikidata.org   js/search.js wdqsSource()
//   api.dictionaryapi.dev js/search.js dictionarySource()
//   api.coingecko.com    js/search.js coingeckoSource()
//   api.frankfurter.dev  js/search.js frankfurterSource()
//   geocoding-api.open-meteo.com / api.open-meteo.com  js/search.js getGeo(), openmeteoSource()
//   api.worldbank.org    js/search.js worldbankSource()
//   site.api.espn.com    js/search.js espn()
//   statsapi.mlb.com     js/search.js mlbSource()

export const JSON_CT = 'application/json; charset=utf-8';

const asJson = (body, contentType = JSON_CT) => ({ body: JSON.stringify(body), contentType });
const asText = (body) => ({ body, contentType: 'text/plain; charset=utf-8' });

// ── synthetic model catalog (OpenRouter /api/v1/models shape) ───────────────
// js/models.js toRecords() reads id, name, context_length, created,
// pricing.{prompt,completion}, architecture.{input,output}_modalities and
// supported_parameters. newestFreeModelId() picks the greatest `created` among
// records that are free, end in ':free' and produce text — the image-only record
// below is deliberately newer, so a broken filter is visible in a test.
export const DEFAULT_CATALOG = [
  {
    id: 'asm/synthetic-image:free', name: 'Synthetic Image', context_length: 8192, created: 1900000500,
    pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['image'] },
    supported_parameters: [],
  },
  {
    id: 'asm/synthetic-flagship:free', name: 'Synthetic Flagship', context_length: 131072, created: 1900000000,
    pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'reasoning'],
  },
  {
    id: 'asm/synthetic-mini:free', name: 'Synthetic Mini', context_length: 32768, created: 1800000000,
    pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['tools'],
  },
  {
    id: 'asm/synthetic-paid', name: 'Synthetic Paid', context_length: 65536, created: 1850000000,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['tools'],
  },
];

/** Rank maps for the two sorted catalog variants js/models.js also fetches. */
export const DEFAULT_RANK = {
  latency: ['asm/synthetic-mini:free', 'asm/synthetic-flagship:free', 'asm/synthetic-paid', 'asm/synthetic-image:free'],
  throughput: ['asm/synthetic-flagship:free', 'asm/synthetic-mini:free', 'asm/synthetic-paid', 'asm/synthetic-image:free'],
};

/** Newest free text model of DEFAULT_CATALOG — what the app must select. */
export const EXPECTED_DEFAULT_MODEL = 'asm/synthetic-flagship:free';

// One sentence, no denial phrase, no second prose sentence: the STE wording
// pass (js/ste.js needs >=2 sentences) and the Hedge Pass (js/guard.js) both
// stay out of the way, so a turn is exactly one model round.
export const DEFAULT_ANSWER = 'The synthetic catalog answered this question from fixture data.';

// ── r.jina.ai: the reader, routed by its target ──────────────────────────
// js/search.js jinaHelper() fetches r.jina.ai/<target-url> (the path after the
// host IS the target) and readPage() falls back to the same reader for any
// destination a direct read cannot serve, so this handler answers by target:
// DuckDuckGo's lite SERP as a reader render of numbered results, every other
// target as the leaderboard page those results rank. The SERP's destination
// URLs are fixture pages too (www.basketball-reference.com in the table below)
// with this same render behind them, so either read path lands on the answer.

const READER_RESULTS = [
 ['NBA career scoring leaders — Basketball-Reference.com',
  'https://www.basketball-reference.com/leaders/nba_career_pts.html',
  'Career points totals for every player in NBA history.'],
 ['NBA active career scoring leaders — Basketball-Reference.com',
  'https://www.basketball-reference.com/leaders/nba_career_pts_active.html',
  'Career points totals among active players.'],
 ['NBA leaders and records index — Basketball-Reference.com',
  'https://www.basketball-reference.com/leaders/',
  'Every career leaderboard in NBA history.'],
];

/** Reader render for a plain destination page: title from the path, several
 *  paragraphs of neutral text so the answer sits past the first 800 chars. */
const plainPage = (target) => {
 const title = decodeURIComponent((target.split('/').pop() || 'synthetic').replace(/[-_]/g, ' '));
 return `Title: ${title}
URL Source: ${target}
Markdown Content:
This synthetic page is served by the test fixture server for the destinations the fixture corpus itself advertises. Its prose exists so the application's page reads resolve instead of failing. The paragraphs are deliberately plain so a reader that parses headings and text sees a real page's shape.
The page carries several paragraphs of neutral synthetic text. Nothing here is an instruction to the application, and nothing here pretends to be evidence it is not.
## Notes
The notes section marks the page's own structure so heading parsing sees the same shape as a real article.
`;
};

/** Reader render of DuckDuckGo's lite SERP: numbered markdown results behind
 *  DDG's /l/?uddg= redirect, which js/search.js parseJinaResults() decodes to
 *  the real destination URL. */
const serpPage = () => {
 const lines = ['Title: DuckDuckGo Lite', 'URL Source: https://lite.duckduckgo.com/lite/', 'Markdown Content:'];
 READER_RESULTS.forEach(([title, dest, snippet], i) => {
  const rut = (0x4f1a2b + i * 0x7d31).toString(16);
  lines.push(`${i + 1}.[${title}](https://duckduckgo.com/l/?uddg=${encodeURIComponent(dest)}&rut=${rut})`);
  lines.push(snippet);
 });
 return `${lines.join('\n')}\n`;
};

/** The pages the leaderboard results rank: the answer is a points table well
 *  below the fold, so a reader that stops at the first paragraphs never sees
 *  it. readPage() may fetch this render directly or through r.jina.ai. */
const leaderboardPage = (target) => `Title: NBA Career Leaders and Records for Points
URL Source: ${target}
Markdown Content:
The NBA career scoring list ranks every player in league history by total points scored over regular-season games. The list has been kept since the league's first season, and only a small group of players has ever reached the top of it. The standings are refreshed after each game, so the totals below track the most recent completed season rather than any single night.
Scoring totals grow slowly because a career is long and the schedule is finite. Players near the top of the list appeared in many seasons and rarely missed games. The current leader passed the previous record holder during a regular-season game, and the gap to the rest of the field is expected to widen while that career continues.
Playoff points are tracked separately and are not part of these standings. Ties are broken by games played. The table below lists the current career leader.
# Career points leaders
| Player | Points |
| --- | --- |
| LeBron James | 42184 |

Records cover regular-season games only. Totals are refreshed after each game.
`;

// ── upstream fixture table: host -> (pathname, searchParams) => shape|null ──
export const UPSTREAM = {
  'en.wikipedia.org': (pathname, q) => {
    if (pathname === '/w/api.php') {
      if (q.get('action') === 'opensearch') {
        return asJson([
          q.get('search') || 'synthetic',
          ['Synthetic Article', 'Synthetic Second Article'],
          ['Synthetic description one.', 'Synthetic description two.'],
          ['https://en.wikipedia.org/wiki/Synthetic_Article', 'https://en.wikipedia.org/wiki/Synthetic_Second_Article'],
        ]);
      }
      if (q.get('action') === 'parse') {
        return asJson({ parse: { text: { '*': '<li>Synthetic current event one.</li><li>Synthetic current event two.</li>' } } });
      }
      return asJson({
        query: {
          search: [
            { title: 'Synthetic Article', snippet: 'A <span class="searchmatch">synthetic</span> snippet.' },
            { title: 'Synthetic Second Article', snippet: 'Another synthetic snippet.' },
          ],
        },
      });
    }
    if (pathname.startsWith('/wiki/')) {
      const title = decodeURIComponent(pathname.replace('/wiki/', '').replace(/_/g, ' '));
      return asText(`Title: ${title}
URL Source: https://en.wikipedia.org${pathname}
Markdown Content:
${title} is a synthetic fixture article served by the test fixture server. Its prose exists so the application's page reads resolve instead of 404ing. The article carries several paragraphs of neutral synthetic text so its answer sits well past the first 800 characters, matching how real articles place their facts below the fold. The subject is described in plain sentences and carries no special structure beyond a short summary section near the end.
## Summary
The article states one plain fact about itself so a reader that parses headings and text sees the same shape as a real page.
`);
    }
    if (pathname.startsWith('/api/rest_v1/page/summary/')) {
      return asJson({ extract: 'A synthetic summary for the fixture article.', type: 'standard' });
    }
    return null;
  },

  'hn.algolia.com': () => asJson({
    hits: [{ title: 'Synthetic HN story', url: 'https://example.invalid/hn-story', objectID: '1', points: 12, num_comments: 3 }],
  }),

  'api.stackexchange.com': () => asJson({
    items: [{
      title: 'Synthetic Stack Overflow question',
      link: 'https://stackoverflow.com/q/1',
      body: '<p>A synthetic body.</p>',
      score: 5,
      is_answered: true,
      answer_count: 2,
    }],
    quota_remaining: 300,
  }),

  'api.github.com': () => asJson({
    items: [{
      full_name: 'synthetic/fixture-repo',
      html_url: 'https://github.com/synthetic/fixture-repo',
      stargazers_count: 42,
      description: 'A synthetic repository.',
    }],
  }),

  'www.wikidata.org': () => asJson({
    search: [{
      id: 'Q1',
      label: 'Synthetic Entity',
      description: 'a fixture entity',
      concepturi: 'http://www.wikidata.org/entity/Q1',
      match: { type: 'label', text: 'Synthetic Entity' },
    }],
  }),

  'api.openalex.org': () => asJson({
    results: [{
      id: 'https://openalex.org/W1',
      display_name: 'Synthetic OpenAlex work',
      doi: 'https://doi.org/10.0000/synthetic',
      publication_year: 2024,
      authorships: [{ author: { display_name: 'A. Fixture' } }],
      primary_location: { source: { display_name: 'Fixture Journal' } },
      cited_by_count: 7,
      open_access: { is_oa: true },
    }],
  }),

  'api.crossref.org': () => asJson({
    message: {
      items: [{
        DOI: '10.0000/synthetic',
        title: ['Synthetic Crossref work'],
        author: [{ given: 'A.', family: 'Fixture' }],
        URL: 'https://doi.org/10.0000/synthetic',
        'container-title': ['Fixture Journal'],
        abstract: '<jats:p>A synthetic abstract.</jats:p>',
        created: { 'date-parts': [[2024, 1, 1]] },
      }],
    },
  }),

  'doaj.org': () => asJson({
    results: [{
      bibjson: {
        title: 'Synthetic DOAJ article',
        identifier: [{ type: 'doi', id: '10.0000/synthetic' }],
        link: [{ url: 'https://example.invalid/doaj' }],
        journal: { title: 'Fixture Journal' },
        abstract: 'A synthetic abstract.',
        year: '2024',
      },
    }],
  }),

  'openlibrary.org': () => asJson({
    docs: [{
      key: '/works/OL1W',
      title: 'Synthetic Book',
      author_name: ['A. Fixture'],
      first_publish_year: 2020,
      cover_edition_key: 'OL1M',
    }],
  }),

  'lookup.dbpedia.org': () => asJson({
    docs: [{ resource: ['http://dbpedia.org/resource/Synthetic'], label: 'Synthetic', comment: 'A synthetic DBpedia comment.' }],
  }),

  'lobste.rs': () => asJson([{
    title: 'Synthetic lobste.rs story',
    url: 'https://example.invalid/lobsters',
    short_id: 'syn1',
    short_id_url: 'https://lobste.rs/s/syn1',
    score: 9,
    comment_count: 4,
    tags: ['synthetic'],
  }]),

  'endoflife.date': () => asJson(['nodejs', 'python', 'postgresql', 'synthetic-product']),

  // The SERP's destination pages: js/search.js readPage() fetches these
  // directly, and the r.jina.ai branch below serves the same render when a
  // direct read cannot. Every path returns the reader-shaped answer page.
  'www.basketball-reference.com': (pathname) => asText(leaderboardPage(`https://www.basketball-reference.com${pathname}`)),

  // r.jina.ai: the reader answers by target — the DuckDuckGo lite SERP, or the
  // leaderboard page the SERP's results read back through the same reader.
  'r.jina.ai': (pathname) => {
    const target = pathname.replace(/^\//, '');
    const bare = target.replace(/^https?:\/\//, '');
    return asText(bare.startsWith('lite.duckduckgo.com') ? serpPage() : leaderboardPage(target));
  },

  // Destinations the fixture corpus itself advertises: the drawer lists these
  // links, so the application's page reads fetch them. Every path returns a
  // small reader-shaped page, keeping reads hermetic like the SERP destinations.
  'example.invalid': (pathname) => asText(plainPage(`https://example.invalid${pathname}`)),
  'dbpedia.org': (pathname) => asText(plainPage(`http://dbpedia.org${pathname}`)),
  'www.coingecko.com': (pathname) => asText(plainPage(`https://www.coingecko.com${pathname}`)),

  'api.duckduckgo.com': () => asJson({
    Heading: 'Synthetic instant answer',
    AbstractText: 'A synthetic abstract from the fixture.',
    AbstractURL: 'https://example.invalid/ddg',
    AbstractSource: 'Synthetic Source',
    RelatedTopics: [{ Text: 'Synthetic related topic', FirstURL: 'https://example.invalid/ddg-related' }],
  }),

  'api.openverse.org': () => asJson({
    results: [{
      title: 'Synthetic image',
      foreign_landing_url: 'https://example.invalid/photo',
      creator: 'A. Fixture',
      license: 'cc0',
      license_version: '1.0',
      license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    }],
  }),

  'api.mwmbl.org': () => asJson({
    results: [{ title: 'Synthetic mwmbl result', url: 'https://example.invalid/mwmbl', extract: 'A synthetic extract.' }],
  }),

  'api.tvmaze.com': () => asJson([{
    score: 1,
    show: { id: 1, name: 'Synthetic Show', url: 'https://www.tvmaze.com/shows/1', summary: '<p>A synthetic summary.</p>' },
  }]),

  'query.wikidata.org': () => asJson({
    results: { bindings: [{ person: { value: 'http://www.wikidata.org/entity/Q2' }, personLabel: { value: 'Synthetic Person' } }] },
  }),

  'api.dictionaryapi.dev': () => asJson([
    { meanings: [{ definitions: [{ definition: 'A synthetic fixture definition.' }] }] },
  ]),

  'api.coingecko.com': (pathname, q) => {
    const body = {};
    for (const id of String(q.get('ids') || 'bitcoin').split(',').filter(Boolean)) body[id] = { usd: 12345 };
    return asJson(body);
  },

  'api.frankfurter.dev': (pathname, q) => asJson({ rates: { [String(q.get('to') || 'EUR').toUpperCase()]: 0.9 } }),

  'geocoding-api.open-meteo.com': () => asJson({
    results: [{ name: 'Syntheticville', latitude: 1.5, longitude: 2.5, country: 'Fixtureland' }],
  }),

  'api.open-meteo.com': () => asJson({ current: { temperature_2m: 21.5, weather_code: 1 } }),

  'api.worldbank.org': () => asJson([
    { page: 1 },
    [{ country: { value: 'Fixtureland' }, value: 123456, date: '2024' }],
  ]),

  'site.api.espn.com': () => asJson({
    events: [{
      id: '1',
      name: 'Synthetic vs Fixture',
      shortName: 'SYN vs FIX',
      competitions: [{
        competitors: [
          { team: { abbreviation: 'SYN', displayName: 'Synthetic' }, score: '1' },
          { team: { abbreviation: 'FIX', displayName: 'Fixture' }, score: '2' },
        ],
      }],
      status: 'Final',
    }],
  }),

  'statsapi.mlb.com': () => asJson({
    dates: [{
      games: [{
        gamePk: 1,
        teams: { away: { team: { name: 'Synthetic' } }, home: { team: { name: 'Fixture' } } },
        status: { detailedState: 'Final' },
        venue: { name: 'Fixture Park' },
      }],
    }],
  }),
};

/** Every external origin the fixture server answers, for the routing table.
 *  openrouter.ai is listed here rather than in the table above: its responses
 *  reflect the live catalog state, so the server owns that handler. */
export const UPSTREAM_HOSTS = ['openrouter.ai', ...Object.keys(UPSTREAM)].sort();

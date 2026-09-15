// research.js — query planning for the mandated pre-answer web search.
// Pure: zero imports, zero model calls, deterministic. Everything here runs
// before any bytes leave the browser, so the whole module is the search
// boundary: planQuery() decides WHAT is searched, minimizeQuery() decides how
// much of the user's words survive. planTask() is the structured plan on top
// of the same helpers (kind, entities, metrics, temporal, scope, facts) —
// tested in test/plan.test.mjs.
//
// Heuristic assumptions (deliberate, tested in test/research.test.mjs):
// - A message is a greeting when it is short and carries no task. Greetings
//   still search, with a harmless etiquette query instead of user text.
// - "continue"-style messages borrow the topic of the longest earlier user
//   message, which is the most substantive one in practice.
// - A writing ask with long or quoted personal material is treated as
//   private: the plan keeps the task kind ("how to write a clear email") and
//   drops the material itself.
// - A translation ask searches the target language plus the generic word
//   "translation"; the text being translated never reaches the query.

export const MAX_RESEARCH_ROUNDS = 5;

/** Last resort when nothing usable can be derived: harmless and generic. */
const FALLBACK_QUERY = 'general knowledge';

/** Greeting-only turn: about assistant behaviour, never about the user. */
const GREETING_QUERY = 'assistant greeting etiquette';

// ── minimization: what must never leave the browser ─────────────────────
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SK_RE = /\bsk-[A-Za-z0-9._-]{8,}\b/g;                    // sk-or-… and friends
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;       // Authorization headers
const LABELED_KEY_RE = /\b(?:api[-_ ]?key|token|secret)\s*[:=]\s*[A-Za-z0-9._-]{8,}/gi;
const TVLY_RE = /\btvly-[A-Za-z0-9._-]{6,}\b/g;                // Tavily
const BSA_RE = /\bBSA[A-Za-z0-9._-]{8,}\b/g;                   // Brave Search
const JINA_RE = /\bjina_[A-Za-z0-9._-]{6,}\b/g;                // Jina
// quoted spans longer than 80 characters are treated as pasted material
const LONG_QUOTE_RE = /"[^"]{80,}"|`[^`]{80,}`|“[^”]{80,}”/g;
// single quotes only when they open a span (never an apostrophe like can't)
const LONG_SINGLE_QUOTE_RE = /(^|[\s(])'[^']{80,}'(?=[\s).,!?]|$)/g;
const URL_QUERY_RE = /(https?:\/\/[^\s?]+)\?[^\s]*/g;

const MAX_TOKENS = 12;
const MAX_CHARS = 160;
// Filler words are stripped from EVERY query, not only when it exceeds the
// token cap: a stripped query is visibly derived from the message rather than
// passed through. The model still sees the user's original words — only the
// third-party search boundary sees the minimized form.

// Grammatical fillers only: quantifiers (most/all/more/some/any/few/…),
// negation (not/no) and exclusion words (only/other/…) change what a query
// means, so they stay — dropping "most" from "most points" is how a plan
// silently loses the comparison it was asked for.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'has', 'have', 'had', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'into', 'from', 'as',
  'it', 'its', 'we', 'you', 'your', 'i', 'my', 'me', 'he', 'she', 'they', 'them', 'their', 'his', 'her', 'our', 'us',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'so', 'such',
  'there', 'here', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'please', 'just', 'really', 'very', 'also', 'too',
]);

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const wordCount = (s) => (s ? s.split(' ').length : 0);

/** Cut a token list to the character budget without splitting a token. */
function fitChars(tokens) {
  let out = '';
  for (const t of tokens) {
    if (out && out.length + 1 + t.length > MAX_CHARS) break;
    out = out ? `${out} ${t}` : t;
  }
  return out;
}

/**
 * minimizeQuery(q) — the privacy boundary every search query crosses.
 * Removes emails, API keys and bearer tokens, long quoted spans and URL query
 * strings, drops filler words (question words, articles, auxiliaries) so a
 * query is visibly derived from the message rather than passed through, then
 * caps the result at ~12 significant tokens / 160 characters.
 * Terms that look like public entity names (capitalized words, numbers) are
 * kept as-is.
 */
export function minimizeQuery(q) {
  let s = String(q ?? '');
  s = s.replace(EMAIL_RE, ' ');
  s = s.replace(SK_RE, ' ');
  s = s.replace(BEARER_RE, ' ');
  s = s.replace(LABELED_KEY_RE, ' ');
  s = s.replace(TVLY_RE, ' ');
  s = s.replace(BSA_RE, ' ');
  s = s.replace(JINA_RE, ' ');
  s = s.replace(URL_QUERY_RE, '$1');
  s = s.replace(LONG_QUOTE_RE, ' ');
  s = s.replace(LONG_SINGLE_QUOTE_RE, ' ');
  s = collapse(s);
  if (!s) return '';
  let tokens = s.split(' ');
  const significant = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  if (significant.length) tokens = significant; // filler out of every query
  tokens = tokens.slice(0, MAX_TOKENS);
  return fitChars(tokens);
}

// ── classification ──────────────────────────────────────────────────────
const GREETING_RE = /^(hi|hey|hello|yo|hiya|howdy|sup|greetings|good morning|good afternoon|good evening)( there| again)?[\s!,.]*$/i;
const CONTINUE_RE = /^(continue|keep going|go on|say more|more|shorter|make it shorter|longer|make it longer|expand|elaborate|again|try again|retry|rewrite that|repeat|next|go deeper)\b/i;
const WRITING_ASK_RE = /^\s*(please\s+)?(write|draft|compose|rewrite|reword|edit|proofread|polish|summarize|summarise)\b/i;
const TRANSLATE_RE = /\btranslate\b|\btranslation\b/i;

const isGreeting = (t) => wordCount(t) <= 3 && GREETING_RE.test(t);
const isContinuation = (t) => wordCount(t) <= 4 && CONTINUE_RE.test(collapse(t));

function isPrivateWriting(text) {
  if (!WRITING_ASK_RE.test(text)) return false;
  if (wordCount(text) >= 20) return true;
  return /"[^"]{30,}"|'[^']{30,}'|`[^`]{30,}`|“[^”]{30,}”/.test(text);
}

const WRITING_KINDS = [
  [/\be-?mail\b/i, 'how to write a clear email'],
  [/\bletter\b/i, 'how to write a formal letter'],
  [/\bessay\b/i, 'how to write a short essay'],
  [/\breport\b/i, 'how to write a short report'],
  [/\bsummary\b|\bsummarise\b|\bsummarize\b/i, 'how to write a short summary'],
  [/\bpost\b|\btweet\b|\bcaption\b/i, 'how to write a short social post'],
  [/\bmessage\b|\breply\b|\bresponse\b/i, 'how to write a clear message'],
];
const WRITING_QUERY = 'how to write clearly';

const LANGS = [
  'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Russian',
  'Japanese', 'Chinese', 'Korean', 'Arabic', 'Hindi', 'Swedish', 'Polish',
  'Turkish', 'Vietnamese', 'Greek', 'Hebrew', 'Thai', 'Ukrainian',
];

/** Task kind + the generic word "translation"; never the text itself. */
function translationQuery(text) {
  for (const lang of LANGS) {
    if (new RegExp(`\\b${lang}\\b`, 'i').test(text)) return `${lang} translation`;
  }
  const rest = minimizeQuery(text.replace(/\b(please\s+)?(translate|translation of|the following|this text|into|to)\b/gi, ' '));
  return rest ? `${rest} translation` : 'text translation';
}

/** Query for one message, ignoring continuation handling. */
function derive(text) {
  if (isGreeting(text)) return GREETING_QUERY;
  if (isPrivateWriting(text)) {
    for (const [re, query] of WRITING_KINDS) if (re.test(text)) return query;
    return WRITING_QUERY;
  }
  if (TRANSLATE_RE.test(text)) return translationQuery(text);
  return minimizeQuery(text) || FALLBACK_QUERY;
}

/** Longest earlier user message that carries a task (ties: most recent). */
function mostSubstantive(history) {
  let best = null;
  let bestWords = -1;
  for (const raw of history) {
    const msg = collapse(raw);
    if (!msg || isGreeting(msg) || isContinuation(msg)) continue;
    const words = wordCount(msg);
    if (words >= bestWords) { bestWords = words; best = msg; }
  }
  return best;
}

/**
 * planQuery(text, { history }) — the initial search query for a turn.
 * `history` is the list of earlier user messages, oldest first.
 * A "continue"/"shorter" style message reuses the topic of the most
 * substantive earlier message; everything else is derived from `text`.
 */
export function planQuery(text, { history = [] } = {}) {
  const src = collapse(text);
  if (!src) return FALLBACK_QUERY;
  if (isContinuation(src)) {
    const prev = mostSubstantive(Array.isArray(history) ? history : []);
    return prev ? derive(prev) : FALLBACK_QUERY;
  }
  return derive(src);
}

// ── task planning: intent, entities, metrics, facts, query ───────────────
// planTask() is the structured plan the research loop works from: what kind
// of task the message is, which public entities and metrics it names, whether
// it wants live or dated facts, the competition scope, each distinct
// requested component, and the initial query. planQuery() stays the minimal
// path (greeting / private writing / translation / continuation) and those
// branches are shared here so their output never drifts.
//
// Documented assumptions:
// - "in history" / "all-time" totals are time-sensitive: a record keeps
//   changing, so such a plan is temporal 'current', not 'historical'.
//   Only an explicit past date (year, "last night", "the 1990s") is dated.
// - A league career record is a REGULAR-SEASON record unless the text says
//   otherwise; that default is stated in the plan's scope so the reader can
//   see the assumption instead of guessing it.

/** Typographic punctuation -> ASCII, whitespace collapsed, safe typo fixes. */
function cleanText(text) {
  let s = String(text ?? '');
  s = s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-').replace(/…/g, '...');
  s = collapse(s);
  // 'od they have' after 'how many' is a typo for 'does'. Nothing else is
  // rewritten: an unfamiliar name or identifier is never "corrected".
  s = s.replace(/\bod\b(?=\s+(?:they|he|she|it|you|we)\b)/gi, 'does');
  return s;
}

/** Known public acronyms: lower case still names the entity. */
const ACRONYMS = {
  nba: 'NBA', wnba: 'WNBA', nfl: 'NFL', mlb: 'MLB', nhl: 'NHL', ncaa: 'NCAA', mls: 'MLS',
  epl: 'EPL', uefa: 'UEFA', fifa: 'FIFA', nato: 'NATO', nasa: 'NASA', nascar: 'NASCAR',
  ufc: 'UFC', unesco: 'UNESCO', unicef: 'UNICEF',
};
const ACRONYM_RE = new RegExp(`(^|[^\\w./@-])(${Object.keys(ACRONYMS).join('|')})(?![\\w-])`, 'gi');
const canonicalAcronyms = (s) => s.replace(ACRONYM_RE, (_match, pre, token) => pre + ACRONYMS[token.toLowerCase()]);

/** Everything minimizeQuery strips, stripped again before analysis. */
function scrubSecrets(s) {
  return s
    .replace(EMAIL_RE, ' ').replace(SK_RE, ' ').replace(BEARER_RE, ' ').replace(LABELED_KEY_RE, ' ')
    .replace(TVLY_RE, ' ').replace(BSA_RE, ' ').replace(JINA_RE, ' ')
    .replace(LONG_QUOTE_RE, ' ').replace(LONG_SINGLE_QUOTE_RE, ' ');
}

/**
 * Sentence punctuation -> spaces (decimals survive); the same secrets
 * minimizeQuery strips are removed here too — a key, token or email address
 * must never become an "entity" or ride into a fact label — and known
 * acronyms are canonicalized.
 */
function queryText(cleaned) {
  const s = cleaned.replace(/[?!;,]+/g, ' ').replace(/\.(\s|$)/g, '$1');
  return canonicalAcronyms(collapse(scrubSecrets(s)));
}

// ── intent kinds ────────────────────────────────────────────────────────
const QUESTION_RE = /\b(who|whom|whose|what|which|when|where|why|how)\b/i;
const HOW_TO_RE = /\bhow\s+(?:to|do i|do you)\b/i;
const DEFINITION_RE = /\b(define|defines|definition|definitions|meaning|synonym|antonym|etymology|pronounce|pronunciation)\b|\bwhat does\b[^?]{0,60}\bmean\b/i;
const ACADEMIC_RE = /\b(paper|papers|study|studies|research|researched|journal|journals|arxiv|citation|citations|cite|thesis|dissertation|preprint|preprints|literature|meta-analysis|peer[- ]reviewed|experiment|experiments|hypothesis)\b/i;
const CODE_RE = /\b(code|coding|api|apis|function|functions|bug|bugs|error|errors|exception|stack trace|python|javascript|typescript|node|npm|regex|sql|css|html|json|yaml|git|docker|kubernetes|compiler|compile|runtime|library|libraries|framework|sdk|endpoint|async|await|promise)\b/i;
const VISUAL_RE = /\b(image|images|photo|photos|picture|pictures|diagram|diagrams|illustration|illustrations|drawing|drawings|poster|posters|wallpaper|wallpapers|logo|logos|screenshot|screenshots)\b/i;
const NEWS_RE = /\b(news|headline|headlines|breaking|latest|current events|press release)\b/i;
const SCORE_RE = /\b(score|scores|scoreboard|game|games|tonight|last night|vs|versus|final|finals|won|beat)\b/i;
const LEAGUE_RE = /\b(nba|wnba|nfl|mlb|nhl|ncaa|mls|epl|uefa|fifa|nascar|ufc|olympics|super bowl|world series|stanley cup|premier league|champions league)\b/i;
const TEAM_NICK_RE = /\b(lakers|celtics|warriors|knicks|bulls|spurs|nuggets|suns|mavericks|clippers|sixers|raptors|yankees|dodgers|red sox|mets|cubs|astros|braves|phillies|patriots|cowboys|packers|chiefs|eagles|49ers|steelers|ravens|bengals|vikings|saints|buccaneers|broncos|raiders|chargers|falcons|seahawks|titans|texans|jaguars|colts|browns|dolphins|canadiens|bruins|oilers|penguins|capitals|blackhawks|flyers|sharks|lightning|avalanche|predators|canucks|islanders|devils|hurricanes)\b/i;

/**
 * classifyIntent(text) — the task kind planTask() plans for and search.js
 * routes providers by. Specific asks win over keyword families; the general
 * web sources are eligible for every kind anyway.
 */
export function classifyIntent(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return 'general';
  if (isGreeting(cleaned)) return 'greeting';
  if (isPrivateWriting(cleaned)) return 'private-writing';
  if (TRANSLATE_RE.test(cleaned)) return 'translation';
  if (isContinuation(cleaned)) return 'continuation';
  const src = queryText(cleaned);
  if (SCORE_RE.test(src) && (LEAGUE_RE.test(src) || TEAM_NICK_RE.test(src))) return 'scores';
  if (VISUAL_RE.test(src)) return 'visual';
  if (CODE_RE.test(src)) return 'code';
  if (ACADEMIC_RE.test(src)) return 'academic';
  if (DEFINITION_RE.test(src)) return 'definition';
  if (NEWS_RE.test(src)) return 'news';
  if (HOW_TO_RE.test(src)) return 'general';
  if (/\?/.test(cleaned) || QUESTION_RE.test(src)) return 'factual';
  return 'general';
}

// ── entities, metrics, comparison, time, scope ──────────────────────────
// Words that are capitalized but name no entity: sentence-initial verbs and
// question words ("Explain the water cycle" names no entity).
const ENTITY_SKIP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'i', 'we', 'you', 'they', 'he', 'she', 'it',
  'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
  'please', 'hi', 'hey', 'hello', 'yes', 'no', 'not', 'so', 'such', 'there', 'here', 'about', 'thanks', 'thank', 'ok', 'okay',
  'how', 'what', 'who', 'whom', 'whose', 'which', 'when', 'where', 'why',
  'explain', 'tell', 'describe', 'write', 'give', 'show', 'list', 'find', 'compare', 'summarize', 'summarise',
  'calculate', 'translate', 'define', 'help', 'make', 'create', 'provide', 'search', 'look', 'recommend', 'suggest',
  'review', 'draft', 'rewrite', 'top', 'best', 'worst', 'most', 'least',
]);
const CAPITALIZED_RUN_RE = /\b[A-Z][A-Za-z0-9'’-]*(?:\s+[A-Z][A-Za-z0-9'’-]*)*/g;

/** Public entity phrases: capitalized multiword runs, acronyms in any case. */
function extractEntities(src) {
  const out = [];
  const push = (phrase) => {
    const s = collapse(phrase);
    if (s.length < 2 || out.some((e) => e.toLowerCase() === s.toLowerCase())) return;
    out.push(s);
  };
  for (const m of src.matchAll(CAPITALIZED_RUN_RE)) {
    const words = m[0].split(' ');
    while (words.length && ENTITY_SKIP.has(words[0].toLowerCase())) words.shift();
    while (words.length && ENTITY_SKIP.has(words[words.length - 1].toLowerCase())) words.pop();
    if (words.length) push(words.join(' '));
  }
  return out;
}

const METRIC_FORMS = [
  ['points', /\bpoints?\b/i], ['goals', /\bgoals?\b/i], ['assists', /\bassists?\b/i], ['rebounds', /\brebounds?\b/i],
  ['touchdowns', /\btouchdowns?\b/i], ['home runs', /\bhome runs?\b/i], ['strikeouts', /\bstrikeouts?\b/i],
  ['yards', /\byards?\b/i], ['wins', /\bwins?\b/i], ['losses', /\blosses?\b/i], ['titles', /\btitles?\b/i],
  ['championships', /\bchampionships?\b/i], ['medals', /\bmedals?\b/i], ['saves', /\bsaves?\b/i],
  ['kills', /\bkills?\b/i], ['deaths', /\bdeaths?\b/i], ['dollars', /\bdollars?\b/i], ['euros', /\beuros?\b/i],
  ['pounds', /\bpounds?\b/i], ['money', /\bmoney\b/i], ['revenue', /\brevenue\b/i], ['salary', /\bsalary\b/i],
  ['price', /\bprices?\b/i], ['cost', /\bcosts?\b/i], ['population', /\bpopulation\b/i], ['height', /\bheights?\b/i],
  ['distance', /\bdistances?\b/i], ['speed', /\bspeeds?\b/i], ['area', /\bareas?\b/i], ['weight', /\bweights?\b/i],
  ['temperature', /\btemperatures?\b/i], ['age', /\bages?\b/i], ['users', /\busers?\b/i], ['downloads', /\bdownloads?\b/i],
  ['ratings', /\bratings?\b/i], ['votes', /\bvotes?\b/i], ['followers', /\bfollowers?\b/i],
  ['subscribers', /\bsubscribers?\b/i], ['views', /\bviews?\b/i], ['meters', /\bmet(?:er|re)s?\b/i],
  ['kilometers', /\bkilomet(?:er|re)s?\b/i], ['miles', /\bmiles?\b/i], ['feet', /\bfeet\b|\bfoot\b/i],
  ['inches', /\binch(?:es)?\b/i], ['kilograms', /\bkilograms?\b|\bkilos?\b/i], ['percent', /\bpercent\b|\bpercentage\b/i],
  ['seconds', /\bseconds?\b/i], ['minutes', /\bminutes?\b/i], ['hours', /\bhours?\b/i], ['days', /\bdays?\b/i],
];

const canonicalMetric = (word) => {
  const w = word.toLowerCase();
  for (const [canonical, re] of METRIC_FORMS) if (re.test(w)) return canonical;
  return w;
};

/** Requested metrics/units: the "how many X" object plus the vocabulary. */
function extractMetrics(src) {
  const out = [];
  const seen = new Set();
  const push = (m) => {
    const k = m.toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    if (out.length < 4) out.push(m);
  };
  for (const m of src.matchAll(/\bhow (?:many|much)\s+([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*)*)/gi)) {
    for (const word of m[1].split(' ')) {
      const k = word.toLowerCase();
      if (STOPWORDS.has(k) || ENTITY_SKIP.has(k)) continue;
      push(canonicalMetric(word));
      break;
    }
  }
  for (const [canonical, re] of METRIC_FORMS) if (re.test(src)) push(canonical);
  return out;
}

const COMPARISON_RE = /\b(most|more|least|fewest|less|top|best|worst|highest|lowest|greatest|largest|smallest|biggest|leading|leader|leaders|first|record)\b/i;
const MIN_RE = /\b(least|fewest|less|lowest|smallest|worst)\b/i;
const ALL_TIME_RE = /\b(all[- ]time|of all time|in history|throughout history|history|ever|career|lifetime|record|records)\b/i;
const DATED_RE = /\b(?:1[5-9]\d{2}|20[0-3]\d)\b|\b(?:last|previous|past)\s+(?:night|week|month|year|season)\b|\byesterday\b|\bhistoric(?:al)?\b|\b\d{1,2}(?:st|nd|rd|th)\s+century\b|\bthe\s+(?:19|20)\d0s\b/i;
const NOW_RE = /\b(today|tonight|right now|currently|current|latest|so far|this (?:year|season|week|month)|now|live)\b/i;
const REFERENTIAL_RE = /\b(their|theirs|they|them|it|its|he|him|his|she|her|hers|this|that|these|those)\b/i;

function detectComparison(src) {
  const m = src.match(COMPARISON_RE);
  if (!m) return null;
  return MIN_RE.test(m[0]) ? 'min' : 'max';
}

function detectTemporal(src, kind) {
  if (DATED_RE.test(src)) return 'historical';
  if (NOW_RE.test(src) || ALL_TIME_RE.test(src)) return 'current';
  if (kind === 'definition') return 'timeless';
  if (kind === 'greeting' || kind === 'private-writing' || kind === 'translation' || kind === 'continuation' || kind === 'general') return 'unknown';
  return 'current';
}

function detectScope(src, a) {
  if (/\bplayoffs?\b|\bpost[- ]?season\b/i.test(src)) return 'playoffs';
  if (/\bregular season\b/i.test(src)) return 'regular season';
  if (/\bpre[- ]?season\b/i.test(src)) return 'preseason';
  // documented default: a league career record is a regular-season record
  if (a.allTime && a.comparison && (LEAGUE_RE.test(src) || a.entities.some((e) => LEAGUE_RE.test(e)))) return 'regular season';
  return null;
}

/** Entities of the nearest earlier message that names one (follow-ups). */
function contextEntities(history) {
  if (!Array.isArray(history)) return [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = queryText(cleanText(history[i]));
    if (!msg || isGreeting(msg) || isContinuation(msg)) continue;
    const found = extractEntities(msg);
    if (found.length) return found;
  }
  return [];
}

// ── facts: each distinct requested component ────────────────────────────
/** Split a message into its requested components (sentence + question runs). */
function splitClauses(cleaned) {
  const split = cleaned
    .replace(/\s+(?:and|&)\s+(?=(?:who|whom|whose|what|which|when|where|why|how)\b)/gi, '? ')
    .replace(/,\s*(?=(?:who|whom|whose|what|which|when|where|why|how)\b)/gi, '? ');
  return split.split(/[?!;]+|\.(?=\s|$)/).map((c) => collapse(c)).filter(Boolean);
}

function deriveFacts(cleaned, kind) {
  if (kind === 'greeting' || kind === 'private-writing' || kind === 'translation' || kind === 'continuation') return [];
  const facts = [];
  for (const clause of splitClauses(cleaned)) {
    const label = canonicalAcronyms(collapse(clause));
    if (!label || !label.split(' ').some((w) => !STOPWORDS.has(w.toLowerCase()))) continue;
    facts.push({ id: `f${facts.length + 1}`, label });
  }
  return facts;
}

// ── query ───────────────────────────────────────────────────────────────
const SKELETON = new Set([...STOPWORDS, 'many', 'much']);
// superlatives re-expressed once as leaders/fewest; "top 10" keeps its count
const SUPERLATIVE_DROP = new Set(['most', 'more', 'least', 'fewest', 'less', 'best', 'worst', 'highest', 'lowest', 'greatest', 'largest', 'smallest', 'biggest', 'leading', 'leader', 'leaders', 'first']);
const TIME_WORD_DROP = new Set(['history', 'all', 'time', 'all-time', 'ever', 'career', 'lifetime', 'historic', 'historical', 'record', 'records']);
// the scope is appended once, in its canonical form: "playoff" + "playoffs"
// would otherwise ride the same query twice
const SCOPE_FORMS = { playoff: 'playoffs', playoffs: 'playoffs', 'post-season': 'playoffs', postseason: 'playoffs', 'pre-season': 'preseason', preseason: 'preseason' };

function buildQuery(a) {
  const base = minimizeQuery(a.src) || FALLBACK_QUERY;
  const anchorPhrase = a.entities.join(' ');
  if (a.entities.length && a.comparison && (a.allTime || a.metrics.length)) {
    const parts = [];
    const used = new Set();
    const push = (s) => {
      for (const t of collapse(s).split(' ')) {
        const k = t.toLowerCase();
        if (!k || used.has(k)) continue;
        used.add(k);
        parts.push(t);
      }
    };
    push(anchorPhrase);
    if (a.allTime) push('all-time career');
    for (const t of base.split(' ')) {
      const k = t.toLowerCase();
      if (SKELETON.has(k) || SUPERLATIVE_DROP.has(k)) continue;
      if (a.allTime && TIME_WORD_DROP.has(k)) continue;
      if (a.scope && SCOPE_FORMS[k] === a.scope) continue;
      push(t);
    }
    push(a.metrics.join(' '));
    // the base's own comparison word was dropped; re-express it once, unless
    // "top N" already carries the comparison the user asked for
    if (!/\btop\b/i.test(base)) push(a.comparison === 'min' ? 'fewest' : 'leaders');
    if (a.scope) push(a.scope);
    return minimizeQuery(fitChars(parts)) || FALLBACK_QUERY;
  }
  if (base === FALLBACK_QUERY || !a.entities.length) return base;
  const anchored = a.entities.every((e) => base.toLowerCase().includes(e.toLowerCase()));
  return minimizeQuery(anchored ? base : `${anchorPhrase} ${base}`) || FALLBACK_QUERY;
}

/**
 * planTask(text, { history }) — the structured plan for one user message.
 * `history` is the list of earlier user messages, oldest first; a follow-up
 * that only refers to the conversation ("who is their coach") borrows its
 * entities from the nearest earlier message that names one.
 */
export function planTask(text, { history = [] } = {}) {
  const raw = collapse(text);
  const kind = classifyIntent(raw);
  const hist = Array.isArray(history) ? history : [];
  if (kind === 'greeting' || kind === 'private-writing' || kind === 'translation') {
    return { kind, entities: [], metrics: [], temporal: 'unknown', scope: null, facts: [], query: derive(raw) };
  }
  if (kind === 'continuation') {
    const prev = mostSubstantive(hist);
    return { kind, entities: [], metrics: [], temporal: 'unknown', scope: null, facts: [], query: prev ? derive(prev) : FALLBACK_QUERY };
  }
  const cleaned = scrubSecrets(cleanText(raw));
  const src = queryText(cleaned);
  const a = {
    kind,
    src,
    entities: extractEntities(src),
    metrics: extractMetrics(src),
    comparison: detectComparison(src),
    allTime: ALL_TIME_RE.test(src),
  };
  if (!a.entities.length && hist.length && REFERENTIAL_RE.test(src)) a.entities = contextEntities(hist);
  a.temporal = detectTemporal(src, kind);
  a.scope = detectScope(src, a);
  a.facts = deriveFacts(cleaned, kind);
  return {
    kind,
    entities: a.entities,
    metrics: a.metrics,
    temporal: a.temporal,
    scope: a.scope,
    facts: a.facts,
    query: buildQuery(a),
  };
}

/**
 * followUpQuery(plan, missingLabel) — a targeted repair query for one fact
 * the evidence did not support: the plan's entities anchor it, the missing
 * component's own metric narrows it, the plan's scope keeps the frame.
 */
export function followUpQuery(plan, missingLabel) {
  const p = plan && typeof plan === 'object' ? plan : {};
  const label = minimizeQuery(queryText(cleanText(missingLabel)));
  const anchors = (Array.isArray(p.entities) ? p.entities : []).map((e) => collapse(String(e))).filter(Boolean).join(' ');
  const quantity = /\bhow (?:many|much)\b|\btotal\b|\bcombined\b|\bnumber\b/i.test(String(missingLabel ?? ''));
  const parts = [];
  const used = new Set();
  const push = (s) => {
    for (const t of collapse(s).split(' ')) {
      const k = t.toLowerCase();
      if (!k || used.has(k)) continue;
      used.add(k);
      parts.push(t);
    }
  };
  push(anchors);
  push(label.replace(/\b(?:many|much)\b/gi, ' '));
  if (quantity) push('total');
  if (p.scope) push(String(p.scope));
  const q = minimizeQuery(fitChars(parts));
  return q || minimizeQuery(anchors) || minimizeQuery(p.query) || FALLBACK_QUERY;
}

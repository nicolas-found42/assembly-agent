// research.js — query planning for the mandated pre-answer web search.
// Pure: zero imports, zero model calls, deterministic. Everything here runs
// before any bytes leave the browser, so the whole module is the search
// boundary: planQuery() decides WHAT is searched, minimizeQuery() decides how
// much of the user's words survive.
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

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'has', 'have', 'had', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'into', 'from', 'as',
  'it', 'its', 'we', 'you', 'your', 'i', 'my', 'me', 'he', 'she', 'they', 'them', 'their', 'his', 'her', 'our', 'us',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'not', 'no', 'so', 'such',
  'there', 'here', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'please', 'just', 'really', 'very', 'also', 'too', 'some', 'any', 'all', 'more', 'most',
  'other', 'only', 'own', 'same', 'both', 'each', 'few', 'many', 'much',
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

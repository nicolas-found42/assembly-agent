// guard.js — pure guard helpers (ZERO imports). Q-hedge + arg repair.

// Honest uncertainty rewrite instruction for the once-per-turn Hedge Pass.
// Reuses BUDGET_NUDGE plumbing pattern: ephemeral user message, tools-less round.
export const HEDGE_PASS_NUDGE =
  'Your previous answer denied that something exists or has happened without citing Tool-result evidence. '
  + 'Rewrite it with honest uncertainty: only deny existence if the search results already in this conversation support that denial; '
  + 'otherwise say what you found and what remains unknown, and do not assert absence from missing evidence. '
  + 'Do not call web_search again — use only evidence already gathered.';

// denial phrases — existence / occurrence denials that must be evidence-backed
const DENIAL_RES = [
  /has not yet been held/i,
  /has not been held/i,
  /not yet been held/i,
  /not yet held/i,
  /has not yet occurred/i,
  /has not yet taken place/i,
  /not yet occurred/i,
  /not yet taken place/i,
  /does not exist/i,
  /did not exist/i,
  /do not exist/i,
  /never took place/i,
  /never held/i,
  /never occurred/i,
  /never happened/i,
  /no record of/i,
  /has not yet been/i,
  /there is no/i,
  /there are no/i,
  /there was no/i,
  /no such/i,
  /no evidence/i,
  /not found/i,
];

export function looksLikeDenial(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return DENIAL_RES.some((re) => re.test(text));
}

export function hedgeNeeded(answer, evidence) {
  if (!looksLikeDenial(answer)) return false;
  if (typeof evidence !== 'string' || !evidence.trim()) return true;
  const ev = evidence.toLowerCase();
  // extract subject = text before the denial phrase; fall back to full answer
  let subjectPart = answer;
  for (const re of DENIAL_RES) {
    const m = answer.match(re);
    if (m) {
      const idx = answer.toLowerCase().indexOf(m[0].toLowerCase());
      if (idx > 0) subjectPart = answer.slice(0, idx);
      break;
    }
  }
  // significant tokens (>=4 chars) from subject, minus common denial stopwords already excluded by slicing
  const tokens = subjectPart.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  if (tokens.length === 0) return true;
  const found = tokens.some((t) => ev.includes(t));
  return !found;
}

export function repairToolArgs(argsText) {
  if (typeof argsText !== 'string') return null;
  const s = argsText.trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if (o && typeof o.query === 'string' && o.query.trim()) return { ok: true, query: o.query };
    if (o && typeof o.query === 'string') return { ok: true, query: o.query };
  } catch {}
  // fallback salvage: "query": "value"  (tolerate missing closing quote/brace)
  let m = s.match(/"query"\s*:\s*"([^"]*)/);
  if (m) return { ok: true, query: m[1] };
  // single-quote fallback
  m = s.match(/'query'\s*:\s*'([^']*)/);
  if (m) return { ok: true, query: m[1] };
  return null;
}

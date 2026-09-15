// evidence.js — fact-level evidence assessment for the research pipeline.
// Pure and deterministic: no imports beyond the planner's query helpers, no
// model calls, no network. Everything here is a verdict over text already
// gathered, so the bridge can decide whether another repair round is worth it.
//
// Heuristic assumptions (deliberate, tested in test/evidence.test.mjs):
// - A plan fact is "one thing the user asked for"; an evidence item is "one
//   thing a source said". They match by token overlap between the fact label
//   and the item's `field` label, counting metric words ("points") and entity
//   words ("NBA") alike, over a small filler list (articles, prepositions,
//   "total", "number") so a fact label of "NBA career points leader" matches a
//   field of "career points total" — but a field of "points per game" does not.
// - Two items answering the same fact with different numbers conflict only when
//   they describe the same slice of data: a scope or period known on both sides
//   that differs makes them different questions, not a contradiction. This is
//   what keeps regular-season totals from "conflicting" with playoff totals.
// - A *current* fact (plan.temporal 'current') is not satisfied by a historical
//   milestone: Kareem's 1984-85 record night does not answer "who leads NBA
//   career points today". Such items are dropped before conflict pairing, so a
//   current total never conflicts with the milestone it replaced.
// - Non-factual turns are never assessed at all: assessIfFactual() returns null
//   for greetings, poems and translations, so callers keep today's behavior.

import * as research from './research.js';

/** Words that carry no subject: dropped from label overlap and repair queries. */
const FILLER = new Set([
 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'by', 'for', 'to', 'and', 'or',
 'but', 'that', 'this', 'these', 'those', 'their', 'its', 'it', 'is', 'are',
 'was', 'were', 'be', 'as', 'than', 'then', 'total', 'totals', 'number',
 'count', 'value', 'amount', 'current', 'currently', 'now', 'right', 's',
]);

const WORDS_RE = /[a-z0-9]+/g;

/** Lowercased word tokens. */
const words = (s) => String(s ?? '').toLowerCase().match(WORDS_RE) || [];

/** Subject words of a label: fillers out; the raw tokens if that empties it. */
function keyWords(s) {
 const w = words(s).filter((t) => t.length > 1 && !FILLER.has(t));
 return w.length ? w : words(s);
}

// ── matching ────────────────────────────────────────────────────────────
const MATCH_MIN = 0.5; // half of the label's subject words must appear

/** Token overlap (plural-tolerant) of a fact label against an item field, 0..1. */
function overlapScore(label, field) {
 const key = keyWords(label);
 const have = new Set(words(field));
 if (!key.length || !have.size) return 0;
 let hit = 0;
 for (const w of key) {
  if (have.has(w) || have.has(w.replace(/s$/, '')) || have.has(`${w}s`)) hit++;
 }
 return hit / key.length;
}

const matchesFact = (fact, item) => overlapScore(fact && fact.label, item && item.field) >= MATCH_MIN;

/** First number in a value, thousands separators tolerated. null when absent. */
function toNumber(v) {
 if (typeof v === 'number') return Number.isFinite(v) ? v : null;
 const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
 return m ? Number(m[0]) : null;
}

const normKey = (s) => {
 const t = String(s ?? '').trim().toLowerCase();
 return t || null;
};

/** Equal, or unknown on either side. A known difference is a different slice. */
const compatible = (a, b) => !a || !b || a === b;

const YEAR_RE = /\b(1\d{3}|2\d{3})\b/;

/** True when a period names a year that has already passed (unknown → false). */
function periodIsHistorical(period) {
 if (!period) return false;
 const m = period.match(YEAR_RE);
 return m ? Number(m[1]) < new Date().getUTCFullYear() : false;
}

// ── assessment ──────────────────────────────────────────────────────────
/**
 * assess(plan, items) — one fact at a time, over the evidence gathered so far.
 * items: [{ field, value, unit?, scope?, period?, sourceId? }]
 * Returns { status, supported:[factId], missing:[factId],
 *           conflicts:[{ factId, values:[number] }] }.
 * status: 'conflicting' when any fact has disagreeing numbers, else 'supported'
 * when every fact has evidence, else 'partial' when only some do, else
 * 'unavailable' (no items, no facts, or nothing matched).
 * A conflicting fact is reported under conflicts only — it has evidence, so it
 * is not "missing", and it is not a fact you may answer from.
 */
export function assess(plan, items) {
 const facts = Array.isArray(plan && plan.facts) ? plan.facts.filter((f) => f && f.id) : [];
 const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it === 'object');
 const allIds = facts.map((f) => f.id);
 if (!facts.length || !list.length) {
  return { status: 'unavailable', supported: [], missing: allIds, conflicts: [] };
 }

 const current = plan.temporal === 'current';
 const planScope = normKey(plan.scope);
 const prepared = list.map((it) => ({
  it,
  scope: normKey(it.scope),
  period: normKey(it.period),
  n: toNumber(it.value),
 }));

 const supported = [];
 const missing = [];
 const conflicts = [];

 for (const fact of facts) {
  const candidates = prepared
   .filter((p) => matchesFact(fact, p.it))
   // a known scope that differs from the plan's is a different question
   .filter((p) => !(planScope && p.scope && p.scope !== planScope))
   // a historical milestone never answers a question about the current state
   .filter((p) => !(current && periodIsHistorical(p.period)));

  if (!candidates.length) {
   missing.push(fact.id);
   continue;
  }

  const values = new Set();
  for (let i = 0; i < candidates.length; i++) {
   for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i];
    const b = candidates[j];
    if (a.n == null || b.n == null || a.n === b.n) continue;
    if (!compatible(a.scope, b.scope) || !compatible(a.period, b.period)) continue;
    values.add(a.n);
    values.add(b.n);
   }
  }

  if (values.size) conflicts.push({ factId: fact.id, values: [...values] });
  else supported.push(fact.id);
 }

 let status = 'supported';
 if (conflicts.length) status = 'conflicting';
 else if (missing.length) status = supported.length ? 'partial' : 'unavailable';

 return { status, supported, missing, conflicts };
}

/** Kinds whose facts are worth checking against evidence. */
const FACTUAL_KINDS = new Set(['factual', 'scores', 'academic']);

/**
 * assessIfFactual(plan, items) — assess() for factual plans, null otherwise.
 * Greetings, poems, translations and other non-factual turns are never
 * assessed; callers treat null as "nothing to verify, keep today's behavior".
 */
export function assessIfFactual(plan, items) {
 if (!plan || !FACTUAL_KINDS.has(plan.kind)) return null;
 return assess(plan, items);
}

// ── repair queries ──────────────────────────────────────────────────────
const RAW_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9'’-]*/g;
const cleanToken = (t) => t.replace(/[’']s$/, '').replace(/[’'’-]+$/, '');

/**
 * Local repair query: entity anchor first, then the missing label's subject
 * words, then the plan scope and metrics — each token once, capped by the
 * shared minimizer so the repair crosses the search boundary like any query.
 */
function localRepairQuery(plan, labels) {
 const seen = new Set();
 const out = [];
 const push = (text) => {
  for (const raw of String(text ?? '').match(RAW_TOKEN_RE) || []) {
   const token = cleanToken(raw);
   const key = token.toLowerCase();
   if (key.length <= 1 || FILLER.has(key) || seen.has(key)) continue;
   seen.add(key);
   out.push(token);
  }
 };

 for (const entity of plan.entities || []) push(entity);
 for (const label of labels.slice(0, 2)) push(label);
 push(plan.scope);
 for (const metric of plan.metrics || []) push(metric);
 return out.join(' ');
}

/**
 * repairQuery(plan, missingLabels) — a short, entity-anchored query aimed at the
 * facts that are still missing. Delegates the wording to the planner's
 * followUpQuery() when available, and always crosses the shared minimizer.
 * Returns '' when nothing is missing (no repair round to run).
 */
export function repairQuery(plan, missingLabels = []) {
 const p = plan || {};
 const labels = (Array.isArray(missingLabels) ? missingLabels : [missingLabels])
  .map((s) => String(s ?? '').replace(/\s+/g, ' ').trim())
  .filter(Boolean);
 if (!labels.length) return '';

 const local = localRepairQuery(p, labels);
 let delegated = '';
 if (typeof research.followUpQuery === 'function') {
  try {
   delegated = research.followUpQuery(p, labels[0]);
  } catch {
   delegated = ''; // a repair query must never break the turn
  }
 }
 const minimized = research.minimizeQuery(String(delegated || ''))
  || research.minimizeQuery(local)
  || local;
 return minimized;
}

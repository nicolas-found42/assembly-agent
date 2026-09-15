// ste.js — mechanical ASD-STE100 checks for chat answers, plus a corrective
// rewrite prompt and a conservative integrity check for the rewrite.
//
// Edition consulted: ASD-STE100 Simplified Technical English, Issue 9, 2025-01-15.
//   Official site:https://www.asd-ste100.org/
//   About page: https://www.asd-ste100.org/about_STE.html
//   Official PDF: https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf
//   (retrieved 2026-09-14; the standard is copyright ASD and is not bundled here.)
//
// Provenance per implemented check:
//   sentence-length   Rule 5.1 "Write short sentences. Use a maximum of 20 words
//                     in each sentence." (Procedural limit. Descriptive writing
//                     allows 25 words, rule 6.3. This checker uses 20.)
//   paragraph-length  Rule 6.6 "Make sure that no paragraph has more than six sentences."
//   passive-voice     Rule 3.6 (active voice; passive only when the agent is unknown).
//                     Heuristic: be-verb + past participle.
//   progressive-verb  Rule 3.5 ("-ing" form only as a technical noun or a modifier)
//                     with rule 3.2 (progressive tenses are not approved).
//                     Heuristic: am/is/are/was/were + verb-ing.
//   double-negative   No numbered Issue 9 rule. Basis: plain-language guidance
//                     "write positively" (Global English Style Guide rule 3.12,
//                     mapped for STE Issue 9 by TechScribe, https://www.simplified-english.co.uk/rules-ste9.html).
//   multiple-commands Rule 5.2 "Write only one instruction in each sentence unless
//                     two or more actions occur at the same time."
//                     Heuristic: command verbs from a fixed list.
//
// UNVERIFIED / NOT IMPLEMENTED:
//   - Approved-word dictionary checks (rule 1.1). The dictionary is a copyright-
//     protected controlled document (about 900 approved words, each with one part
//     of speech). ASD gives a free copy on request
//     (https://www.asd-ste100.org/STE_downloads.html), but it is not an open data
//     set. This module ships no word list and will not guess one.
//   - Part-of-speech and verb-form approvals (rules 1.2, 3.1): need the dictionary.
//   - Technical noun / technical verb categories (rules 1.5 thru 1.13): need the
//     project glossary.
//   - Full word-count rules 8.4 thru 8.7 (vertical lists, parentheses, number +
//     unit pairs). The checker counts whitespace tokens: "128KB" is one word,
//     "128 KB" is two.
//   - Word choice, articles, spelling, and punctuation: not mechanically checked.
//
// Heuristic limits (stated again in each violation record):
//   - Passive and progressive checks look at word shapes only. "The door is closed"
//     (adjective) and "The page is interesting" (participial adjective) are flagged.
//   - Gerund uses of "-ing" are not distinguished from progressive verbs.
//   - Sentences split on ".", "!", "?", and line ends. Abbreviations are not recognized.
//   - The multiple-commands check finds only verbs in its fixed list.

const FENCE_RE = /^\s*(?:`{3,}|~{3,})/;
const HEADING_RE = /^\s*#{1,6}\s+\S/;
const QUOTE_RE = /^\s*>/;
const TABLE_RE = /^\s*\|/;
const LINK_ONLY_RE = /^\s*(?:[-*+]\s+)?(?:\[[^\]]*\]\([^)]*\)|<?https?:\/\/\S+>?)[\s.,;:!?]*$/;

const INLINE_CODE_RE = /`[^`\n]*`/g;
const MD_LINK_RE = /\[([^\]]*)\]\([^)\n]*\)/g;
const BARE_URL_RE = /\bhttps?:\/\/\S+/gi;

// Rule 3.6 heuristic. The irregular list holds common past participles that do
// not end in "-ed". One adverb may sit between the be-verb and the participle.
const PASSIVE_RE =
  /\b(?:am|is|are|was|were|been|be)\b(?:\s+\w+ly)?\s+(?:\w+ed\b|made|done|given|taken|seen|known|found|sent|kept|held|shown|written|built|set|put|read|cut|told|left|lost|broken|chosen|driven|drawn|thrown|hidden|used)\b/gi;

// Rule 3.5 heuristic. Words that merely end in "-ing" are excluded.
const PROGRESSIVE_RE =
  /\b(?:am|is|are|was|were)\s+(?!something\b|anything\b|nothing\b|everything\b|thing\b|things\b|morning\b|evening\b|spring\b|string\b|ring\b|wing\b|king\b)([a-z]{2,}ing)\b/gi;

const NEGATIVE_RE = /\b(?:no|not|never|nor)\b/gi;

// Rule 5.2 heuristic: common verbs that a procedure can start with.
const BASE_VERBS = new Set([
  'add', 'answer', 'apply', 'ask', 'check', 'clean', 'click', 'close', 'connect', 'copy',
  'create', 'cut', 'delete', 'disconnect', 'do', 'download', 'edit', 'enter', 'find',
  'follow', 'get', 'give', 'go', 'hold', 'install', 'keep', 'look', 'make', 'move',
  'open', 'paste', 'press', 'put', 'read', 'remove', 'replace', 'run', 'save', 'see',
  'select', 'send', 'set', 'show', 'start', 'stop', 'take', 'tell', 'test', 'try',
  'turn', 'type', 'update', 'use', 'write',
]);
const AUXILIARY = new Set([
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'can', 'could', 'will', 'would',
  'shall', 'should', 'may', 'might', 'must', 'do', 'does', 'did',
]);

// The closed list of violation ids, in report order.
const ORDER = ['sentence-length', 'paragraph-length', 'passive-voice', 'progressive-verb', 'double-negative', 'multiple-commands'];

const RULES = {
  'sentence-length': 'Rule 5.1: Write short sentences. Use a maximum of 20 words in each sentence.',
  'paragraph-length': 'Rule 6.6: Make sure that no paragraph has more than six sentences.',
  'passive-voice': 'Rule 3.6: Use the active voice. Heuristic check (be-verb + past participle; adjective uses such as "is closed" are not distinguished).',
  'progressive-verb': 'Rule 3.5: Use the -ing form of a verb only as a technical noun or as a modifier in a technical noun. Heuristic check for progressive verbs (am/is/are/was/were + -ing; gerund and participial-adjective uses are not distinguished).',
  'double-negative': 'No numbered ASD-STE100 rule. Plain-language guidance: write positively. Heuristic check (two of no/not/never/nor in one sentence).',
  'multiple-commands': 'Rule 5.2: Write only one instruction in each sentence unless two or more actions occur at the same time. Heuristic check (command verbs from a fixed list).',
};

/** Split markdown text into typed segments. Code fences, blockquotes, link-only
 *  lines, and table rows stay in their own segments and are not checked. */
export function splitProse(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const segments = [];
  let buffer = [];
  let bufferType = null;
  let fence = null;

  const flush = () => {
    if (buffer.length && buffer.join('\n').trim()) segments.push({ type: bufferType, text: buffer.join('\n') });
    buffer = [];
    bufferType = null;
  };

  for (const line of lines) {
    if (fence) {
      buffer.push(line);
      if (line.trim().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    if (FENCE_RE.test(line)) {
      flush();
      fence = line.trim().slice(0, 3);
      bufferType = 'code';
      buffer.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const type = HEADING_RE.test(line) ? 'heading'
      : QUOTE_RE.test(line) ? 'quote'
        : TABLE_RE.test(line) ? 'table'
          : LINK_ONLY_RE.test(line) ? 'link'
            : 'prose';
    if (type !== bufferType) flush();
    bufferType = type;
    buffer.push(line);
  }
  flush();
  return segments;
}

/** Remove protected spans from prose: link targets, bare URLs, inline code. */
function maskProse(text) {
  return text
    .replace(MD_LINK_RE, '$1')
    .replace(BARE_URL_RE, '[link]')
    .replace(INLINE_CODE_RE, '[code]');
}

function splitSentences(paragraph) {
  return paragraph
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?]["'”’]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const wordCount = (sentence) => sentence.split(/\s+/).filter(Boolean).length;

function truncate(text, max = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Count command-verb candidates in one sentence (rule 5.2 heuristic). */
function commandCount(sentence) {
  const words = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  let count = BASE_VERBS.has(words[0]) ? 1 : 0;
  for (let i = 1; i < words.length - 1; i++) {
    if (words[i] !== 'and' && words[i] !== 'then') continue;
    if (!BASE_VERBS.has(words[i + 1])) continue;
    let hasAuxiliary = false;
    for (let j = 0; j < i; j++) if (AUXILIARY.has(words[j])) { hasAuxiliary = true; break; }
    if (!hasAuxiliary) count++;
  }
  return count;
}

/** Find ASD-STE100 rule violations in the prose of a markdown answer.
 *  Returns {applicable, violations}. `applicable` is false for empty text, text
 *  with fewer than two prose sentences, and fully protected text. `count` is the
 *  number of flagged sentences for sentence-level checks and the number of
 *  matches for the passive and progressive heuristics. */
export function checkProse(text) {
  const paragraphs = splitProse(text)
    .filter((s) => s.type === 'prose')
    .map((s) => maskProse(s.text).replace(/\n+/g, ' ').trim())
    .filter(Boolean);

  const sentences = paragraphs.flatMap((p) => splitSentences(p));
  if (sentences.length < 2) return { applicable: false, violations: [] };

  const found = {
    'sentence-length': { count: 0, examples: [] },
    'paragraph-length': { count: 0, examples: [] },
    'passive-voice': { count: 0, examples: [] },
    'progressive-verb': { count: 0, examples: [] },
    'double-negative': { count: 0, examples: [] },
    'multiple-commands': { count: 0, examples: [] },
  };

  for (const paragraph of paragraphs) {
    const local = splitSentences(paragraph);
    if (local.length > 6) {
      found['paragraph-length'].count++;
      if (found['paragraph-length'].examples.length < 3) {
        found['paragraph-length'].examples.push(truncate(paragraph));
      }
    }
  }

  for (const sentence of sentences) {
    if (wordCount(sentence) > 20) {
      found['sentence-length'].count++;
      if (found['sentence-length'].examples.length < 3) found['sentence-length'].examples.push(sentence);
    }
    const passive = sentence.match(PASSIVE_RE);
    if (passive) {
      found['passive-voice'].count += passive.length;
      if (found['passive-voice'].examples.length < 3) found['passive-voice'].examples.push(sentence);
    }
    const progressive = sentence.match(PROGRESSIVE_RE);
    if (progressive) {
      found['progressive-verb'].count += progressive.length;
      if (found['progressive-verb'].examples.length < 3) found['progressive-verb'].examples.push(sentence);
    }
    const negatives = sentence.match(NEGATIVE_RE);
    if (negatives && negatives.length > 1) {
      found['double-negative'].count++;
      if (found['double-negative'].examples.length < 3) found['double-negative'].examples.push(sentence);
    }
    if (commandCount(sentence) > 1) {
      found['multiple-commands'].count++;
      if (found['multiple-commands'].examples.length < 3) found['multiple-commands'].examples.push(sentence);
    }
  }

  const violations = ORDER
    .filter((id) => found[id].count > 0)
    .map((id) => ({ id, rule: RULES[id], count: found[id].count, examples: found[id].examples }));
  return { applicable: true, violations };
}

/** Instruction for one tools-disabled corrective rewrite of the answer. Returns
 *  an empty string when there is nothing to correct. */
export function correctionPrompt(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return '';
  return [
    'Rewrite your answer one time. Do not use tools.',
    'Correct the explanatory prose only.',
    'Fix these rule violations:',
    ...violations.map((v) => `- ${v.id}: ${v.rule} (${v.count} in the answer)`),
    'Keep all facts, conditions, numbers, units, source links, code blocks, and quotations.',
    'Keep the meaning, the structure, and the approximate length of the answer.',
    'Output only the corrected answer.',
  ].join('\n');
}

/** True only when the correction keeps every link target, code block body,
 *  digit token, and quoted span from the original text. False on any doubt. */
export function integrityPreserved(original, corrected) {
  if (typeof original !== 'string' || typeof corrected !== 'string') return false;

  const urls = new Set(original.match(/https?:\/\/[^\s)>\]]+/g) || []);
  for (const url of urls) if (!corrected.includes(url)) return false;

  for (const segment of splitProse(original)) {
    if (segment.type !== 'code') continue;
    const inner = segment.text
      .replace(/^(?:`{3,}|~{3,})[^\n]*\n?/, '')
      .replace(/\n?(?:`{3,}|~{3,})\s*$/, '')
      .trim();
    if (inner && !corrected.includes(inner)) return false;
  }

  for (const token of original.split(/\s+/)) {
    const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/\d/.test(bare) && !corrected.includes(bare)) return false;
  }

  for (const match of original.matchAll(/"([^"]{2,})"|“([^“”]{2,})”/g)) {
    const quoted = match[1] ?? match[2];
    if (!corrected.includes(quoted)) return false;
  }
  return true;
}

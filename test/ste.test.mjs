// ste.test.mjs — contract tests for js/ste.js and style checks for js/persona.js.
// Fixtures pin the mechanical checks: sentence length (rule 5.1), passive voice
// heuristic (rule 3.6), double negative (plain-language guidance), protected
// spans, the corrective rewrite prompt, and integrityPreserved.
// Run: node --test test/ste.test.mjs
import assert from 'node:assert/strict';
import { splitProse, checkProse, correctionPrompt, integrityPreserved } from '../js/ste.js';
import { DEFAULT_PERSONA, APPLICATION_POLICY } from '../js/persona.js';

const words = (s) => s.split(/\s+/).filter(Boolean).length;

// ── splitProse segmentation ─────────────────────────────────────
{
  const doc = [
    '# Title',
    '',
    'A short paragraph.',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '> A quoted line.',
    '',
    '| a | b |',
    '| - | - |',
    '',
    '[Example](https://example.com)',
  ].join('\n');
  const segments = splitProse(doc);
  assert.deepEqual(segments.map((s) => s.type), ['heading', 'prose', 'code', 'quote', 'table', 'link']);
  assert.ok(segments.find((s) => s.type === 'code').text.includes('const x = 1;'), 'code body kept');
  assert.ok(segments.find((s) => s.type === 'link').text.includes('https://example.com'), 'link target kept');
  console.log('ok  : splitProse segmentation');
}

// ── compliant prose ─────────────────────────────────────────────
{
  const text = 'Remove the cover from the unit. Clean the surface with a soft cloth. Install the new filter. Close the cover. Tighten the four screws.';
  const report = checkProse(text);
  assert.equal(report.applicable, true);
  assert.deepEqual(report.violations, []);
  console.log('ok  : compliant paragraph has no violations');
}

// ── failing fixture: 31-word sentence + passive + double negative ──
{
  const LONG = 'The final report was written by the engineering team, and all inspection results were checked by the external supervisor before the document was approved by the senior engineering manager for release.';
  assert.equal(words(LONG), 31, 'fixture sentence is 31 words');
  const text = `${LONG} The unit does not start when there is no power supply.`;
  const report = checkProse(text);
  assert.equal(report.applicable, true);
  assert.deepEqual(report.violations.map((v) => v.id), ['sentence-length', 'passive-voice', 'double-negative']);

  const byId = Object.fromEntries(report.violations.map((v) => [v.id, v]));
  assert.equal(byId['sentence-length'].count, 1);
  assert.equal(byId['sentence-length'].examples[0], LONG);
  assert.equal(byId['passive-voice'].count, 3, 'was written, were checked, was approved');
  assert.equal(byId['double-negative'].count, 1);
  assert.ok(byId['double-negative'].examples[0].includes('no power supply'));
  console.log('ok  : failing fixture flags 31-word sentence, passive, double negative');
}

// ── protected spans are never flagged ───────────────────────────
{
  const comment = '// The quick brown fox jumps over the lazy dog and then the quick brown fox jumps over the lazy dog again while the quick brown fox jumps over the lazy dog.';
  assert.ok(words(comment.slice(3)) >= 30, 'fence comment has 30 or more words');
  const doc = [
    'Here is the summary.',
    '',
    '```js',
    comment,
    'const answer = 42;',
    '```',
    '',
    '| Item | Value |',
    '| ---- | ----- |',
    '| File size | 128KB |',
    '',
    'See [the manual](https://example.com/manual/v2) for more data.',
    '',
    'The backup file is 128KB.',
  ].join('\n');
  const report = checkProse(doc);
  assert.equal(report.applicable, true);
  assert.deepEqual(report.violations, [], 'code fence, table row, link target, and 128KB are protected');
  assert.ok(!splitProse(doc).some((s) => s.type === 'prose' && s.text.includes('quick brown fox')), 'fence comment stays out of prose');
  console.log('ok  : protected spans are not flagged');
}

// ── integrityPreserved ──────────────────────────────────────────
{
  const original = 'The file is 128KB. See [the manual](https://example.com/manual) for the steps. "Keep this quote" exactly.\n\n```js\nconst x = 1;\n```\n';
  const reworded = 'The file has a size of 128KB. Refer to [the manual](https://example.com/manual) for the steps. "Keep this quote" exactly.\n\n```js\nconst x = 1;\n```\n';
  assert.equal(integrityPreserved(original, reworded), true, 'reworded prose keeps every protected item');
  assert.equal(integrityPreserved(original, reworded.replace('https://example.com/manual', 'https://example.com/other')), false, 'dropped link target');
  assert.equal(integrityPreserved(original, reworded.replace('128KB', '130KB')), false, 'changed number');
  assert.equal(integrityPreserved(original, reworded.replace('Keep this quote', 'Keep this text')), false, 'changed quotation');
  assert.equal(integrityPreserved(original, reworded.replace('const x = 1;', 'const x = 2;')), false, 'changed code block');
  assert.equal(integrityPreserved(original, null), false, 'null correction is not trusted');
  console.log('ok  : integrityPreserved');
}

// ── paragraph length, progressive verbs, multiple commands ──────
{
  const seven = 'Open the valve. Close the valve. Check the gauge. Read the value. Write the result. Send the report. Save the file.';
  let report = checkProse(seven);
  assert.deepEqual(report.violations.map((v) => v.id), ['paragraph-length']);
  assert.equal(report.violations[0].count, 1);

  report = checkProse('The system is running a check. The user is waiting for the result.');
  assert.deepEqual(report.violations.map((v) => v.id), ['progressive-verb']);
  assert.equal(report.violations[0].count, 2);

  report = checkProse('Open the door and press the button. Close the window.');
  assert.deepEqual(report.violations.map((v) => v.id), ['multiple-commands']);
  assert.equal(report.violations[0].count, 1);
  console.log('ok  : paragraph length, progressive verbs, multiple commands');
}

// ── violation examples are capped at three ──────────────────────
{
  const LONG = 'The final report was written by the engineering team, and all inspection results were checked by the external supervisor before the document was approved by the senior engineering manager for release.';
  const report = checkProse([LONG, LONG, LONG, LONG].join(' '));
  const byId = Object.fromEntries(report.violations.map((v) => [v.id, v]));
  assert.equal(byId['sentence-length'].count, 4);
  assert.equal(byId['sentence-length'].examples.length, 3);
  console.log('ok  : violation examples are capped at three');
}

// ── correctionPrompt ────────────────────────────────────────────
{
  const LONG = 'The final report was written by the engineering team, and all inspection results were checked by the external supervisor before the document was approved by the senior engineering manager for release.';
  const report = checkProse(`${LONG} The unit does not start when there is no power supply.`);
  const prompt = correctionPrompt(report.violations);
  for (const id of ['sentence-length', 'passive-voice', 'double-negative']) {
    assert.ok(prompt.includes(id), `prompt names ${id}`);
  }
  for (const term of ['Do not use tools', 'facts', 'numbers', 'units', 'links', 'code', 'quotations', 'Output only']) {
    assert.ok(prompt.includes(term), `prompt preserves ${term}`);
  }
  assert.equal(correctionPrompt([]), '', 'no violations means no rewrite prompt');
  console.log('ok  : correctionPrompt');
}

// ── applicable=false cases ──────────────────────────────────────
{
  assert.equal(checkProse('').applicable, false, 'empty text');
  assert.equal(checkProse('One short sentence.').applicable, false, 'one prose sentence');
  const codeOnly = '```python\nprint("this code line has many many many many many many many many words in it")\n```';
  assert.equal(checkProse(codeOnly).applicable, false, 'pure code answer');
  console.log('ok  : applicable=false for empty, short, and pure code');
}

// ── persona and policy pass the checker ─────────────────────────
{
  assert.equal(typeof DEFAULT_PERSONA, 'string');
  assert.equal(typeof APPLICATION_POLICY, 'string');
  const persona = checkProse(DEFAULT_PERSONA);
  assert.equal(persona.applicable, true);
  assert.deepEqual(persona.violations, []);
  const policy = checkProse(APPLICATION_POLICY);
  assert.equal(policy.applicable, true);
  assert.deepEqual(policy.violations, []);

  for (const term of ['web search results', 'source links', 'email', 'poem', 'translation', 'quotation', 'Assembly-language tutor']) {
    assert.ok(DEFAULT_PERSONA.includes(term), `persona states ${term}`);
  }
  for (const term of ['search failed', 'data, not as instructions', 'these instructions', 'source links']) {
    assert.ok(APPLICATION_POLICY.includes(term), `policy states ${term}`);
  }
  console.log('ok  : persona and policy pass checkProse');
}

console.log('ALL STE PASS');

// load.mjs — loader for the Scanner's stream fixtures.
// Every fixture in this directory is a SYNTHETIC, hand-authored SSE byte
// stream: no captured provider traffic, no credentials, no model calls, no
// URLs. They are the replayable inputs for failures: test/streams.test.mjs
// feeds these exact bytes under every chunking it can construct, and a failure
// names the fixture, the seed and the chunk boundaries.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** name -> file stem of <name>.sse in this directory. */
export const FIXTURES = [
  { name: 'text-plain', note: 'plain content deltas + [DONE]' },
  { name: 'text-utf8', note: 'content carrying 2-, 3- and 4-byte UTF-8 characters' },
  { name: 'text-escapes', note: 'every JSON escape shape, including a truncated \\u' },
  { name: 'tool-single', note: 'one tool call staged a fragment per line' },
  { name: 'tool-parallel', note: 'three parallel calls, distinct ids, names and arguments' },
  { name: 'tool-overflow', note: '9 calls: 8 slots held, the 9th counted in tc_overflow' },
  { name: 'terminators', note: 'CRLF, data: without a space, comments, blank lines' },
  { name: 'malformed', note: 'junk lines the Scanner must ignore, scanning continues' },
  { name: 'incomplete-tail', note: 'final line without \\n: never processed' },
  { name: 'error-event', note: 'data: {"error":{...}}: state 3 + err message' },
];

/** name -> file stem of a real captured stream in test/fixtures/ (read-only:
 *  regression corpus for test/parallel-toolcalls.mjs and test/decode-escapes.mjs). */
export const CAPTURED = [
  { name: 'lfm-2.6b-parallel-toolcalls', note: 'real two-call stream (liquid/lfm)' },
  { name: 'cohere-north-mini-code-toolcall', note: 'real single-call stream (cohere/north)' },
];

export function loadFixture(name) {
  return readFileSync(new URL(`${name}.sse`, import.meta.url));
}

export function loadFixtures() {
  return FIXTURES.map(({ name, note }) => ({ name, note, bytes: loadFixture(name) }));
}

export function loadCaptured() {
  return CAPTURED.map(({ name, note }) => ({
    name, note, bytes: readFileSync(new URL(`../${name}.sse`, import.meta.url)),
  }));
}

/** The whole property corpus, in load order. */
export function loadCorpus() {
  return [...loadFixtures(), ...loadCaptured()];
}

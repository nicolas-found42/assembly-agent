#!/usr/bin/env node
// abi-check.mjs — executable engine ABI contract check for dist/agent.wasm.
//
// R08 (brief §11.3): zero imports, the exports the runtime actually calls, and
// the memory shape the runtime relies on are contract, not incidental. Expected
// export names are DERIVED from the JavaScript that drives the engine
// (js/bridge.js, js/models.js) and the declared memory floor is derived from
// src/agent.wat, so renaming an export on either side fails this check instead
// of failing silently in the browser.
//
// Usage: node scripts/abi-check.mjs [path/to/agent.wasm]
// Exit codes: 0 = contract holds, 1 = drift / malformed module, 2 = usage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const wasmPath = process.argv[2] || join(repoRoot, 'dist/agent.wasm');

// ── expected surface, derived from the JS engine clients ────────────────
const CLIENTS = ['js/bridge.js', 'js/models.js'];
const MEMORY_EXPORT = 'memory';

function engineCalls(file) {
  const src = readFileSync(join(repoRoot, file), 'utf8');
  const names = new Set();
  // `E.foo(...)` / `E.foo` where E is the exports object, and `eng().foo`.
  for (const m of src.matchAll(/\bE\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\beng\(\)\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return [...names];
}

const expectedFns = new Set();
const origin = new Map();
for (const file of CLIENTS) {
  for (const name of engineCalls(file)) {
    if (name === MEMORY_EXPORT) continue;
    expectedFns.add(name);
    if (!origin.has(name)) origin.set(name, file);
  }
}

// ── declared memory floor, derived from the WAT source ─────────────────
function watMemoryFloor() {
  let wat;
  try {
    wat = readFileSync(join(repoRoot, 'src/agent.wat'), 'utf8');
  } catch {
    return null; // compiled artifact may be checked outside a source checkout
  }
  const m = wat.match(/\(memory\s+\(export\s+"memory"\)\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── checks ──────────────────────────────────────────────────────────────
const failures = [];
let bytes;
try {
  bytes = readFileSync(wasmPath);
} catch {
  console.error(`ABI FAIL: wasm module not found: ${wasmPath} (build it with \`npm run build\`)`);
  process.exit(1);
}
let mod;
try {
  mod = await WebAssembly.compile(bytes);
} catch (err) {
  console.error(`ABI FAIL: ${wasmPath} is not a valid WebAssembly module — ${err.message}`);
  process.exit(1);
}

const imports = WebAssembly.Module.imports(mod);
if (imports.length) {
  failures.push(
    `the module must be self-contained (zero imports) but declares ${imports.length}: ` +
    imports.map((i) => `${i.module}.${i.name} (${i.kind})`).join(', '),
  );
}

const exports = WebAssembly.Module.exports(mod);
const byName = new Map(exports.map((e) => [e.name, e]));
const exportList = [...byName.keys()].sort().join(', ');

for (const name of [...expectedFns].sort()) {
  const e = byName.get(name);
  if (!e) {
    failures.push(`${origin.get(name)} calls E.${name} but the module does not export it`);
  } else if (e.kind !== 'function') {
    failures.push(`${origin.get(name)} calls E.${name} but the module exports it as ${e.kind}, not a function`);
  }
}

const mem = byName.get(MEMORY_EXPORT);
if (!mem) {
  failures.push(`the module must export its linear memory as "${MEMORY_EXPORT}"`);
} else if (mem.kind !== 'memory') {
  failures.push(`export "${MEMORY_EXPORT}" must be a memory but is a ${mem.kind}`);
}

const declaredPages = watMemoryFloor();
if (!failures.length) {
  // Instantiation is safe precisely because the module declares no imports.
  const instance = await WebAssembly.instantiate(mod, {});
  const e = instance.exports;
  const buf = e.memory.buffer;

  if (declaredPages !== null && buf.byteLength < declaredPages * 65536) {
    failures.push(
      `src/agent.wat declares ${declaredPages} initial memory pages (${declaredPages * 65536} B) ` +
      `but the compiled module starts at ${buf.byteLength} B`,
    );
  }

  // Bridge.js stages SSE bytes and tool results at scratch() + {0,0x4000,0x6000,0x8000}
  // plus 0xF000 for the history/tool-call staging records; history.Get writes 36 B there.
  const scratch = e.scratch();
  if (typeof scratch !== 'number' || scratch % 4 !== 0 || scratch <= 0) {
    failures.push(`scratch() must return a positive 4-byte-aligned address, got ${scratch}`);
  } else if (scratch + 0xf000 + 36 > buf.byteLength) {
    failures.push(
      `scratch()=${scratch} plus the 0xF000 staging region the runtime writes does not fit ` +
      `in the ${buf.byteLength} B memory`,
    );
  }

  const rp = e.render_ptr();
  if (typeof rp !== 'number' || rp < 0 || rp >= buf.byteLength) {
    failures.push(`render_ptr()=${rp} is outside the ${buf.byteLength} B memory`);
  }

  // Lifecycle calls bridge.js makes unconditionally at boot.
  e.init();
  e.history_clear();
  if (e.history_count() !== 0) {
    failures.push(`history_count()=${e.history_count()} after history_clear(); expected 0`);
  }
  e.render_reset();
  if (e.render_len() !== 0) {
    failures.push(`render_len()=${e.render_len()} after render_reset(); expected 0`);
  }
}

if (failures.length) {
  console.error(`ABI FAIL (${wasmPath})`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`  module exports: ${exportList}`);
  console.error(`  module imports: ${imports.length}`);
  process.exit(1);
}

const memPages = declaredPages === null ? '?' : declaredPages;
console.log(`ABI OK (${exportList.split(', ').length} exports, 0 imports, ${expectedFns.size} used by js/, memory ${memPages}+ pages)`);

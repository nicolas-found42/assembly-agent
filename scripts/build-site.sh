#!/usr/bin/env bash
# build-site.sh — assemble the immutable production site into _site/ (R04).
#
#   bash scripts/build-site.sh              # compile wasm, stage, validate, inventory
#   bash scripts/build-site.sh --check-only # re-validate an already-built _site
#
# The staged tree is an ALLOWLIST, not a copy of the repository:
#
#   index.html                     self-hosted page (no external origin allowed)
#   styles.css                     stylesheet carrying the local @font-face entries
#   js/*.js                        every browser module reachable from js/main.js
#   dist/agent.wasm                wat2wasm output, wasm-validate + ABI checked
#   vendor/*.min.js                <- the lockfile-installed runtime libraries
#   assets/fonts/*.woff2           <- @fontsource packages (latin 400/700)
#   THIRD_PARTY_NOTICES.md         generated here from the packages' own licenses
#   build-info.json                commit + wasm/lockfile digests + toolchain + deps
#   .nojekyll                      required by GitHub Pages
#
# Test output, research/agent docs, Worker sources, scripts, fixtures, dotfiles,
# node_modules and symlinks are excluded by construction and checked again after
# staging. Nothing outside _site/ (and the gitignored dist/) is written or deleted.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
SITE=$ROOT/_site

MODE=build
for arg in "$@"; do
  case "$arg" in
    --check-only) MODE=check ;;
    -h|--help)
      echo "usage: bash scripts/build-site.sh [--check-only]"
      exit 0
      ;;
    *) echo "build-site: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

die() { echo "BUILD FAIL: $*" >&2; exit 1; }

# ── size budgets ────────────────────────────────────────────────────────
# Baseline measured from a clean build of this commit (evidence: .scratch/ci/evidence/s2-build.md):
#   dist/agent.wasm  7,069 B (7 KB)      whole _site tree  536,558 B (524 KB)
# The staged tree is dominated by vendored bytes, which are pinned: three
# libraries ~204 KB + three fonts ~61 KB + the app's own js/css ~217 KB. The
# engine is the only artifact that moves with application code, and its buffers
# are fixed-size data segments, so what crosses these absolute budgets is an
# accidental inclusion (a bundled asset, a new runtime library, a data blob),
# not ordinary code growth. Warn 16/640 KB, fail 32/768 KB ≈ 2.3x / 1.2x and
# 4.6x / 1.4x the measured baseline.
WASM_WARN_BYTES=$((16 * 1024))
WASM_FAIL_BYTES=$((32 * 1024))
SITE_WARN_BYTES=$((640 * 1024))
SITE_FAIL_BYTES=$((768 * 1024))

# ── vendor/font map: <source under the installed packages>:<staged path> ─
# marked v18 ships no *.min.js — lib/marked.umd.js is its browser UMD build and
# installs globalThis.marked, which js/markdown.js reads. The staged filename is
# the contracted vendor/marked.min.js. Bytes are copied from the lockfile-pinned
# packages and re-verified against them after staging.
VENDOR_MAP=$(cat <<'EOF'
node_modules/marked/lib/marked.umd.js:vendor/marked.min.js
node_modules/dompurify/dist/purify.min.js:vendor/purify.min.js
node_modules/@highlightjs/cdn-assets/highlight.min.js:vendor/highlight.min.js
node_modules/@fontsource/vt323/files/vt323-latin-400-normal.woff2:assets/fonts/vt323-latin-400.woff2
node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2:assets/fonts/jetbrains-mono-latin-400.woff2
node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2:assets/fonts/jetbrains-mono-latin-700.woff2
EOF
)

for tool in wat2wasm wasm-validate; do
  command -v "$tool" >/dev/null || die "$tool missing (brew install wabt / apt-get install wabt)"
done

# A failed build must never leave a tree that looks deployable: if anything in
# this script exits non-zero the partial _site is removed. --check-only never
# deletes: it inspects an existing artifact.
BUILD_OK=0
cleanup_partial() {
  [ "$MODE" = build ] && [ "$BUILD_OK" = 0 ] && rm -rf "$SITE"
  return 0
}
trap cleanup_partial EXIT

# license_section <title> <version> <added-from> <upstream url> <license file>
license_section() {
  printf '## %s %s\n\nAdded to the staged site from `%s`.\nUpstream: %s\n\n````text\n' "$1" "$2" "$3" "$4"
  cat "$5"
  printf '````\n\n'
}

if [ "$MODE" = build ]; then
  # ── 1. engine ─────────────────────────────────────────────────────────
  mkdir -p "$ROOT/dist"
  wat2wasm src/agent.wat -o dist/agent.wasm
  wasm-validate dist/agent.wasm
  node scripts/abi-check.mjs dist/agent.wasm
  echo "WASM OK dist/agent.wasm ($(wc -c < dist/agent.wasm | tr -d ' ') bytes)"

  # ── 2. clean only the generated tree this script owns ────────────────
  rm -rf "$SITE"
  mkdir -p "$SITE/js" "$SITE/dist" "$SITE/vendor" "$SITE/assets/fonts"

  # ── 3. vendored libraries + fonts ────────────────────────────────────
  while IFS=: read -r src dst; do
    [ -n "$src" ] || continue
    [ -f "$src" ] || die "required vendored file missing: $src (run npm ci)"
    cp "$src" "$SITE/$dst"
  done <<< "$VENDOR_MAP"

  # ── 4. application assets ────────────────────────────────────────────
  cp dist/agent.wasm "$SITE/dist/agent.wasm"
  cp js/*.js "$SITE/js/"
  cp .nojekyll "$SITE/.nojekyll"

  # index.html: the page must be fully self-hosted. An external origin is a
  # stale dependency reference (R03) and fails the build rather than being
  # rewritten silently, so drift shows up in review, not at runtime.
  if grep -nE 'https?://' index.html; then
    die "index.html references an external origin (lines above); runtime assets must be staged locally"
  fi
  for required in 'src="vendor/marked.min.js"' 'src="vendor/purify.min.js"' \
                  'src="vendor/highlight.min.js"' 'href="styles.css"' "'./js/main.js'"; do
    grep -qF "$required" index.html || die "index.html is missing the required reference $required"
  done
  cp index.html "$SITE/index.html"

  # styles.css must carry the self-hosted faces and no external origin.
  if grep -nE 'https?://' styles.css; then
    die "styles.css references an external origin (lines above)"
  fi
  for face in "font-family: 'VT323'" "font-family: 'JetBrains Mono'" \
              "url(assets/fonts/vt323-latin-400.woff2)" \
              "url(assets/fonts/jetbrains-mono-latin-400.woff2)" \
              "url(assets/fonts/jetbrains-mono-latin-700.woff2)"; do
    grep -qF "$face" styles.css || die "styles.css is missing the required @font-face entry: $face"
  done
  cp styles.css "$SITE/styles.css"

  # ── 5. notices (generated, no timestamp) ─────────────────────────────
  {
    echo "# Third-party notices"
    echo
    echo "The staged site redistributes the third-party work listed below. Files under"
    echo "vendor/ and assets/fonts/ are byte-for-byte copies of the lockfile-installed"
    echo "packages; scripts/build-site.sh regenerates this file, so it carries no date."
    echo
    license_section marked "$(node -p "require('./node_modules/marked/package.json').version")" \
      "node_modules/marked (lib/marked.umd.js -> vendor/marked.min.js)" \
      "https://www.npmjs.com/package/marked" node_modules/marked/LICENSE
    license_section DOMPurify "$(node -p "require('./node_modules/dompurify/package.json').version")" \
      "node_modules/dompurify (dist/purify.min.js -> vendor/purify.min.js)" \
      "https://www.npmjs.com/package/dompurify" node_modules/dompurify/LICENSE
    license_section "DOMPurify (MPL-2.0 alternative)" \
      "$(node -p "require('./node_modules/dompurify/package.json').version")" \
      "node_modules/dompurify (LICENSE-MPL)" \
      "https://www.npmjs.com/package/dompurify" node_modules/dompurify/LICENSE-MPL
    license_section highlight.js "$(node -p "require('./node_modules/@highlightjs/cdn-assets/package.json').version")" \
      "node_modules/@highlightjs/cdn-assets (highlight.min.js -> vendor/highlight.min.js)" \
      "https://www.npmjs.com/package/@highlightjs/cdn-assets" node_modules/@highlightjs/cdn-assets/LICENSE
    license_section "VT323 (SIL Open Font License 1.1)" \
      "$(node -p "require('./node_modules/@fontsource/vt323/package.json').version")" \
      "node_modules/@fontsource/vt323 (vt323-latin-400-normal.woff2 -> assets/fonts/vt323-latin-400.woff2)" \
      "https://www.npmjs.com/package/@fontsource/vt323" node_modules/@fontsource/vt323/LICENSE
    license_section "JetBrains Mono (SIL Open Font License 1.1)" \
      "$(node -p "require('./node_modules/@fontsource/jetbrains-mono/package.json').version")" \
      "node_modules/@fontsource/jetbrains-mono (latin 400/700 -> assets/fonts/jetbrains-mono-latin-*.woff2)" \
      "https://www.npmjs.com/package/@fontsource/jetbrains-mono" node_modules/@fontsource/jetbrains-mono/LICENSE
  } > "$SITE/THIRD_PARTY_NOTICES.md"

  # ── 6. build identity ────────────────────────────────────────────────
  node scripts/build-info.mjs --out "$SITE/build-info.json" --wasm "$SITE/dist/agent.wasm" >/dev/null
fi

# ── 7. validate the tree: allowlist, forbidden content, vendored bytes, budgets ──
SITE="$SITE" ROOT="$ROOT" VENDOR_MAP="$VENDOR_MAP" \
WASM_WARN_BYTES="$WASM_WARN_BYTES" WASM_FAIL_BYTES="$WASM_FAIL_BYTES" \
SITE_WARN_BYTES="$SITE_WARN_BYTES" SITE_FAIL_BYTES="$SITE_FAIL_BYTES" \
node --input-type=module - <<'NODE'
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const site = process.env.SITE;
const repoRoot = process.env.ROOT;
const budgets = {
  wasmWarn: Number(process.env.WASM_WARN_BYTES),
  wasmFail: Number(process.env.WASM_FAIL_BYTES),
  siteWarn: Number(process.env.SITE_WARN_BYTES),
  siteFail: Number(process.env.SITE_FAIL_BYTES),
};

const problems = [];
const warnings = [];
const entries = [];
const visit = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = join(dir, e.name);
    const rel = relative(site, abs).split(sep).join('/');
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) problems.push(`symlink: ${rel}`);
    else if (st.isDirectory()) visit(abs);
    else if (st.isFile()) entries.push({ rel, abs, bytes: st.size });
    else problems.push(`irregular entry: ${rel}`);
  }
};
visit(site);

// Expected tree: the contract allowlist, with js/*.js expanded from source.
const jsSource = readdirSync(join(repoRoot, 'js')).filter((f) => f.endsWith('.js')).sort();
const expected = new Set([
  'index.html', 'styles.css', 'dist/agent.wasm',
  'vendor/marked.min.js', 'vendor/purify.min.js', 'vendor/highlight.min.js',
  'assets/fonts/vt323-latin-400.woff2',
  'assets/fonts/jetbrains-mono-latin-400.woff2',
  'assets/fonts/jetbrains-mono-latin-700.woff2',
  'THIRD_PARTY_NOTICES.md', 'build-info.json', '.nojekyll',
  ...jsSource.map((f) => `js/${f}`),
]);

const present = new Map(entries.map((e) => [e.rel, e]));
for (const { rel } of entries) {
  const segments = rel.split('/');
  const name = segments.at(-1);
  if (segments.some((s) => ['test', 'tests', 'scripts', 'fixtures', 'node_modules', '.git', '.github', '.env'].includes(s))) {
    problems.push(`forbidden path segment: ${rel}`);
    continue;
  }
  if (name.startsWith('.') && rel !== '.nojekyll') {
    problems.push(`forbidden dotfile: ${rel}`);
    continue;
  }
  if (name.endsWith('.md') && rel !== 'THIRD_PARTY_NOTICES.md') {
    problems.push(`forbidden markdown file: ${rel}`);
    continue;
  }
  if (!expected.has(rel)) problems.push(`unexpected file (not in the staging allowlist): ${rel}`);
}
for (const rel of [...expected].sort()) {
  if (!present.has(rel)) problems.push(`required file missing from the site: ${rel}`);
}

// Vendored bytes must still equal the installed package bytes (R03).
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
for (const line of (process.env.VENDOR_MAP || '').split('\n')) {
  const [src, dst] = line.split(':');
  if (!src) continue;
  if (!present.has(dst)) continue; // already reported as missing
  try {
    const srcHash = sha(join(repoRoot, src));
    const dstHash = sha(join(site, dst));
    if (srcHash !== dstHash) problems.push(`vendored bytes differ from ${src}: ${dst}`);
  } catch {
    warnings.push(`cannot re-check vendored bytes for ${src} (not installed here)`);
  }
}

// Every staged module must be reachable from the entry the page loads.
const jsFiles = entries.filter((e) => e.rel.startsWith('js/')).map((e) => e.rel);
const referenced = new Set();
for (const rel of jsFiles) {
  for (const m of readFileSync(join(site, rel), 'utf8').matchAll(/['"]\.\/([A-Za-z0-9_.-]+\.js)['"]/g)) {
    referenced.add(`js/${m[1]}`);
  }
}
for (const rel of jsFiles) {
  if (rel !== 'js/main.js' && !referenced.has(rel)) problems.push(`unreferenced module staged into the artifact: ${rel}`);
}

const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
const wasm = present.get('dist/agent.wasm');

if (wasm && wasm.bytes > budgets.wasmFail) problems.push(`WASM size ${wasm.bytes} B exceeds the ${budgets.wasmFail} B fail budget`);
else if (wasm && wasm.bytes > budgets.wasmWarn) warnings.push(`WASM size ${wasm.bytes} B exceeds the ${budgets.wasmWarn} B warn budget`);
if (totalBytes > budgets.siteFail) problems.push(`site size ${totalBytes} B exceeds the ${budgets.siteFail} B fail budget`);
else if (totalBytes > budgets.siteWarn) warnings.push(`site size ${totalBytes} B exceeds the ${budgets.siteWarn} B warn budget`);

if (problems.length) {
  console.error('SITE FAIL _site');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
for (const w of warnings) console.warn(`SITE WARN: ${w}`);
console.log(`SITE OK _site (${entries.length} files, wasm ${wasm ? wasm.bytes : 0} B, total ${totalBytes} B)`);
NODE

# ── 8. inventory (kept outside _site: no self-reference) ────────────────
if [ "$MODE" = build ]; then
  node scripts/site-inventory.mjs --write "$SITE"
  BUILD_OK=1
  echo "BUILD OK _site"
else
  node scripts/site-inventory.mjs --verify "$SITE"
  echo "SITE CHECK OK _site"
fi

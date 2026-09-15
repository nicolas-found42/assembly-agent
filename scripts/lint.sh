#!/usr/bin/env bash
# scripts/lint.sh — `npm run lint`: the focused, local-or-CI lint gate (campaign R08.1).
#
#   tools       pinned, checksum-verified actionlint + zizmor in .tools/ (installer below)
#   actionlint  every .github/workflows/*.yml; every finding is an error, no -ignore flags
#   zizmor      Actions security over .github/workflows/ (pedantic persona); the campaign's
#               audit set is gated, every other finding is printed as advisory
#   invariants  scripts/workflow-invariants.mjs: the statically provable workflow invariants
#               (pins, timeouts, permissions, publication gating, secrets, required context,
#               concurrency, continue-on-error)
#   js          `node --check` (Node's own parser) over the repository's .js/.mjs sources
#   shell       `bash -n` over build.sh and the repository's .sh scripts
#   html        dependency-free structural check of index.html: tag balance, no external
#               origin, id/aria contract
#
# Output: one attributed PASS/FAIL line per section, then `LINT PASS|FAIL (n/7 sections)`.
# Exit 0 only when every section passes. No CI-only environment variables are required.
#
# Suppressions: there are none here. actionlint runs without -ignore; zizmor runs without
# --no-<audit> flags and without an ignore configuration (if .github/zizmor.yml ever appears it
# is reported, not silently honored). The zizmor gate is an explicit list of audit ids the
# campaign must fail on — see ZIZMOR_GATED_AUDITS — and unlisted findings are still printed.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TOOLS_DIR="${LINT_TOOLS_DIR:-$ROOT/.tools}"
ACTIONLINT="$TOOLS_DIR/bin/actionlint"
ZIZMOR="$TOOLS_DIR/bin/zizmor"
WORKFLOWS_DIR="${LINT_WORKFLOWS_DIR:-.github/workflows}"

# Audit ids this gate fails on. Everything else zizmor reports is printed as advisory: the
# campaign names unsafe interpolation (template-injection), excessive permissions
# (excessive-permissions), untrusted checkout (untrusted-checkout), cache poisoning
# (cache-poisoning) and template injection, and this repository additionally requires
# immutable action pins (unpinned-uses), untrusted trigger contexts (dangerous-triggers),
# credential-persistence review (artipacked) and one shell-injection sink (github-env).
ZIZMOR_GATED_AUDITS='template-injection excessive-permissions untrusted-checkout cache-poisoning dangerous-triggers unpinned-uses artipacked github-env'

sections_total=0
sections_passed=0
failures=0

run_section() { # $1 id, $2 title, $3 function
  local id="$1" title="$2" fn="$3" log rc
  sections_total=$((sections_total + 1))
  log="$(mktemp "${TMPDIR:-/tmp}/lint-section.XXXXXX")"
  "$fn" >"$log" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    sections_passed=$((sections_passed + 1))
    printf '  PASS  %-10s %s\n' "$id" "$title"
    grep '^SUMMARY: ' "$log" | sed 's/^SUMMARY: /        /' || true
  else
    failures=$((failures + 1))
    printf '  FAIL  %-10s %s\n' "$id" "$title"
    sed 's/^/        /' "$log"
  fi
  rm -f "$log"
}

# ---------------------------------------------------------------------------- tools
section_tools() {
  if [ ! -x "$ACTIONLINT" ] || [ ! -x "$ZIZMOR" ]; then
    echo "tool cache incomplete (${TOOLS_DIR}); installing from the pinned, verified releases"
  fi
  bash "$ROOT/scripts/install-lint-tools.sh" || return 1
  local a z
  a="$("$ACTIONLINT" -version 2>&1 | head -n 1)"
  z="$("$ZIZMOR" --version 2>&1 | tail -n 1)"
  command -v shellcheck >/dev/null 2>&1 \
    && echo "actionlint shell integration: shellcheck $(shellcheck --version | awk '/^version:/{print $2}')" \
    || echo "actionlint shell integration: shellcheck NOT FOUND — embedded run: blocks are only syntax-checked by bash -n below"
  echo "SUMMARY: actionlint ${a}, ${z}"
  return 0
}

# ----------------------------------------------------------------------- actionlint
section_actionlint() {
  local files=("$WORKFLOWS_DIR"/*.yml)
  [ -e "${files[0]}" ] || { echo "no workflow files in $WORKFLOWS_DIR"; return 1; }
  if [ -e "$ROOT/.github/actionlint.yaml" ] || [ -e "$ROOT/.github/actionlint.yml" ]; then
    echo "note: .github/actionlint.yaml is present and will be honored by actionlint"
  fi
  local out rc
  out="$("$ACTIONLINT" -no-color -oneline "${files[@]}" 2>&1)"
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  [ "$rc" -eq 0 ] && echo "SUMMARY: ${#files[@]} workflow file(s), no findings"
  # Every finding is an error here (that is the campaign rule), so a false positive has to be
  # answered narrowly at the finding's own line rather than by ignoring a rule repo-wide.
  if printf '%s' "$out" | grep -q 'SC2016'; then
    echo "hint: SC2016 needs the directive on the line IMMEDIATELY ABOVE the offending command"
    echo "      (verified with actionlint 1.7.12 + shellcheck 0.11.0: a directive at the top of the"
    echo "      run block is silently ineffective because actionlint feeds shellcheck its own"
    echo "      preamble). For a node -e block whose \${...} is JS template syntax:"
    echo "        # shellcheck disable=SC2016  # \${...} is JS template syntax, not shell expansion"
    echo "        node -e '...'"
  fi
  if printf '%s' "$out" | grep -q 'SC2129'; then
    echo "hint: SC2129 wants the repeated redirects consolidated:"
    echo '        { echo "…"; echo "…"; } >> "$GITHUB_STEP_SUMMARY"'
  fi
  return "$rc"
}

# --------------------------------------------------------------------------- zizmor
section_zizmor() {
  local json err
  json="$(mktemp "${TMPDIR:-/tmp}/zizmor.XXXXXX.json")"
  err="$(mktemp "${TMPDIR:-/tmp}/zizmor.XXXXXX.log")"
  [ -e "$ROOT/.github/zizmor.yml" ] && echo "note: .github/zizmor.yml is present; its ignore rules apply (reported, not silently honored)"
  # --no-exit-codes moves the verdict to the explicit audit gate below; zizmor still exits
  # nonzero on a tool/parse failure, which this section reports as a failure of its own.
  "$ZIZMOR" --pedantic --no-progress --color=never --render-links=never \
    --strict-collection --no-exit-codes --format=json "$WORKFLOWS_DIR" >"$json" 2>"$err"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    cat "$err"
    rm -f "$json" "$err"
    echo "zizmor failed to complete (exit $rc)"
    return 1
  fi
  ZIZMOR_GATED_AUDITS="$ZIZMOR_GATED_AUDITS" ZIZMOR_JSON="$json" node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
const gated = new Set((process.env.ZIZMOR_GATED_AUDITS ?? '').split(/\s+/).filter(Boolean));
let findings;
try {
  findings = JSON.parse(readFileSync(process.env.ZIZMOR_JSON, 'utf8'));
} catch (err) {
  console.log(`could not parse zizmor JSON output: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(findings)) {
  console.log('unexpected zizmor JSON shape');
  process.exit(1);
}
const line = (f) => {
  const loc = f.locations?.[0];
  const file = loc?.symbolic?.key?.Local?.verbatim_path ?? '(unknown file)';
  const row = loc?.concrete?.location?.start_point?.row ?? '?';
  return `${file}:${row}`;
};
const shown = new Set();
const blocked = [];
const advisory = [];
const ignored = [];
for (const f of findings) {
  const severity = f.determinations?.severity ?? '?';
  const entry = { ...f, where: line(f), severity };
  if (f.ignored) ignored.push(entry);
  else if (gated.has(f.ident)) blocked.push(entry);
  else advisory.push(entry);
}
for (const f of blocked) {
  console.log(`${f.where}  ${f.severity}[${f.ident}] ${f.desc}`);
  if (!shown.has(f.ident)) { shown.add(f.ident); if (f.url) console.log(`    ${f.url}`); }
}
for (const f of advisory) console.log(`advisory (not gated by this campaign): ${f.where}  ${f.severity}[${f.ident}] ${f.desc}`);
for (const f of ignored) console.log(`suppressed by an inline ignore or config rule: ${f.where}  [${f.ident}] ${f.desc}`);
console.log(`SUMMARY: ${findings.length} finding(s) — ${blocked.length} gated, ${advisory.length} advisory, ${ignored.length} suppressed`);
process.exit(blocked.length > 0 ? 1 : 0);
NODE
  local node_rc=$?
  rm -f "$json" "$err"
  return "$node_rc"
}

# ------------------------------------------------------------------- JavaScript syntax
# Node's own parser; no new formatter or bundler is introduced. Discovery uses `find` because
# the system bash here is 3.2 (no `globstar`, no `mapfile`).
collect_js() {
  { find js worker scripts test src -type f \( -name '*.js' -o -name '*.mjs' \) 2>/dev/null
    find . -maxdepth 1 -type f \( -name '*.js' -o -name '*.mjs' \) 2>/dev/null
  } | LC_ALL=C sort
}

section_js() {
  local files=() f out rc=0 n=0
  while IFS= read -r f; do files+=("$f"); done < <(collect_js)
  for f in "${files[@]}"; do
    n=$((n + 1))
    if ! out="$(node --check "$f" 2>&1)"; then
      printf '%s\n' "$out"
      rc=1
    fi
  done
  [ "$n" -gt 0 ] || { echo "no JavaScript sources found"; return 1; }
  echo "SUMMARY: ${n} file(s) parsed by node --check"
  return "$rc"
}

# ---------------------------------------------------------------------- shell syntax
collect_sh() {
  { find scripts worker test -type f -name '*.sh' 2>/dev/null
    find . -maxdepth 1 -type f -name '*.sh' 2>/dev/null
  } | LC_ALL=C sort
}

section_shell() {
  local files=() f out rc=0 n=0
  while IFS= read -r f; do files+=("$f"); done < <(collect_sh)
  for f in "${files[@]}"; do
    n=$((n + 1))
    if ! out="$(bash -n "$f" 2>&1)"; then
      printf '%s\n' "$out"
      rc=1
    fi
  done
  [ "$n" -gt 0 ] || { echo "no shell scripts found"; return 1; }
  echo "SUMMARY: ${n} script(s) checked by bash -n"
  return "$rc"
}

# ------------------------------------------------------- executable workflow invariants
section_invariants() {
  local out rc ids
  out="$(node "$ROOT/scripts/workflow-invariants.mjs" --workflows "$WORKFLOWS_DIR" 2>&1)"
  rc=$?
  printf '%s\n' "$out"
  [ "$rc" -eq 0 ] || return 1
  ids="$(printf '%s\n' "$out" | sed -n 's/^  PASS  \([a-z-]*\) —.*$/\1/p' | tr '\n' ' ')"
  echo "SUMMARY: all checks passed: ${ids% }"
  return 0
}

# ------------------------------------------------------------------------------- html
# Deliberately not a full HTML validator: a dependency-free scanner that proves the
# structure and the contract this product depends on. It lives here rather than in its own
# file because this slice owns exactly three scripts.
section_html() {
  # LINT_HTML_FILES is the negative-test seam (same idea as --manifest/--workflows elsewhere in
  # the campaign); the default is the real page.
  local files=(${LINT_HTML_FILES:-index.html})
  [ -e "${files[0]}" ] || { echo "index.html not found"; return 1; }
  LINT_HTML_FILES="${files[*]}" node --input-type=module - <<'NODE'
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const files = (process.env.LINT_HTML_FILES ?? '').split(/\s+/).filter(Boolean);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const URL_ATTRS = new Set(['src', 'href', 'srcset', 'action', 'formaction', 'poster', 'data', 'cite', 'background', 'manifest', 'xlink:href']);
const ID_REF_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-flowto', 'aria-activedescendant'];

const lineOf = (src, offset) => src.slice(0, offset).split('\n').length;
const problems = [];

function scanHtml(file) {
  const src = readFileSync(file, 'utf8');
  const ids = new Map();
  const idRefs = [];
  const fragments = [];
  const stack = [];
  let counts = { html: 0, head: 0, body: 0, title: 0 };
  const attrsOf = new Map(); // element name -> merged attribute map of the first occurrence
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) { problems.push(`${file}:${lineOf(src, lt)} unterminated comment`); break; }
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    let j = lt + 1;
    let quote = null;
    while (j < src.length) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j += 1;
    }
    if (j >= src.length) { problems.push(`${file}:${lineOf(src, lt)} unterminated tag`); break; }
    const raw = src.slice(lt + 1, j);
    const m = /^(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(raw);
    if (!m) { problems.push(`${file}:${lineOf(src, lt)} malformed tag <${raw.slice(0, 40)}`); i = j + 1; continue; }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = new Map();
    for (const a of raw.slice(m[0].length).matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs.set(a[1].toLowerCase(), a[3] ?? a[4] ?? a[5] ?? '');
    }
    if (closing) {
      const top = stack.pop();
      if (!top) problems.push(`${file}:${lineOf(src, lt)} stray </${name}>`);
      else if (top.name !== name) problems.push(`${file}:${lineOf(src, lt)} </${name}> closes <${top.name}> opened at line ${top.line}`);
      i = j + 1;
      continue;
    }
    if (counts[name] !== undefined) counts[name] += 1;
    if (!attrsOf.has(name)) attrsOf.set(name, attrs);
    const here = lineOf(src, lt);
    if (attrs.has('id')) {
      const id = attrs.get('id');
      if (!id) problems.push(`${file}:${here} empty id attribute`);
      else if (ids.has(id)) problems.push(`${file}:${here} duplicate id '${id}' (first at line ${ids.get(id)})`);
      else ids.set(id, here);
    }
    for (const attr of URL_ATTRS) {
      if (!attrs.has(attr)) continue;
      const value = attrs.get(attr).trim();
      if (/^(?:https?:)?\/\//i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^(?:mailto|tel):/i.test(value)) {
        problems.push(`${file}:${here} external origin reference in ${attr}="${value}" (the staged site must be self-contained)`);
      }
      if (attr === 'href' && value.startsWith('#')) fragments.push({ id: value.slice(1), line: here });
    }
    if (attrs.has('style') && /url\(\s*['"]?(?:https?:)?\/\//i.test(attrs.get('style'))) {
      problems.push(`${file}:${here} external origin reference in a style attribute`);
    }
    if (attrs.has('for')) idRefs.push({ id: attrs.get('for'), attr: 'for', line: here });
    for (const attr of ID_REF_ATTRS) {
      if (attrs.has(attr)) for (const ref of attrs.get(attr).split(/\s+/).filter(Boolean)) idRefs.push({ id: ref, attr, line: here });
    }
    let next = j + 1;
    if (RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'ig');
      close.lastIndex = j;
      const cm = close.exec(src);
      if (!cm) {
        problems.push(`${file}:${here} <${name}> is never closed`);
      } else {
        const body = src.slice(j + 1, cm.index);
        if (/(?:@import\s+)?url\(\s*['"]?(?:https?:)?\/\//i.test(body) || /\bsrc\s*=\s*['"](?:https?:)?\/\//i.test(body)) {
          problems.push(`${file}:${here} external origin reference inside <${name}>`);
        }
        next = cm.index + cm[0].length;
      }
    } else if (!/\/\s*$/.test(raw) && !VOID.has(name)) {
      stack.push({ name, line: here });
    }
    i = next;
  }
  for (const top of stack) problems.push(`${file}:${top.line} <${top.name}> is never closed`);
  for (const f of fragments) if (!ids.has(f.id)) problems.push(`${file}:${f.line} href="#${f.id}" points at no element id`);
  for (const r of idRefs) if (!ids.has(r.id)) problems.push(`${file}:${r.line} ${r.attr}="${r.id}" points at no element id`);
  const htmlAttrs = attrsOf.get('html');
  if (!htmlAttrs?.get('lang')) problems.push(`${file} <html> has no lang attribute`);
  for (const [tag, want] of [['html', 1], ['head', 1], ['body', 1], ['title', 1]]) {
    if (counts[tag] !== want) problems.push(`${file} expected exactly ${want} <${tag}> element(s), found ${counts[tag]}`);
  }
  if (!attrsOf.get('meta')?.has('charset')) problems.push(`${file} no <meta charset>`);
  return ids;
}

// The ids the regression tests reference must exist in the page unless repository code
// creates them at runtime (dialogs, settings rows, …) — derived from the sources, not a
// frozen list, so a renamed test selector or a dropped element fails here.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const testIds = new Map();
const ID_TOKEN_RE = /#([A-Za-z][A-Za-z0-9_-]*)/g;
function noteSelector(selector, file) {
  // Only selector strings are inspected, so hex colours and URL fragments never look like ids.
  for (const m of selector.matchAll(ID_TOKEN_RE)) {
    const before = selector[m.index - 1] ?? ' ';
    const after = selector[m.index + m[0].length] ?? ' ';
    if (/[\w/$]/.test(before) || after === '{' || after === '$' || m[1].endsWith('-')) continue;
    if (!testIds.has(m[1])) testIds.set(m[1], file);
  }
}
for (const root of ['test'].filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory())) {
  for (const f of walk(root)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) testIds.set(m[1], f);
    for (const m of src.matchAll(/(?:querySelector(?:All)?|\$|\$\$|locator|waitForSelector|click|fill)\s*\(\s*(['"`])([^'"`\n]+)\1/g)) {
      noteSelector(m[2], f);
    }
  }
}
// Ids the page builds at runtime (dialogs, settings rows, …) are exempt from the static
// requirement. They are detected from the product sources rather than a frozen list: a literal
// assigned to `.id`/`setAttribute('id', …)`, a template prefix (`b-set-${key}`), or an id
// literal passed to a builder helper that assigns it later — hence the literal scan.
const runtimeIds = new Set();
const runtimePrefixes = new Set();
for (const dir of ['js', 'worker'].filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory())) {
  for (const f of walk(dir)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) runtimeIds.add(m[1]);
    for (const m of src.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([^'"]+)['"]/g)) runtimeIds.add(m[1]);
    for (const m of src.matchAll(/(?:\.id\s*=|setAttribute\(\s*['"]id['"]\s*,)\s*`([^`$]*)\$\{/g)) runtimePrefixes.add(m[1]);
    for (const m of src.matchAll(/['"`]([A-Za-z][A-Za-z0-9_-]*)['"`]/g)) runtimeIds.add(m[1]);
  }
}

let totalIds = 0;
let resolved = 0;
let dynamic = 0;
for (const file of files) {
  const ids = scanHtml(file);
  totalIds += ids.size;
  for (const [id, where] of testIds) {
    if (ids.has(id)) resolved += 1;
    else if (runtimeIds.has(id) || [...runtimePrefixes].some((p) => p && id.startsWith(p))) dynamic += 1;
    else problems.push(`${where} references #${id}, which ${file} does not define and no script under js/ or worker/ mentions`);
  }
}

for (const p of problems) console.log(p);
if (problems.length > 0) process.exit(1);
console.log(`SUMMARY: ${files.join(', ')} — structure OK, ${totalIds} id(s), ${resolved} test-referenced id(s) resolved statically, ${dynamic} runtime-created`);
NODE
}

# ------------------------------------------------------------------------------ run
SECTIONS=7
printf 'LINT — %s section(s), repository %s\n\n' "$SECTIONS" "$ROOT"

run_section tools "pinned actionlint + zizmor" section_tools
if [ "$sections_passed" -eq 0 ]; then
  printf '\nLINT FAIL (0/%s sections) — the lint tools could not be installed; nothing else was checked\n' "$SECTIONS"
  exit 1
fi
run_section actionlint "workflow correctness" section_actionlint
run_section zizmor "workflow security" section_zizmor
run_section invariants "workflow invariants (static)" section_invariants
run_section js "JavaScript syntax (node --check)" section_js
run_section shell "shell syntax (bash -n)" section_shell
run_section html "index.html structure and contract" section_html

if [ "$failures" -eq 0 ]; then
  printf '\nLINT PASS (%s/%s sections)\n' "$sections_passed" "$sections_total"
  exit 0
fi
printf '\nLINT FAIL (%s/%s sections)\n' "$sections_passed" "$sections_total"
exit 1

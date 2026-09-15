#!/usr/bin/env bash
# scripts/install-lint-tools.sh — pinned, checksum-verified install of the linters
# (actionlint, zizmor, shellcheck) into a repo-local cache: .tools/bin.
#
# Why this shape: `npm run lint` (scripts/lint.sh) must not depend on whatever a
# package manager or a curl-to-shell installer happens to serve today. Nothing is
# piped into a shell; every archive is downloaded over HTTPS and checked against a
# pinned SHA-256 BEFORE it is unpacked; an unknown OS/arch is a hard error, never a
# guess and never a fallback to `latest`.
#
# UPDATE PROCEDURE (deliberate, one commit):
#   1. choose the new tag and set ACTIONLINT_VERSION / ZIZMOR_VERSION / SHELLCHECK_VERSION below;
#   2. refresh the recorded digests from the primary source:
#        actionlint: curl -fsSL https://github.com/rhysd/actionlint/releases/download/v$V/actionlint_${V}_checksums.txt
#        zizmor:     gh api repos/zizmorcore/zizmor/releases/latest \
#                      --jq '.assets[] | .name + " " + .digest'
#        pinned shellcheck digests: gh api repos/koalaman/shellcheck/releases/latest \
#                      --jq '.assets[] | .name + " " + .digest'
#      (zizmor and shellcheck publish per-asset digests, not a checksums file; the API
#      digest and a locally streamed `shasum -a 256` must agree before recording it here.)
#   3. paste the digests into the PLATFORMS table and run
#      `bash scripts/install-lint-tools.sh --refresh` on a supported platform.
#   A digest that cannot be obtained from the primary source is a stop condition -
#   there is no unverified path in this script.
#
# Usage: bash scripts/install-lint-tools.sh [--refresh] [--print-versions]
#   --refresh         re-download and re-verify even when a pinned binary is cached
#   --print-versions  print the resolved tool versions and exit (no download)
# Exit 0 only when every tool is present at its pinned version.

set -euo pipefail

ACTIONLINT_VERSION=1.7.12
ZIZMOR_VERSION=1.30.1
SHELLCHECK_VERSION=0.11.0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${LINT_TOOLS_DIR:-$ROOT/.tools}"
BIN_DIR="$TOOLS_DIR/bin"

die() { printf 'INSTALL-LINT-TOOLS FAIL — %s\n' "$1" >&2; exit 1; }

usage() {
  printf '%s\n' \
    'usage: bash scripts/install-lint-tools.sh [--refresh] [--print-versions]' \
    '' \
    'Pinned versions (edit the script to move them):' \
    "  actionlint $ACTIONLINT_VERSION" \
    "  zizmor     $ZIZMOR_VERSION" \
    "  shellcheck $SHELLCHECK_VERSION" \
    '' \
    "Cache: $TOOLS_DIR (override with LINT_TOOLS_DIR)"
}

refresh=0
print_only=0
for arg in "$@"; do
  case "$arg" in
    --refresh) refresh=1 ;;
    --print-versions) print_only=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $arg" ;;
  esac
done

# ---------------------------------------------------------------- platform table
# One row per supported runner: OS-arch key -> upstream asset names + pinned digests.
# actionlint ships `actionlint_<v>_<os>_<arch>.tar.gz` for exactly these four; zizmor
# ships Rust target triples; shellcheck ships `shellcheck-v<v>.<os>.<target>.tar.gz`
# (its own x86_64/aarch64 target names, mapped below). Anything else is unsupported
# and must fail loudly.
uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS '$uname_s' — supported: Darwin (macOS), Linux" ;;
esac
case "$uname_m" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported architecture '$uname_m' — supported: x86_64/amd64, arm64/aarch64" ;;
esac
platform="$os-$arch"

zizmor_asset=''
zizmor_sha=''
actionlint_sha=''
shellcheck_sha=''
case "$platform" in
  linux-amd64)
    zizmor_asset='zizmor-x86_64-unknown-linux-gnu.tar.gz'
    zizmor_sha='e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a'
    actionlint_sha='8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'
    shellcheck_sha='b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6'
    ;;
  linux-arm64)
    zizmor_asset='zizmor-aarch64-unknown-linux-gnu.tar.gz'
    zizmor_sha='7ff1dce33bdd18fd2a4affe63bdd47efcccca97b2cec1c1863ec26e9e2647540'
    actionlint_sha='325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6'
    shellcheck_sha='68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc'
    ;;
  darwin-amd64)
    zizmor_asset='zizmor-x86_64-apple-darwin.tar.gz'
    zizmor_sha='10e6b18b11ea07e515a16f0f0518c7b07527bc9977c1fd5698181ce7f3554202'
    actionlint_sha='5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644'
    shellcheck_sha='c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51'
    ;;
  darwin-arm64)
    zizmor_asset='zizmor-aarch64-apple-darwin.tar.gz'
    zizmor_sha='e28d22b087f9ebb8d99da6e740d348c930f559961c7c3f12badda54f882195a2'
    actionlint_sha='aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f'
    shellcheck_sha='339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f'
    ;;
  *) die "unsupported platform '$platform' (uname -s=$uname_s uname -m=$uname_m)" ;;
esac

actionlint_asset="actionlint_${ACTIONLINT_VERSION}_${os}_${arch}.tar.gz"
actionlint_url="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${actionlint_asset}"
zizmor_url="https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/${zizmor_asset}"
# The shellcheck asset spells the same two machine types differently (x86_64/aarch64).
case "$arch" in
  amd64) shellcheck_target=x86_64 ;;
  arm64) shellcheck_target=aarch64 ;;
esac
shellcheck_asset="shellcheck-v${SHELLCHECK_VERSION}.${os}.${shellcheck_target}.tar.gz"
shellcheck_url="https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/${shellcheck_asset}"

actionlint_bin="$BIN_DIR/actionlint"
zizmor_bin="$BIN_DIR/zizmor"
shellcheck_bin="$BIN_DIR/shellcheck"

# ------------------------------------------------------------- installed versions
# A cached binary counts as installed only when it answers with the pinned version;
# a stale or truncated binary is reinstalled instead of trusted.
actionlint_version_of() { "$1" -version 2>/dev/null | head -n 1 | tr -d 'v \n' || true; }
zizmor_version_of() { "$1" --version 2>/dev/null | awk '{print $NF}' | tr -d 'v \n' || true; }
shellcheck_version_of() { "$1" --version 2>/dev/null | awk '/^version:/{print $2}' || true; }

actionlint_cached=0
zizmor_cached=0
shellcheck_cached=0
[ -x "$actionlint_bin" ] && [ "$(actionlint_version_of "$actionlint_bin")" = "$ACTIONLINT_VERSION" ] && actionlint_cached=1
[ -x "$zizmor_bin" ] && [ "$(zizmor_version_of "$zizmor_bin")" = "$ZIZMOR_VERSION" ] && zizmor_cached=1
[ -x "$shellcheck_bin" ] && [ "$(shellcheck_version_of "$shellcheck_bin")" = "$SHELLCHECK_VERSION" ] && shellcheck_cached=1

if [ "$print_only" -eq 1 ]; then
  printf 'actionlint %s %s\n' "$ACTIONLINT_VERSION" "$([ "$actionlint_cached" -eq 1 ] && echo cached || echo missing)"
  printf 'zizmor %s %s\n' "$ZIZMOR_VERSION" "$([ "$zizmor_cached" -eq 1 ] && echo cached || echo missing)"
  printf 'shellcheck %s %s\n' "$SHELLCHECK_VERSION" "$([ "$shellcheck_cached" -eq 1 ] && echo cached || echo missing)"
  exit 0
fi

# --------------------------------------------------------------- download + verify
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "no SHA-256 tool found (need sha256sum or shasum) — refusing to install unverified binaries"
  fi
}

[ -d "$TOOLS_DIR" ] || mkdir -p "$BIN_DIR"
# Self-ignoring cache: the binaries are never committed, and this file makes that
# true even if the root .gitignore has not been updated yet.
printf '*\n' > "$TOOLS_DIR/.gitignore"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/assembly-agent-lint-tools.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

install_tool() { # $1 tool name, $2 pinned version, $3 url, $4 pinned sha256, $5 tarball member, $6 cached(0|1)
  local tool="$1" version="$2" url="$3" expected="$4" member="$5" cached="$6"
  local archive="$tmpdir/$tool.tar.gz" actual listed
  if [ "$cached" -eq 1 ] && [ "$refresh" -eq 0 ]; then
    printf '  %-11s %s (cached)\n' "$tool" "$version"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required to download $tool"
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 --max-time 300 -o "$archive" "$url" \
    || die "$tool download failed: $url"
  actual="$(sha256_of "$archive")"
  [ -n "$actual" ] || die "$tool checksum could not be computed"
  if [ "$actual" != "$expected" ]; then
    die "$tool checksum mismatch for $url
    expected sha256:$expected
    actual   sha256:$actual
  refusing to unpack; the pin and the published digest must be re-verified by hand"
  fi
  # The member is looked up by exact name before extraction so a tarball can never
  # write outside the staging directory.
  listed="$(tar -tzf "$archive")" || die "$tool archive is not a readable tar.gz"
  printf '%s\n' "$listed" | grep -qx -- "$member" || die "$tool archive does not contain '$member'"
  mkdir -p "$tmpdir/unpack/$tool"
  tar -xzf "$archive" -C "$tmpdir/unpack/$tool" -- "$member" || die "$tool extraction failed"
  cp "$tmpdir/unpack/$tool/$member" "$BIN_DIR/$tool.new"
  chmod 0755 "$BIN_DIR/$tool.new"
  mv -f "$BIN_DIR/$tool.new" "$BIN_DIR/$tool"
}

printf 'INSTALL-LINT-TOOLS (platform %s, cache %s)\n' "$platform" "$TOOLS_DIR"
install_tool actionlint "$ACTIONLINT_VERSION" "$actionlint_url" "$actionlint_sha" actionlint "$actionlint_cached"
install_tool zizmor "$ZIZMOR_VERSION" "$zizmor_url" "$zizmor_sha" zizmor "$zizmor_cached"
# The shellcheck tarball keeps its binary one directory down, named after the release.
install_tool shellcheck "$SHELLCHECK_VERSION" "$shellcheck_url" "$shellcheck_sha" \
  "shellcheck-v${SHELLCHECK_VERSION}/shellcheck" "$shellcheck_cached"

# Post-install assertion: the binary we are about to hand to lint.sh reports the
# pinned version. This catches a wrong-arch or truncated install immediately.
got_actionlint="$(actionlint_version_of "$actionlint_bin")"
got_zizmor="$(zizmor_version_of "$zizmor_bin")"
got_shellcheck="$(shellcheck_version_of "$shellcheck_bin")"
[ "$got_actionlint" = "$ACTIONLINT_VERSION" ] || die "actionlint at $actionlint_bin reports '$got_actionlint', expected $ACTIONLINT_VERSION"
[ "$got_zizmor" = "$ZIZMOR_VERSION" ] || die "zizmor at $zizmor_bin reports '$got_zizmor', expected $ZIZMOR_VERSION"
[ "$got_shellcheck" = "$SHELLCHECK_VERSION" ] || die "shellcheck at $shellcheck_bin reports '$got_shellcheck', expected $SHELLCHECK_VERSION"

printf 'LINT TOOLS OK\n'
printf '  actionlint %s  %s\n' "$got_actionlint" "$actionlint_bin"
printf '  zizmor     %s  %s\n' "$got_zizmor" "$zizmor_bin"
printf '  shellcheck %s  %s\n' "$got_shellcheck" "$shellcheck_bin"

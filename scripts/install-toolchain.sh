#!/usr/bin/env bash
# install-toolchain.sh — install the pinned WABT release into the repo-local,
# gitignored tool cache and put `wat2wasm` / `wasm-validate` on PATH (R06).
#
#   bash scripts/install-toolchain.sh           # install (idempotent)
#   bash scripts/install-toolchain.sh --force   # re-download even if cached
#   bash scripts/install-toolchain.sh --help
#
# Properties this script guarantees:
#   * The version is NOT declared here — it comes from `node scripts/toolchain.mjs
#     --pin wabt` (the single declaration for workflow use). `WABT_VERSION=<v>` may
#     override it for local experiments, but an unrecorded version fails: there is
#     no digest to verify against.
#   * Every download is checked against the release asset's published SHA-256
#     (digests below, resolved from the WABT release API and independently
#     reproduced by streaming the asset).
#     No curl-to-shell installer, no unversioned apt package, no unverified binary.
#   * The cache lives under artifacts/ (gitignored) so a failed install never
#     pollutes the work tree and `_site/` is never touched.
#   * Extraction happens only from a tarball that just verified; the two binaries
#     are copied into one stable bin/ directory inside the cache.
#   * The installed binaries must report the pinned version, so a stale or wrong
#     cache cannot silently become the build toolchain.
#   * Unsupported OS/architecture fails with the list of published assets instead
#     of falling back to something unverified.
#
# GitHub Actions: the cache bin/ directory is appended to $GITHUB_PATH, so later
# steps in the job (build, tests) use exactly these binaries. Developers who have
# a system WABT can keep using it: `scripts/build-site.sh` only asks that
# wat2wasm/wasm-validate exist on PATH.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --help|-h) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-toolchain: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

die() { echo "TOOLCHAIN FAIL: $*" >&2; exit 1; }

# ── pinned version (single declaration lives in scripts/toolchain.mjs) ───
if [ -n "${WABT_VERSION:-}" ]; then
  VERSION=$WABT_VERSION
else
  command -v node >/dev/null || die "node is required to read the pinned WABT version (or set WABT_VERSION)"
  VERSION=$(node scripts/toolchain.mjs --pin wabt) || die "could not read the WABT pin from scripts/toolchain.mjs"
fi
[ -n "$VERSION" ] || die "empty WABT version"

# ── platform detection (asset names are <os>-<arch>, not the uname spelling) ──
OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) die "unsupported OS '$OS': only Linux and macOS release assets are published" ;;
esac
case "$ARCH" in
  x86_64|amd64) ASSET_ARCH=x64 ;;
  arm64|aarch64) ASSET_ARCH=arm64 ;;
  *) die "unsupported architecture '$ARCH' for $PLATFORM" ;;
esac

ASSET="wabt-$VERSION-$PLATFORM-$ASSET_ARCH.tar.gz"
ASSET_URL="https://github.com/WebAssembly/wabt/releases/download/$VERSION/$ASSET"

# ── published SHA-256 per <version>:<os>-<arch> (release API `digest` field) ──
digest_for() {
  case "$1:$2-$3" in
    1.0.41:linux-x64)     echo 83f8122e924745fcd70636e3594bc01c4c47f2d4c8f3c63b5d70d3f83a482677 ;;
    1.0.41:linux-arm64)   echo 5e35416ee8725dc7cc0572e4392a8117cbf008b0e34c0db65c75506b0299cdbf ;;
    1.0.41:macos-arm64)   echo e5269d6bbe05dfeb179e4f21111b3a641d6ccaa38b0b21d472ae5c65f8c4ff5d ;;
    *) return 1 ;;
  esac
}
EXPECTED=$(digest_for "$VERSION" "$PLATFORM" "$ASSET_ARCH") || die \
  "no recorded SHA-256 for WABT $VERSION on $PLATFORM-$ASSET_ARCH: publish the digest for the release asset first (never install an unverified binary)"

sha256_file() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "neither sha256sum nor shasum is available to verify the download"
  fi
}

CACHE="$ROOT/artifacts/tools/wabt-$VERSION-$PLATFORM-$ASSET_ARCH"
TARBALL="$CACHE/$ASSET"
BIN="$CACHE/bin"
mkdir -p "$CACHE"

# ── download (bounded) and verify; a cached tarball is re-verified every run ──
verified=0
for attempt in 1 2; do
  if [ "$FORCE" = 1 ] || [ ! -f "$TARBALL" ]; then
    rm -f "$TARBALL"
    echo "TOOLCHAIN download $ASSET (attempt $attempt)"
    curl -fsSL --max-time 180 --retry 2 --retry-delay 2 -o "$TARBALL.part" "$ASSET_URL" \
      || die "download failed: $ASSET_URL"
    mv "$TARBALL.part" "$TARBALL"
    FORCE=0
  fi
  actual=$(sha256_file "$TARBALL")
  if [ "$actual" = "$EXPECTED" ]; then
    verified=1
    break
  fi
  echo "TOOLCHAIN checksum mismatch for cached $ASSET (got $actual, want $EXPECTED) — refetching" >&2
  rm -f "$TARBALL"
done
[ "$verified" = 1 ] || die "SHA-256 mismatch for $ASSET (want $EXPECTED) — refusing to install"

# ── extract from the verified tarball, keep only the two binaries we use ────
if [ ! -x "$BIN/wat2wasm" ] || [ ! -x "$BIN/wasm-validate" ]; then
  EXTRACT="$CACHE/extract"
  rm -rf "$EXTRACT"
  mkdir -p "$EXTRACT" "$BIN"
  tar -xzf "$TARBALL" -C "$EXTRACT" --strip-components=1 || die "could not extract $ASSET"
  for t in wat2wasm wasm-validate; do
    src="$EXTRACT/bin/$t"
    [ -x "$src" ] || die "$ASSET does not contain bin/$t"
    cp "$src" "$BIN/$t"
    chmod 755 "$BIN/$t"
  done
  rm -rf "$EXTRACT"
fi

# ── the installed binaries must be the pinned release ──────────────────────
for tool in wat2wasm wasm-validate; do
  got=$("$BIN/$tool" --version 2>/dev/null | head -n1 | tr -d '\r')
  [ "$got" = "$VERSION" ] || die "$tool reports '$got', expected pinned '$VERSION' ($BIN/$tool)"
done

# ── PATH for the rest of the job ───────────────────────────────────────────
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$BIN" >> "$GITHUB_PATH"
  echo "TOOLCHAIN PATH appended to GITHUB_PATH: $BIN"
else
  echo "TOOLCHAIN PATH export PATH=\"$BIN:\$PATH\""
fi
echo "WABT OK $VERSION $BIN (wat2wasm, wasm-validate)"

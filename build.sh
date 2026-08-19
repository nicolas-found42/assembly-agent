#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v wat2wasm >/dev/null || { echo "wat2wasm missing (brew install wabt / apt install wabt)"; exit 1; }
mkdir -p dist
wat2wasm src/agent.wat -o dist/agent.wasm
echo "OK dist/agent.wasm"

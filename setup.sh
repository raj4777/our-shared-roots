#!/usr/bin/env bash
# Cross-platform entry point (macOS / Linux). Windows users can run setup.ps1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org and re-run." >&2
  exit 1
fi
exec node "$ROOT/setup.mjs" "$@"

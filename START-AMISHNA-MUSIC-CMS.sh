#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo 'Node.js 24 or newer is required.'; exit 1; }
if command -v xdg-open >/dev/null 2>&1; then (sleep 2; xdg-open http://127.0.0.1:4175 >/dev/null 2>&1) & fi
exec node scripts/dev.js

#!/bin/zsh
set -e
PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"
AMISHNA_NODE_BINARY="$PROJECT_DIR/.local-runtime/node-v24.14.0-darwin-arm64/bin/node"
if [[ "$(uname -m)" != arm64 || ! -x "$AMISHNA_NODE_BINARY" ]]; then
  AMISHNA_NODE_BINARY="$(command -v node || true)"
fi
if [[ -z "$AMISHNA_NODE_BINARY" ]]; then
  echo "Node.js 24 or newer is required. Install it from https://nodejs.org"
  read -k 1 "?Press any key to close."
  exit 1
fi
( sleep 2; open "http://127.0.0.1:4175" ) &
exec "$AMISHNA_NODE_BINARY" scripts/dev.js

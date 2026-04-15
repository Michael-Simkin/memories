#!/bin/bash
# Finds a Node 24+ binary and launches the MCP server with it.
# Needed because projects may pin older Node versions via .nvmrc/nvm.

REQUIRED_MAJOR=24
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MCP_SCRIPT="$SCRIPT_DIR/dist/mcp/server.js"

find_node24() {
  local candidates=(
    "${TRANSCRIPTS_NODE_BIN:-}"
    "/opt/homebrew/opt/node@24/bin/node"
    "/usr/local/opt/node@24/bin/node"
  )

  # nvm versions
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -d "$nvm_dir/versions/node" ]; then
    for d in "$nvm_dir/versions/node"/v24.* "$nvm_dir/versions/node"/v25.* "$nvm_dir/versions/node"/v26.*; do
      [ -x "$d/bin/node" ] && candidates+=("$d/bin/node")
    done
  fi

  # volta
  if [ -d "$HOME/.volta/tools/image/node" ]; then
    for d in "$HOME/.volta/tools/image/node"/24.* "$HOME/.volta/tools/image/node"/25.* "$HOME/.volta/tools/image/node"/26.*; do
      [ -x "$d/bin/node" ] && candidates+=("$d/bin/node")
    done
  fi

  candidates+=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
  )

  for candidate in "${candidates[@]}"; do
    [ -z "$candidate" ] && continue
    [ ! -x "$candidate" ] && continue
    local version
    version=$("$candidate" -p 'process.versions.node' 2>/dev/null) || continue
    local major="${version%%.*}"
    if [ "$major" -ge "$REQUIRED_MAJOR" ] 2>/dev/null; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN=$(find_node24)
if [ -z "$NODE_BIN" ]; then
  echo '{"error":"Node 24+ not found for MCP server"}' >&2
  exit 1
fi

exec "$NODE_BIN" "$MCP_SCRIPT" "$@"

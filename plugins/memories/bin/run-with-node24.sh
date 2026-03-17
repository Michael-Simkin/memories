#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: run-with-node24.sh <script> [args...]" >&2
  exit 1
fi

current_node_bin="$(command -v node || true)"
configured_node24_bin="${CLAUDE_MEMORY_NODE24_BIN:-}"

if [ -n "$current_node_bin" ]; then
  current_node_version="$("$current_node_bin" --version)"
  current_node_major="${current_node_version#v}"
  current_node_major="${current_node_major%%.*}"

  if [ "$current_node_major" = "24" ]; then
    exec "$current_node_bin" "$@"
  fi
fi

if [ -n "$configured_node24_bin" ]; then
  case "$configured_node24_bin" in
    /*) ;;
    *)
      echo "CLAUDE_MEMORY_NODE24_BIN must be an absolute path when the launcher runtime is not Node 24." >&2
      exit 1
      ;;
  esac

  if [ ! -x "$configured_node24_bin" ]; then
    echo "CLAUDE_MEMORY_NODE24_BIN must point to an executable Node 24 binary." >&2
    exit 1
  fi

  exec "$configured_node24_bin" "$@"
fi

echo "Claude Memory requires Node 24 for runtime entrypoints. Either run Claude under Node 24 or set CLAUDE_MEMORY_NODE24_BIN to an absolute executable Node 24 binary path." >&2
exit 1

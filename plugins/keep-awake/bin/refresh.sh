#!/bin/sh
# Maintain ONE machine-wide caffeinate for all Claude sessions. On every hook,
# kill the prior Claude caffeinate (matched by its distinctive name, so a
# caffeinate you ran by hand is left alone) and start a fresh one that
# self-expires after the window. Fail-open: always exit 0.
set -u
. "$(dirname "$0")/common.sh"

keep_awake_enabled || exit 0

link=$(keep_awake_ensure_link) || exit 0

pkill -f "$keep_awake_tag" 2>/dev/null
"$link" -"$(keep_awake_flags)" -t "$(keep_awake_window)" >/dev/null 2>&1 &
exit 0

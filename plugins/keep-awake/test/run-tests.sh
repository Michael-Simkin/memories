#!/bin/sh
# Dependency-free tests for the keep-awake singleton hook.
# Shims `caffeinate` and `uname` onto PATH so we can observe behavior without
# touching real power assertions.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REFRESH="$ROOT/bin/refresh.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/keep-awake-test.XXXXXX")
SHIM="$WORK/shim"
mkdir -p "$SHIM"

CAFFEINATE_LOG="$WORK/caffeinate.log"
BLOCK_FIFO="$WORK/block.fifo"
mkfifo "$BLOCK_FIFO"
: > "$CAFFEINATE_LOG"

TAG=claude-keep-awake-caffeinate

# Fake caffeinate: record args, then block in-process (no child) until killed.
cat > "$SHIM/caffeinate" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$CAFFEINATE_LOG"
read _ < "$BLOCK_FIFO"
EOF
chmod +x "$SHIM/caffeinate"

# Fake uname: report whatever FAKE_UNAME says (default Darwin).
cat > "$SHIM/uname" <<'EOF'
#!/bin/sh
printf '%s\n' "${FAKE_UNAME:-Darwin}"
EOF
chmod +x "$SHIM/uname"

export PATH="$SHIM:$PATH"
export TMPDIR="$WORK"

cleanup() {
  pkill -f "$WORK" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf 'ok   - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL - %s\n' "$1"; }

count_tagged() { pgrep -f "$TAG" 2>/dev/null | wc -l | tr -d '[:space:]'; }
caffeinate_calls() { grep -c . "$CAFFEINATE_LOG" 2>/dev/null || true; }
log_line() { tail -n 1 "$CAFFEINATE_LOG" 2>/dev/null; }

reset_state() {
  # Assignments that prefix a function call persist in the shell, so clear the
  # per-test config to keep tests isolated.
  unset KEEP_AWAKE_FLAGS KEEP_AWAKE_WINDOW_SECONDS KEEP_AWAKE_DISABLE FAKE_UNAME
  pkill -f "$WORK" 2>/dev/null
  i=0
  while pgrep -f "$WORK" >/dev/null 2>&1 && [ "$i" -lt 40 ]; do
    sleep 0.05
    i=$((i + 1))
  done
  rm -rf "$WORK/claude-keep-awake"
  : > "$CAFFEINATE_LOG"
}

# caffeinate is spawned detached; poll until it has reacted.
wait_for_log_lines() {
  i=0
  while [ "$(caffeinate_calls)" -lt "$1" ] && [ "$i" -lt 40 ]; do
    sleep 0.05
    i=$((i + 1))
  done
}
wait_for_tagged() {
  i=0
  while [ "$(count_tagged)" -lt "$1" ] && [ "$i" -lt 40 ]; do
    sleep 0.05
    i=$((i + 1))
  done
}

run_refresh() { printf '%s' "${1:-}" | sh "$REFRESH"; }
PAYLOAD='{"hook_event_name":"PreToolUse"}'

# 1: refresh spawns caffeinate with default flags and timeout.
reset_state
run_refresh "$PAYLOAD"; rc=$?
wait_for_log_lines 1
[ "$rc" -eq 0 ] && pass "refresh exits 0" || fail "refresh exits 0 (got $rc)"
[ "$(log_line)" = "-dimsu -t 300" ] && pass "default flags -dimsu -t 300" \
  || fail "default flags -dimsu -t 300 (got '$(log_line)')"

# 2: env overrides flags and window.
reset_state
KEEP_AWAKE_FLAGS=i KEEP_AWAKE_WINDOW_SECONDS=60 run_refresh "$PAYLOAD"
wait_for_log_lines 1
[ "$(log_line)" = "-i -t 60" ] && pass "env flags -i -t 60" \
  || fail "env flags -i -t 60 (got '$(log_line)')"

# 3: the running caffeinate carries the Claude-specific name; exactly one exists.
reset_state
run_refresh "$PAYLOAD"
wait_for_tagged 1
[ "$(count_tagged)" -eq 1 ] && pass "one named claude caffeinate runs" \
  || fail "one named claude caffeinate runs (got $(count_tagged))"

# 4: refresh is a singleton — a second refresh replaces, never accumulates.
reset_state
run_refresh "$PAYLOAD"; wait_for_tagged 1
old=$(pgrep -f "$TAG" | head -1)
run_refresh "$PAYLOAD"; wait_for_log_lines 2
j=0
while kill -0 "$old" 2>/dev/null && [ "$j" -lt 40 ]; do sleep 0.05; j=$((j + 1)); done
if ! kill -0 "$old" 2>/dev/null; then pass "prior singleton killed"; \
  else fail "prior singleton killed"; fi
wait_for_tagged 1
[ "$(count_tagged)" -eq 1 ] && pass "still exactly one after refresh" \
  || fail "still exactly one after refresh (got $(count_tagged))"

# 5: a caffeinate started by hand (different name) is never killed.
reset_state
caffeinate -i -t 600 >/dev/null 2>&1 &
hand=$!
run_refresh "$PAYLOAD"; wait_for_tagged 1
if kill -0 "$hand" 2>/dev/null; then pass "hand-run caffeinate left alive"; \
  else fail "hand-run caffeinate left alive"; fi
[ "$(count_tagged)" -eq 1 ] && pass "hand-run not counted as ours" \
  || fail "hand-run not counted as ours (got $(count_tagged))"
kill "$hand" 2>/dev/null

# 6: non-Darwin is a no-op.
reset_state
FAKE_UNAME=Linux run_refresh "$PAYLOAD"; rc=$?
[ "$rc" -eq 0 ] && pass "non-Darwin exits 0" || fail "non-Darwin exits 0 (got $rc)"
[ "$(count_tagged)" -eq 0 ] && pass "non-Darwin spawns nothing" \
  || fail "non-Darwin spawns nothing (got $(count_tagged))"

# 7: KEEP_AWAKE_DISABLE is a no-op.
reset_state
KEEP_AWAKE_DISABLE=1 run_refresh "$PAYLOAD"; rc=$?
[ "$rc" -eq 0 ] && pass "disable exits 0" || fail "disable exits 0 (got $rc)"
[ "$(count_tagged)" -eq 0 ] && pass "disable spawns nothing" \
  || fail "disable spawns nothing (got $(count_tagged))"

# 8: garbage flags/window fall back to defaults.
reset_state
KEEP_AWAKE_FLAGS=garbage KEEP_AWAKE_WINDOW_SECONDS=abc run_refresh "$PAYLOAD"
wait_for_log_lines 1
[ "$(log_line)" = "-dimsu -t 300" ] && pass "garbage config falls back to defaults" \
  || fail "garbage config falls back to defaults (got '$(log_line)')"

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]

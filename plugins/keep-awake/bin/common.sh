# Shared helpers for the keep-awake hook. Sourced, never executed directly.

keep_awake_default_flags=dimsu
keep_awake_default_window=300

# Distinctive name for our caffeinate, so we can find and kill only ours and
# never a caffeinate the user started by hand.
keep_awake_tag=claude-keep-awake-caffeinate

# True when the plugin should act: enabled, on macOS, with caffeinate available.
keep_awake_enabled() {
  [ -z "${KEEP_AWAKE_DISABLE:-}" ] || return 1
  [ "$(uname)" = "Darwin" ] || return 1
  command -v caffeinate >/dev/null 2>&1 || return 1
}

keep_awake_state_dir() {
  printf '%s/claude-keep-awake\n' "${TMPDIR:-/tmp}"
}

# Create the state dir and a symlink to the real caffeinate under our name, so
# the running process is identifiable. Echoes the symlink path.
keep_awake_ensure_link() {
  dir=$(keep_awake_state_dir)
  mkdir -p "$dir" 2>/dev/null || return 1
  target=$(command -v caffeinate) || return 1
  link="$dir/$keep_awake_tag"
  ln -sf "$target" "$link" || return 1
  printf '%s\n' "$link"
}

keep_awake_flags() {
  f=$(printf '%s' "${KEEP_AWAKE_FLAGS:-}" | tr -cd 'dimsu')
  [ -n "$f" ] || f=$keep_awake_default_flags
  printf '%s' "$f"
}

keep_awake_window() {
  w=${KEEP_AWAKE_WINDOW_SECONDS:-}
  case "$w" in
    '' | *[!0-9]*) w=$keep_awake_default_window ;;
  esac
  printf '%s' "$w"
}

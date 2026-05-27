# keep-awake — design

**Date:** 2026-05-27
**Status:** implemented

## Goal

A Claude Code plugin that keeps a Mac from sleeping while Claude is actively
working, and lets it sleep normally once Claude goes idle. macOS only.

## Why not simulate input

The naive idea — fake a key press / mouse move on each action — is the wrong
tool on macOS. It needs Accessibility permission, visibly disturbs the cursor
and focus, and is fragile. macOS ships `/usr/bin/caffeinate`, which creates
IOKit power assertions: the supported, invisible way to hold the machine awake.
This plugin uses `caffeinate` exclusively. No input simulation.

## Behavior: one named singleton, refreshed on every action

There is exactly **one** caffeinate for the whole machine, shared across every
Claude session. On **any** Claude action — from whichever session the hook
fires — the plugin:

1. kills the existing Claude caffeinate, then
2. starts a fresh `caffeinate -<flags> -t <window>`.

As long as actions keep arriving within `<window>` seconds, exactly one
assertion is held and the Mac stays awake. When no session acts for `<window>`,
the last assertion self-expires and the Mac sleeps. This is a **deadman switch**:
it self-heals and can never leak more than one window of wakefulness. The window
also serves as the grace period after a turn ends.

**Known, accepted limitation:** a *single* tool call longer than `<window>`
(e.g. a build over 5 min) has no hook firing in the middle, so the Mac may drift
toward sleep during that gap.

## The Claude-specific name

The caffeinate is launched through a symlink named
`claude-keep-awake-caffeinate` (pointing at the real `caffeinate`), so the
running process is identifiable in `ps` / `pmset`. The plugin kills only that
name via `pkill -f claude-keep-awake-caffeinate`. A `caffeinate` the user starts
by hand has a different name and is therefore **never** killed. This name is
also what makes the singleton work across sessions without any per-session
bookkeeping: every session targets the same name.

## Triggers

All of these map to the single **refresh** action — kill-by-name then spawn:

- `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`,
  `SubagentStop`

There is intentionally **no** `SessionEnd` release: the caffeinate is shared, so
one session ending must not tear down an assertion another session may still
need. Cleanup is left entirely to the `-t <window>` self-expiry.

## State

- Symlink: `${TMPDIR}/claude-keep-awake/claude-keep-awake-caffeinate` → the real
  `caffeinate`, created lazily (`ln -sf`).
- No PID file. The running singleton is found by name (`pkill`/`pgrep -f`), not
  by a recorded PID. `TMPDIR` is per-user, so the singleton is shared across all
  of that user's Claude sessions.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `KEEP_AWAKE_FLAGS` | `dimsu` | caffeinate assertion flags, passed as `-<value>`; unknown letters stripped |
| `KEEP_AWAKE_WINDOW_SECONDS` | `300` | deadman window / post-turn grace |
| `KEEP_AWAKE_DISABLE` | unset | if set to any non-empty value, every hook is a no-op |

`dimsu` = display + idle-system + disk + system-on-AC + user-active. `-s` only
takes effect on AC power; it is harmless on battery.

## Safety

- **macOS guard:** if `uname` is not `Darwin` or `caffeinate` is not found on
  `PATH` (`command -v caffeinate`), every hook is a no-op.
- **Fail-open:** every hook exits `0` no matter what. The plugin must never block
  a tool call or fail a session.
- **Leak bound:** the assertion carries `-t <window>`, so the worst case after a
  crash is one window (default 5 min) of extra wakefulness.
- **Hand-run caffeinate is safe:** only the `claude-keep-awake-caffeinate` name
  is ever killed.

## Implementation: pure shell, zero-build

No TypeScript, no `tsup`, no `node_modules`, no `dist`. Chosen because the job is
process spawn/kill (shell-native) and `PreToolUse` runs before every tool call,
so minimal startup latency matters.

```
plugins/keep-awake/
  .claude-plugin/plugin.json    # name, version, description, author, license
  hooks/hooks.json              # wires the 6 events to refresh.sh
  bin/refresh.sh                # kill-by-name then spawn the singleton
  bin/common.sh                 # shared: env parsing, guard, paths, the symlink
  test/run-tests.sh             # PATH-shim harness, no external framework
  README.md
```

`hooks.json` invokes `sh "${CLAUDE_PLUGIN_ROOT}/bin/refresh.sh"`, matching the
`${CLAUDE_PLUGIN_ROOT}` convention used by the other plugins.

## Registration

A fourth entry in `.claude-plugin/marketplace.json` mirroring the existing three
(name `keep-awake`, `source ./plugins/keep-awake`, license MIT, category
`developer-productivity`, `strict: true`).

## Testing

A dependency-free shell harness (`test/run-tests.sh`) that:

1. Puts a **fake `caffeinate`** and fake `uname` earlier on `PATH`, recording the
   args they were called with, and the named singleton blocks until killed.
2. Drives `refresh.sh` and asserts:
   - refresh spawns `caffeinate` with the configured flags and `-t <window>`
   - exactly one process named `claude-keep-awake-caffeinate` runs
   - a second refresh kills the prior one and stays a singleton (never accumulates)
   - a hand-run plain `caffeinate` is left alive and not counted as ours
   - non-Darwin `uname` → no spawn (no-op)
   - `KEEP_AWAKE_DISABLE` set → no-op
   - garbage flags/window fall back to defaults
   - every path exits 0 (fail-open)

## Out of scope

- Windows / Linux support.
- Turn-scoped gap-free coverage (rejected in favor of the simpler deadman model).
- Per-session assertions or `SessionEnd` teardown (rejected: the assertion is a
  machine-wide singleton).
- Any UI, status line, or notification surfacing.

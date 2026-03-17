# Claude Memory Rewrite - Unified Global Plan

This file is the authoritative plan for the rewrite that replaces the current proof-of-concept
architecture.

The current repository is valuable as a concept and behavior reference, but it should not be
treated as architecture to preserve. Several core parts are explicitly being removed because they
are fragile, hard to reason about, or wrong for worktree-heavy usage.

---

## 1) Product Definition

This repository remains a Claude Code plugin marketplace that publishes one plugin:

- `memories`: local memory for Claude Code with remote-repo or directory-scoped memory spaces,
  memory retrieval, queued learning, and a local UI.

The rebuild keeps the product local-only:

- one marketplace repo
- one plugin
- no hosted backend
- loopback-only runtime services
- one read-only MCP tool (`recall`)

The rebuilt system uses:

- one global engine process
- one global SQLite database
- remote-scoped memory identity for Git repos with an `origin` remote
- directory-scoped memory identity outside Git, or inside Git when `origin` is unavailable
- no session-managed engine lifetime
- idle-based cleanup instead of session-based cleanup
- no global memory mode

### Memory Model

There is no global memory scope anymore.

Every memory belongs to exactly one active memory space:

- `remote_repo`
- `directory`

Memory resolution rules:

- if the current working context is inside a Git repo with a usable `origin` remote, use a
  remote-scoped memory space derived from the normalized `origin` URL
- if the current working context is not inside Git, use a directory-scoped memory space rooted at
  the resolved directory
- if the current working context is inside Git but has no usable `origin` remote, fall back to a
  directory-scoped memory space rooted at the Git top-level directory

This means:

- multiple worktrees of the same clone share memory when they share the same `origin`
- multiple separate clones of the same remote share memory when their normalized `origin` URLs match
- unrelated directories or repos do not share memory
- there is no cross-project global rule pool

### Supported Platform

V1 supports macOS only.

Required runtime target:

- `darwin-arm64`

Out of scope for V1:

- `darwin-x64`
- Linux
- Windows

If Intel Mac support is ever needed later, it must be added as an explicit follow-up stage with its
own vendored binary, packaging checks, and validation.

### Authoritative Repository Layout

This plan is self-sufficient. The rebuilt repo should follow this structure unless a later approved
change updates this file.

```text
claude-memory/
  FINAL_PLAN_REWRITE.md
  .claude-plugin/
    marketplace.json
  package.json
  tsconfig.base.json
  eslint.config.mjs
  .prettierrc.json

  plugins/
    memories/
      .claude-plugin/
        plugin.json
      .mcp.json
      hooks/
        hooks.json
      package.json
      tsconfig.json
      tsup.config.ts

      src/
        api/
        engine/
        extraction/
        hooks/
        mcp/
        retrieval/
        shared/
        storage/

      vendor/
        sqlite-vec/
          darwin-arm64/
            vec0.dylib

      web/
        src/
        vite.config.ts

      dist/
```

### Required Manifest And Entrypoint Contract

The rebuild must preserve the Claude plugin/marketplace contract explicitly:

- root marketplace manifest: `.claude-plugin/marketplace.json`
- plugin manifest: `plugins/memories/.claude-plugin/plugin.json`
- hook wiring: `plugins/memories/hooks/hooks.json`
- MCP wiring: `plugins/memories/.mcp.json`

Required runtime entrypoints:

- `dist/engine/main.js`
- `dist/hooks/session-start.js`
- `dist/hooks/user-prompt-submit.js`
- `dist/hooks/stop.js`
- `dist/mcp/search-server.js`

`SessionEnd` is not part of the steady-state architecture. If temporarily retained for rollout
compatibility, it must be explicitly marked compatibility-only and must not own lifecycle.

Manifest rules:

- the marketplace manifest publishes exactly one plugin from `./plugins/memories`
- the plugin manifest describes exactly one plugin named `memories`
- hook wiring must use Claude's matcher-group shape with nested `hooks` arrays
- each command hook item uses an explicit `{ "type": "command", "command": "..." }` shape
- steady-state hook wiring includes `SessionStart`, `UserPromptSubmit`, and `Stop`
- `.mcp.json` registers exactly one stdio MCP server named `memories`
- hook and MCP command paths must use quoted `${CLAUDE_PLUGIN_ROOT}` values
- plugin startup must work from committed `dist` artifacts
- the vendored `sqlite-vec` binary must be included in the shipped plugin package

Hook behavior contract at the manifest level:

- steady-state hook wiring must not include `SessionEnd`
- if `SessionEnd` is temporarily kept for compatibility while shipping, it must be documented as
  compatibility-only and must not be relied on for lifecycle, shutdown, or cleanup

### Authoritative External References

These references are supplementary only. They must not be needed to understand the architecture in
this file.

- [Claude Code plugin marketplaces](https://docs.anthropic.com/en/docs/claude-code/plugin-marketplaces)
- [Claude Code plugins reference](https://docs.anthropic.com/en/docs/claude-code/plugins-reference)
- [Claude Code hooks reference](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

---

## 2) Prior Implementation Learnings

The deleted proof-of-concept implementation was useful. It proved the feature set is worth building,
but it also proved that the prior architecture was too fragile and too implicit.

### Keep

- Claude marketplace and plugin wiring are valid and worth preserving.
- Fail-open hooks are correct and must remain.
- The memory taxonomy is useful:
  - `fact`
  - `rule`
  - `decision`
  - `episode`
- Path-aware retrieval is useful.
- Rule policy ranking is useful.
- A local UI is useful.
- Automatic post-stop learning is useful.
- One small MCP read tool is the right surface.
- Strict TypeScript, tests, and simple module boundaries are the right direction.

### Replace

- Repo-local `.memories` storage is wrong for worktrees.
- Per-project-path DBs split the same Git repo into different memory stores.
- Session lifecycle is not a reliable ownership model.
- Session de-dup heuristics are clever but fragile.
- Session-based engine drain is hard to clean up and easy to desynchronize.
- Runtime installation of native SQLite dependencies is operationally messy.
- ABI-specific native folders pollute the repo and confuse git status.
- The current Node contract is contradictory:
  - package metadata says Node `>=20`
  - engine runtime resolution effectively requires Node `24`
- runtime-installed `sqlite-vec` plus native dependency management adds complexity and polluted the
  previous packaging/runtime story.
- Lexical search behavior is too implicit and needs an explicit V1 contract.
- MCP recall depending on an already-running engine is too brittle.
- The UI assumes one repo per engine origin and cannot browse across repos.
- Background hook state is in-memory, not durable.
- Event logs are read by scanning whole files.
- `settings.json` appears unused and should not survive unchanged.

### Concrete Failures Verified In Code

- Storage is resolved under `<projectRoot>/.memories`, so worktrees of the same repo do not share
  memory.
- Sessions are tracked via `connected_session_ids` in the engine lock and in-memory sets.
- Engine shutdown is tied to zero sessions plus zero background hooks.
- The `Stop` hook spawns detached workers and depends on a live repo-local engine.
- Node 24 runtime discovery still exists.
- Native runtime packages are installed into `plugins/memories/native/<platform>-<arch>-abi<abi>`.
- The UI is origin-bound and single-repo.
- Current lexical search behavior is tag-focused but not treated as an explicit V1 contract.

---

## 3) Non-Negotiable Rewrite Decisions

1. V1 supports macOS only, on `darwin-arm64`.
2. Node 24 is the required target runtime for the rewrite.
3. Stage 00 must verify whether Claude launches plugin entrypoints under Node 24. If that cannot be
   guaranteed, keep only a tiny launcher-compatible bootstrap wrapper that re-execs the real Node
   24 runtime while preserving fail-open behavior. Do not reintroduce heuristic runtime discovery.
4. Use built-in `node:sqlite` from Node 24.
5. Use a vendored `sqlite-vec` extension binary committed to git and shipped in the plugin package.
6. Do not install, rebuild, or download DB/runtime dependencies at runtime.
7. Store all persistent data under one global Claude memory directory, not inside repos.
8. Use one global DB for all memory spaces.
9. Do not manage engine lifetime through sessions.
10. Engine startup must be lazy and trigger on `SessionStart`, `UserPromptSubmit`, `Stop`, MCP
    `recall`, and any UI/API access that needs the engine.
11. Engine cleanup must be idle-based: after 1 hour without activity, and never while a learning
    job is active.
12. There is no global memory mode.
13. Every memory belongs to exactly one active memory space.
14. If inside a Git repo with a usable `origin` remote, identity is derived from the normalized
    `origin` URL.
15. If outside Git, identity is derived from the resolved directory root.
16. If inside Git but no usable `origin` remote exists, fall back to directory-scoped identity at
    the Git top-level directory.
17. All read/write/search contracts must carry memory-space identity explicitly.
18. Agent retrieval, startup context, and automatic learning operate only on the active memory
    space, not across multiple spaces.
19. Learning jobs must be queued and serialized in an explicit, durable way.
20. Learning jobs must be leased and executed only by the global engine, never by an untracked
    detached hook subprocess.
21. Global engine reuse and global DB access must be version- and schema-compatible.
22. Cold marketplace installs must work from shipped artifacts alone, with no plugin-local
    `npm install` step.
23. No repo-local DBs, lock files, logs, or runtime artifacts.
24. Hooks must remain fail-open.
25. MCP stdout must remain protocol-clean.

---

## 4) Global Storage Root

Default storage root:

- `~/.claude/memories`

Testing override:

- `CLAUDE_MEMORY_HOME`

Planned layout:

```text
~/.claude/memories/
  memory.db
  engine.lock.json
  engine.startup.lock.json
  engine.stderr.log
  tmp/
```

Important rules:

- No persistent state is stored under repo roots.
- No persistent state is stored under `plugins/memories/native`.
- Vendored read-only binaries that ship with the plugin live under `plugins/memories/vendor/`, not
  under the global storage root.
- The engine lock is global, not repo-specific.
- The main event timeline lives in SQLite, not in ad hoc per-repo files.
- `engine.stderr.log` remains a plain file for low-level crash/bootstrap diagnostics only.

---

## 5) Runtime Architecture

```text
Claude hooks / MCP / UI
  -> ensureEngine()
  -> one global loopback engine
  -> one global SQLite database
  -> memory-space registry + memories + events + learning queue
```

High-level behavior:

1. A caller resolves or provides the current working context.
2. `ensureEngine()` reuses or starts one global engine.
3. The engine resolves the active memory space for that context.
4. Retrieval uses only the active memory space.
5. `Stop` enqueues learning work instead of trying to own engine lifetime through sessions.
6. The engine exits after 1 hour of inactivity.
7. The next access starts it again automatically.

This is intentionally simpler than the current design:

- no per-repo engines
- no connected session registry
- no session drain callback model
- no background-hook-only in-memory ownership model

---

## 6) Memory Space Identity And Resolution

There is no global memory scope. The system resolves one active memory space from the current
working context.

### Space Kinds

- `remote_repo`
- `directory`

### Resolution Rules

Given hook/MCP/UI input, resolve the working path in this order:

1. explicit `project_root`
2. explicit `cwd`
3. `CLAUDE_PROJECT_DIR`
4. `process.cwd()`

Then:

1. canonicalize that path with `realpath`
2. check whether the path is inside a Git work tree
3. if not inside Git:
   - create or reuse a `directory` space rooted at the resolved directory
4. if inside Git:
   - resolve the Git top-level root with `git rev-parse --show-toplevel`
   - inspect remotes
   - if a usable `origin` remote exists, create or reuse a `remote_repo` space from the normalized
     `origin` URL
   - otherwise create or reuse a `directory` space rooted at the Git top-level root

### Remote-Scoped Identity

Remote-scoped identity is based on `origin` only in V1.

Rules:

- if `origin` exists and normalizes successfully, it is the memory-space discriminator
- if other remotes exist but `origin` does not, do not guess; fall back to directory scope
- worktrees and separate clones with the same normalized `origin` share one memory space
- unrelated repos never share memory unless their normalized `origin` URLs match exactly

### Remote URL Normalization

The normalization algorithm must be deterministic and tested.

Required behavior:

- trim whitespace
- strip embedded credentials and usernames
- lowercase the host
- normalize SSH and HTTPS forms into one canonical host/path representation
- strip a trailing `.git`
- strip trailing slashes

Recommended identity input shape:

- `host/owner/repo`

Recommended stable key:

- `space_key = sha256("remote:" + normalized_origin_url)`

### Directory-Scoped Identity

Directory scope is the fallback when shared remote identity is unavailable.

Rules:

- outside Git, the directory scope root is the resolved working directory
- inside Git without usable `origin`, the directory scope root is the Git top-level directory
- symlinked openings normalize through `realpath`

Recommended stable key:

- `space_key = sha256("dir:" + realpath(space_root))`

### Space Metadata

The memory-space registry must store enough information for search, UI, and diagnostics:

- `id`
- `space_key`
- `space_kind`
- `display_name`
- nullable `origin_url`
- nullable `origin_url_normalized`
- `last_seen_root_path`
- `created_at`
- `updated_at`
- `last_seen_at`

### Space Roots

One memory space may be observed from multiple roots.

Examples:

- multiple worktrees of one clone
- multiple clones of one remote
- one directory space reopened from the same root later

Track observed roots so the UI and logs can explain where a space was seen.

### Canonical Read/Write Contracts

Every memory-shaped read result must include:

- `id`
- `space_id`
- `space_kind`
- `space_display_name`
- nullable `origin_url_normalized`
- `memory_type`
- `content`
- `tags`
- `is_pinned`
- `path_matchers`
- `created_at`
- `updated_at`

Search-shaped results must extend that with ranking metadata such as:

- `score`
- `source`
- `matched_by`
- `path_score`
- `lexical_score`
- `semantic_score`

Create/update rules:

- manual create requires either explicit `space_id` or resolvable current context
- path matchers are always relative to the active space root
- V1 updates may change content, tags, pin state, and path matchers
- V1 updates may not move a memory between spaces

Automatic learning rules:

- automatic `Stop` learning writes only to the active memory space
- if no stable active memory space can be resolved, automatic learning must skip rather than guess

Cross-space read rules:

- agent retrieval, startup context, and automatic learning are current-space only
- UI may browse more than one space
- any API/UI response spanning multiple spaces must annotate space metadata clearly

---

## 8) Data Model

The new DB must model memory spaces, roots, memories, retrieval indexes, events, and queued
learning jobs.

### Core Tables

#### `memory_spaces`

Stores one record per active memory identity.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `space_key TEXT NOT NULL UNIQUE`
- `space_kind TEXT NOT NULL CHECK (space_kind IN ('remote_repo', 'directory'))`
- `display_name TEXT NOT NULL`
- `last_seen_root_path TEXT NOT NULL`
- `origin_url TEXT`
- `origin_url_normalized TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`

Required invariants:

- remote spaces require `origin_url` and `origin_url_normalized`
- directory spaces require both origin columns to be `NULL`

#### `space_roots`

Tracks observed roots for a memory space.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE`
- `root_path TEXT NOT NULL`
- `root_kind TEXT NOT NULL CHECK (root_kind IN ('git_worktree', 'directory_root'))`
- `first_seen_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`

Recommended index rule:

- unique index on `(space_id, root_path)`

#### `memories`

Source of truth for all memories.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE`
- `memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'rule', 'decision', 'episode'))`
- `content TEXT NOT NULL`
- `tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json))`
- `is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1))`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

#### `memory_path_matchers`

Suggested columns:

- `id TEXT PRIMARY KEY`
- `memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE`
- `path_matcher TEXT NOT NULL`
- `created_at TEXT NOT NULL`

Required invariant:

- path matchers are always relative to the owning memory space root

#### `memory_fts`

Lexical search remains intentionally tag-focused in V1.

V1 requirement:

- index memory tags only
- do not index main memory content in FTS
- keep lexical behavior explicit and tested

Suggested shape:

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  id UNINDEXED,
  tags_text
);
```

#### `vec_memory`

`sqlite-vec` is the only semantic vector store in V1.

Suggested shape:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[1024] distance_metric=cosine
);
```

Required rules:

- load the vendored macOS `sqlite-vec` extension during engine startup
- store normalized `Float32` embeddings directly in `vec_memory`
- do not keep a separate `memory_embeddings` table
- do not store per-row `model_name` or `dimensions` metadata in SQLite because V1 fixes both in code
- if the extension fails to load on the supported platform, fail startup with an explicit actionable
  error
- if the process is running on an unsupported platform, fail early with an explicit macOS-only error

#### `learning_jobs`

Durable queue for post-stop learning work.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE`
- `root_path TEXT NOT NULL`
- `transcript_path TEXT NOT NULL`
- `last_assistant_message TEXT`
- `session_id TEXT`
- `state TEXT NOT NULL`
- `lease_owner TEXT`
- `lease_expires_at TEXT`
- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `error_text TEXT`
- `enqueued_at TEXT NOT NULL`
- `started_at TEXT`
- `finished_at TEXT`
- `updated_at TEXT NOT NULL`

States:

- `pending`
- `leased`
- `running`
- `completed`
- `failed`
- `skipped`

#### `events`

SQLite-backed operational timeline for UI and debugging.

Suggested columns:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `at TEXT NOT NULL`
- `space_id TEXT REFERENCES memory_spaces(id) ON DELETE SET NULL`
- `root_path TEXT`
- `event TEXT NOT NULL`
- `kind TEXT NOT NULL`
- `status TEXT NOT NULL`
- `session_id TEXT`
- `memory_id TEXT`
- `job_id TEXT`
- `detail TEXT`
- `data_json TEXT`

### Schema Versioning And Migrations

Schema versioning must exist from day one.

Required rules:

- track schema version explicitly using `PRAGMA user_version` or a dedicated metadata table
- keep migrations ordered, idempotent where practical, and checked into source control
- run migrations before the engine starts serving traffic
- if a migration is destructive or hard to reverse, create a timestamped backup first
- if migration fails, preserve the original DB and surface an actionable error rather than serving a
  partially migrated database

### Write Invariants

Create/update/delete of memories must remain explicit transactions.

Create/update sequence:

1. write `memories`
2. sync `memory_fts`
3. replace path matchers
4. sync `vec_memory`
5. rollback on any failure

Delete sequence:

1. delete path matchers
2. delete FTS row
3. delete `vec_memory` row
4. delete memory row

### Important Non-Goals

- no session table as a lifecycle authority
- no repo-local lock metadata
- no per-repo DB files
- no global memory scope table
- no runtime installation of `sqlite-vec`
- no multi-platform support in V1

---

## 9) Engine Lifecycle

The rewrite uses one global engine with idle cleanup.

### Lock Files

Global lock files live under the global storage root:

- `engine.lock.json`
- `engine.startup.lock.json`

Suggested lock metadata:

- `host`
- `port`
- `pid`
- `started_at`
- `last_activity_at`
- `storage_root`
- `version`

### Reuse Rules

1. If lock exists, pid is alive, and `/health` passes, reuse the engine.
2. If lock exists but pid is dead, remove it.
3. If lock exists but engine is unhealthy, verify ownership and replace it safely.
4. Use a startup lock to prevent duplicate global engine starts.
5. Remove lock only if owned by the current pid.

### Compatibility Rules

The global engine must not be reused just because it is alive.

Required rules:

1. `/health` must expose enough metadata to verify compatibility:
   - engine code version
   - API contract version
   - DB schema version
2. `ensureEngine()` may reuse a running engine only when those versions are compatible with the
   current caller.
3. If the live engine is incompatible, replace it safely rather than talking to it optimistically.
4. DB migrations must complete before the engine reports healthy.

### Concurrency Rules

All callers converge on the same global `ensureEngine()` path:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`
- MCP `recall`
- UI/API access

Required behavior:

- parallel callers may start at most one global engine
- child exit before healthy must fail fast and visibly
- stale or unhealthy locks must be replaced safely
- space-touch and job-enqueue paths must be idempotent under concurrent callers

### Activity Rules

The engine must update `last_activity_at` whenever it handles meaningful work:

- startup context fetch
- search
- CRUD
- space resolution/touch
- job enqueue
- job lease/heartbeat/finish
- UI API reads
- MCP recall

### Idle Cleanup

Default idle timeout:

- 1 hour

Configuration:

- `MEMORIES_ENGINE_IDLE_TIMEOUT_MS`

Rules:

1. If there has been no activity for 1 hour and no learning job is running, shut down.
2. If a learning job is running, do not shut down.
3. The next access must restart the engine automatically.
4. Idle cleanup must not depend on `SessionEnd`.

### Port Binding

Do not repeat the current reserve-then-close port race.

Required behavior:

- let the real server listen on port `0`
- read the actual bound port from the server after bind
- write that real port to the lock

---

## 10) Learning Queue

The current detached-worker concept is useful, but its ownership model is too implicit.

The rewrite must use a durable queue.

### Queue Rules

1. `Stop` does not write memories directly.
2. `Stop` enqueues a learning job and returns immediately.
3. The queue lives in SQLite.
4. Job state is durable across engine restarts.
5. Job execution uses explicit lease semantics.

### Ownership Rule

The queue executor must be engine-owned.

Required behavior:

- `Stop` only enqueues and returns
- the global engine owns leasing and execution
- if the engine uses a child process for learning work, that child is created, tracked, and cleaned
  up by the engine
- an untracked detached hook subprocess must never be the source of truth for job execution state
- idle shutdown must consult durable running-job state, not hook-local process state

### Concurrency Rule

V1 simplification:

- run at most one learning Claude job at a time globally

Reason:

- it is simpler
- it is safer
- it naturally solves concurrent worktree learning conflicts

Future widening is allowed only if this remains true:

- never run more than one learning job at the same time for the same `space_id`

### Worker Behavior

For each job:

1. read transcript
2. derive active-space-relative related paths
3. search candidate memories using the job's owning space only
4. run internal `claude -p` with `CLAUDE_CODE_SIMPLE=1`
5. parse strict JSON actions
6. sanitize path matchers
7. apply only high-confidence actions
8. write durable job and event records

### Failure Rules

- if the transcript is missing, mark the job `skipped` or `failed` explicitly
- if parsing fails, record that in `events`
- if one write fails, stop the job and mark it `failed`
- engine restarts must be able to recover stale leases

### UI Impact

The queue must be visible in the UI:

- pending jobs
- running job
- completed jobs
- failed jobs
- space and time metadata

---

## 11) Retrieval Strategy

The rewrite keeps hybrid retrieval but fixes the current weak and implicit parts.

### Search Boundary

Default retrieval boundary:

- search only the active memory space

UI-only optional management behavior:

- an explicit all-spaces search may exist for browsing and diagnostics
- agent retrieval, startup context, and automatic learning do not use all-spaces search in V1

### Branches

1. Path-aware branch:
   - active-space memories only
   - active-space-relative path matchers
2. Lexical branch:
   - FTS over tags only
3. Semantic branch:
   - embeddings over content

### Embedding Model Contract

V1 keeps semantic search simple and deterministic:

- provider: local Ollama
- model: `bge-m3`
- dimensions: `1024`
- no runtime profile switching in V1
- these values are code-level constants in V1 and are not stored per row in SQLite
- if a different embedding model is ever needed later, it must come with an explicit re-embedding and
  vec-index migration plan

### Vector Search Contract

Nearest-`k` semantic retrieval uses one path in V1:

1. load vendored `sqlite-vec` on the supported macOS target
2. query `vec_memory` directly for nearest neighbors

This means semantic retrieval depends on the extension in V1. If the vendored binary fails to load on
the supported target, startup must fail explicitly rather than degrading to an alternate semantic
path.

### Fusion

Use reciprocal rank fusion for lexical + semantic merge.

Then merge path hits ahead of hybrid hits.

### Ranking Principles

Order of importance:

1. path match relevance
2. rule policy effect:
   - deny
   - must
   - preference
   - context
3. pinned status
4. recency

### Path Matcher Contract

Path matcher handling must be explicit because it has been one of the most failure-prone parts of
the prior implementation.

V1 rules:

- only active-space-relative path matchers are allowed
- reject broad catch-alls such as `*`, `**`, `**/*`, `/`, and `./`
- strip line-number suffixes and similar transcript noise before validation
- basename-only promotion is allowed only when it resolves unambiguously to one related path inside
  the active space
- cap matcher count per memory/action to prevent noisy retrieval
- test ranking across exact file, exact dir, single-glob, and deep-glob cases

### Ollama Contract

Keep local Ollama embeddings, but do not repeat the current startup-blocking behavior.

Required behavior:

- engine must still start when Ollama is unavailable
- search must degrade to path + tag lexical retrieval
- if the vendored vec extension fails to load on the supported target, fail startup with an explicit
  actionable error
- UI and logs should surface semantic-unavailable state
- missing Ollama must not disable the whole plugin

### Token Budget

Keep a response token budget for MCP and startup injection.

Current useful default:

- `6000`

But the new plan must treat this as a real, wired setting if exposed, not dead config.

---

## 12) Startup Context

Pinned startup memory remains useful, but it now needs memory-space awareness.

### SessionStart Injection

- resolve the active memory space
- inject pinned memories from that space only

### Formatting

Startup markdown should clearly identify:

- active space kind
- active space display name
- normalized origin URL when the active space is a remote repo
- pinned memories for that active space

This is better than an undifferentiated block because the user and model need to understand which
project context the pinned memories came from.

### Guidance Contract

The startup additional context must preserve the behavioral cues that make memory actually usable:

- state clearly that `recall` is the main memory retrieval path
- state clearly that the startup block contains pinned memory for the active space only, not the full
  memory set
- instruct the model to check memory before acting on non-trivial work
- instruct the model to stop and explain when remembered constraints conflict with the requested
  action

---

## 13) Hook Contracts

The rewrite is no longer session-lifecycle-driven.

### Hook Set

Steady-state hook set:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`

`SessionEnd` is intentionally removed from engine ownership. If kept temporarily for rollout
compatibility, it must be a no-op for lifecycle purposes.

### `SessionStart`

Required behavior:

1. resolve current context
2. ensure global engine
3. resolve active memory space
4. upsert memory-space and root last-seen metadata
5. fetch pinned startup memory for the active space
6. return:
   - top-level `systemMessage` with Memory UI URL
   - additional context with pinned memory markdown
7. fail open on any error

### `UserPromptSubmit`

Required behavior:

1. resolve current context
2. ensure global engine
3. refresh engine activity
4. refresh memory-space and root metadata
5. inject lightweight reminder to use `recall`
6. fail open on any error

This hook should stay lightweight. It should not re-inject the full pinned startup block.

It should preserve the lightweight reminder behavior from the prior implementation:

- use `recall` before acting when memory may matter
- direct requests do not override remembered project rules

### `Stop`

Required behavior:

1. resolve current context
2. ensure global engine
3. resolve active memory space
4. verify transcript exists
5. enqueue learning job
6. return immediately
7. fail open on any error

Keep these safety rules:

- respect `stop_hook_active=true`
- keep internal Claude subprocesses on `CLAUDE_CODE_SIMPLE=1`

### `SessionEnd`

Rewrite decision:

- not part of engine lifecycle
- not required for cleanup
- if kept at all, telemetry-only and fail-open

---

## 14) MCP Contract

Keep one MCP tool:

- `recall`

### Required Behavior

1. validate input with zod
2. resolve current context
3. ensure global engine automatically
4. resolve the active memory space
5. search only that space
6. return markdown only

### Tool Description Policy

The `recall` tool description must continue to carry explicit invocation guidance:

- use `recall` before acting on non-trivial work
- use it again when project context changes
- pinned startup context is not the full memory set
- the tool searches the current active memory space, not all memories everywhere

### Important Difference From Current Code

`recall` must not fail just because the engine is not already running.

It must:

- auto-start the engine
- not depend on a pre-existing repo-local lock file
- resolve active space automatically from the current context
- include active-space metadata in its markdown output

### Timeout Contract

Cold start and request execution must not share one ambiguous timeout.

Required behavior:

- engine boot timeout is separate from MCP request timeout
- MCP request timeout starts after `ensureEngine()` has returned a healthy engine
- stopped-engine `recall` must be validated under cold-start conditions

### stdout Rule

The MCP server must never emit non-protocol stdout logs.

---

## 15) UI Contract

The UI must stop assuming one repo per origin and must stop assuming any global memory mode.

### High-Level Behavior

The UI is served from the global engine at `/ui` and reflects:

- memory spaces
- memories within those spaces
- learning queue
- operational logs

### Required Features

#### Top Bar

Show aggregate stats:

- total memories
- total spaces
- queued jobs
- running jobs
- uptime
- online/offline
- idle timeout status

#### Focus Selector

Support focus modes:

- `Current space`
- `All spaces`
- explicit space selection

#### Memories View

Show:

- space-kind chip (`remote_repo` or `directory`)
- space chip
- type
- pin state
- path matchers
- tags
- updated time

Create/edit must support:

- current-space defaulting
- explicit space selection when creating from the UI outside current-context workflows
- path matchers relative to the selected space root

#### Jobs View

Replace the current background-hooks tab with a real queue/jobs view.

Show:

- queued
- running
- completed
- failed
- space
- transcript path
- attempts
- timestamps
- error details

#### Logs View

Show a unified event timeline with:

- space filter
- status filter
- pagination or capped recent window
- expandable structured payloads

### Search Behavior

UI search must be space-aware.

Examples:

- in `Current space`, search the active space only
- in an explicit space focus, search that space only
- in `All spaces`, search across everything with visible space annotations

---

## 16) API Surface

The new API drops sessions and background-hook endpoints.

### Required Endpoints

- `GET /health`
- `GET /stats`
- `GET /spaces`
- `POST /spaces/touch`
- `POST /memories/pinned`
- `POST /memories/search`
- `POST /memories/add`
- `GET /memories`
- `PATCH /memories/:id`
- `DELETE /memories/:id`
- `POST /learning-jobs`
- `GET /learning-jobs`
- `GET /logs`

### Canonical Payload Rules

Required API behavior:

- memory CRUD/search/pinned payloads and results carry `space_id`, `space_kind`, and space metadata
  explicitly
- `POST /memories/pinned` accepts current context or explicit `space_id`
- `POST /memories/search` defaults to the resolved active space and may allow explicit `space_id` for
  UI/admin workflows
- `GET /memories` supports `space_id` filtering and optional all-spaces listing for the UI
- `POST /memories/add` requires explicit `space_id` or resolvable current context
- path matchers are validated relative to the owning space root
- `PATCH /memories/:id` must not move memories across spaces in V1
- `POST /learning-jobs` records resolved `space_id` and root path
- UI-facing results spanning multiple spaces must include visible space metadata

### Explicitly Removed

- `POST /sessions/connect`
- `POST /sessions/disconnect`
- `/background-hooks/*`

### Boundary Rules

- validate all input with zod
- keep route handlers thin
- attach space context explicitly
- persist event records through the shared event service
- every meaningful request refreshes engine activity

---

## 17) Toolchain And Packaging

### Runtime Baseline

- Node 24 for all real runtime logic

Bootstrap boundary rule:

- if Stage 00 confirms Claude launches plugin entrypoints under Node 24, keep the system fully
  Node-24-only
- if not, keep only a minimal launcher-compatible bootstrap wrapper whose sole job is to exec the
  real Node 24 runtime
- do not reintroduce multi-path runtime discovery heuristics

Required updates:

- root `package.json`
- plugin `package.json`
- build target(s)
- tests and docs

### SQLite

Use built-in `node:sqlite` from Node 24 together with a vendored `sqlite-vec` extension.

Therefore remove from the new architecture:

- `better-sqlite3`
- runtime `npm install` of DB dependencies
- ABI-specific native cache directories
- node runtime binary discovery logic
- `MEMORIES_NODE_BIN`

### Vendored `sqlite-vec` Contract

The project vendors the SQLite extension binary directly in the repo and ships it in the plugin
package.

V1 packaged binary layout:

```text
plugins/memories/vendor/sqlite-vec/
  darwin-arm64/
    vec0.dylib
```

Required rules:

- the binary is committed to git
- the binary is included in the packaged plugin
- there is no download, install, rebuild, or mutation at runtime
- load path resolution is deterministic from `CLAUDE_PLUGIN_ROOT`
- unsupported platform handling is explicit and actionable
- semantic startup fails explicitly if the extension unexpectedly fails to load on the supported
  target

### Build

Keep:

- TypeScript strict mode
- `tsup`
- `vite`
- ESLint
- Prettier

Update targets:

- backend target `node24`
- no external native DB package handling

### Packaging Contract

This plugin must work in the real marketplace install environment, not only in the local repo.

Required rules:

- shipped entrypoints must run from committed `dist` artifacts
- backend runtime entrypoints must be self-contained and must not depend on workspace or ancestor
  `node_modules`
- plugin startup must not require a plugin-local `npm install`
- emitted output must preserve `node:` builtin specifiers correctly
- any required CommonJS interop must be handled explicitly in the built output
- plugin-root resolution must not depend on `process.cwd()`
- hook and MCP command strings must keep quoted `${CLAUDE_PLUGIN_ROOT}` paths
- the vendored `sqlite-vec` binary must be packaged and loadable from the shipped plugin
- validation must include a cold-install simulation with no plugin `node_modules`

### Config Surface

Do not keep dead config.

If a setting exists, it must be wired end-to-end.

Expected real settings for the rewrite:

- `CLAUDE_MEMORY_HOME`
- `MEMORIES_ENGINE_BOOT_TIMEOUT_MS`
- `MEMORIES_ENGINE_IDLE_TIMEOUT_MS`
- `MEMORIES_OLLAMA_URL`
- `MEMORIES_MCP_REQUEST_TIMEOUT_MS`

Optional only if Stage 00 proves the launcher is not already Node 24:

- one explicit Node 24 bootstrap path setting for the minimal wrapper

---

## 18) Migration Strategy

This rewrite should be treated as a fresh architecture, not a patch on the current lifecycle model.

### Initial Position

- legacy repo-local DBs are not authoritative storage for the rewrite
- this file is the source of truth, not deleted code or unstated project history

### V1 Migration Rule

Do not block the rewrite on automated migration from old repo-local `.memories` DBs.

If import is needed later, add a separate import tool after the new architecture is stable.

Reason:

- the current storage model is path-scoped and worktree-brittle
- importing bad identity assumptions into the new DB would be counterproductive

Legacy upgrade UX requirement:

- when running inside a repo that still contains a legacy repo-local `.memories/ai_memory.db`, the
  system must detect it and surface a non-destructive notice
- V1 does not auto-import legacy data
- V1 must provide an explicit manual recovery/import path in docs or UI before release

---

## 19) Validation Checklist

### Automated

Required:

1. `npm run lint`
2. `npm run typecheck`
3. `npm run build`
4. hook contract tests
5. engine lifecycle tests
6. memory-space identity resolution tests
7. storage transaction tests
8. schema migration and compatibility tests
9. retrieval tests
10. queue and lease recovery tests
11. MCP recall tests
12. cold-install packaging tests
13. parallel startup/idempotency tests
14. vendored `sqlite-vec` load tests on the supported target
15. supported-target vec load failure tests with explicit startup error behavior
16. `origin` URL normalization tests across SSH and HTTPS forms
17. active-space fallback tests when Git has no usable `origin`

### Manual

1. Start inside one Git repo with a usable `origin` and verify startup context includes only pinned
   memory for that remote-scoped space.
2. Start in two worktrees of the same repo and verify both read and write the same remote-scoped
   memory space.
3. Start in two separate clones with the same normalized `origin` and verify they share memory.
4. Start in a Git repo with no usable `origin` and verify the system falls back to a directory space
   rooted at the Git top-level directory.
5. Start outside Git and verify the system uses a directory space rooted at the resolved working
   directory.
6. Trigger `Stop` in two roots that map to the same memory space close together and verify queue
   serialization.
7. Run a marketplace-style cold install from committed artifacts only and verify hooks/MCP/UI start
   with no plugin-local `node_modules`.
8. Verify the launcher/runtime boundary: either plugin entrypoints already run under Node 24, or the
   minimal bootstrap wrapper re-execs Node 24 correctly.
9. Verify vendored `sqlite-vec` loads successfully on macOS `darwin-arm64`.
10. Force vec loading failure and verify startup fails with an explicit actionable error.
11. Let the engine idle with a short test timeout and verify automatic shutdown.
12. Trigger `UserPromptSubmit`, `SessionStart`, `Stop`, and MCP `recall` against a stopped engine and
   verify auto-start.
13. Run without Ollama and verify the engine still starts and tag lexical/path retrieval still works.
14. Open `/ui` and verify current-space focus, all-spaces browsing, the job queue, and logs all work
    correctly.
15. Verify search and list results visibly annotate memory-space metadata when more than one space is
    shown.
16. Verify a repo with a legacy `.memories/ai_memory.db` gets a clear non-destructive notice.
17. Verify no repo-local `.memories` folders are created.
18. Verify no `native/<platform>-<arch>-abi...` artifacts are created.

### Security And Privacy

- loopback-only binding
- no MCP stdout pollution
- no execution of memory content
- no repo-local secret spillage
- secret redaction for logged payloads

---

## 20) Implementation Stages

This rewrite should be implemented in small, reviewable stages. Each stage must be approved before
the next stage starts. Each stage should be split into small commits, not one large batch.

### Stage 00 - Approve Rewrite Contract

Goal:

- lock the architecture and assumptions in this file

Micro-steps:

1. confirm storage root
2. confirm memory-space identity algorithm
3. confirm `origin` normalization rules
4. confirm Git-without-`origin` fallback behavior
5. confirm launcher/runtime boundary for Node 24
6. confirm macOS-only support target and vendored vec binary contract
7. confirm `SessionEnd` removal or noop behavior
8. confirm queue concurrency rule

Gate:

- user approval on the plan

### Stage 01 - Shared Foundations

Goal:

- establish global paths, constants, schemas, memory-space resolver primitives, and event model

Micro-steps:

1. global storage path helpers
2. memory-space resolver
3. remote URL normalization helper
4. core zod schemas for space-bearing memory/search/pinned contracts
5. jobs, logs, and event contracts
6. structured event service

Gate:

- unit tests for path resolution and memory-space identity

### Stage 02 - Node 24 And SQLite Baseline

Goal:

- enforce Node 24 and replace the native runtime story

Micro-steps:

1. package metadata and build target updates
2. decide and implement the minimal bootstrap boundary if Node 24 launcher guarantee is absent
3. remove new-design dependency on `better-sqlite3`
4. add built-in `node:sqlite` bootstrap layer
5. add vendored `sqlite-vec` binary layout and deterministic loader
6. prove cold-install packaging assumptions locally

Gate:

- clean typecheck and build under Node 24

### Stage 03 - Global Engine Lifecycle

Goal:

- implement one global engine with lock reuse and idle cleanup

Micro-steps:

1. global lock/startup lock
2. healthy reuse and stale lock recovery
3. compatibility/version handshake
4. activity refresh
5. idle timeout shutdown
6. safe port binding without reserve/release race
7. parallel caller idempotency tests

Gate:

- engine lifecycle integration tests

### Stage 04 - Global Schema

Goal:

- implement memory spaces, space roots, memories, FTS, vec semantic storage, jobs, and events tables

Micro-steps:

1. memory-space tables
2. memory table and path matcher invariants
3. FTS and vec semantic storage tables
4. jobs and events tables
5. schema versioning and ordered migrations

Gate:

- transaction and constraint tests

### Stage 05 - Retrieval

Goal:

- implement active-space retrieval with explicit tag-focused lexical behavior

Micro-steps:

1. active-space filters
2. tag lexical search
3. semantic branch with vendored vec primary path
4. path-aware merge and ranking

Gate:

- retrieval tests for active-space boundary, path, lexical, vec-backed semantic search, and ranking

### Stage 06 - API

Goal:

- expose the new sessionless API

Micro-steps:

1. `/health`, `/stats`, `/spaces`
2. space-bearing memory CRUD and search
3. pinned context endpoint
4. jobs and logs endpoints
5. explicit space metadata in all relevant responses

Gate:

- API integration tests with zod boundary validation

### Stage 07 - Hook Rewrite

Goal:

- make hooks engine-access-based instead of session-lifecycle-based

Micro-steps:

1. `SessionStart`
2. `UserPromptSubmit`
3. `Stop`
4. remove or noop `SessionEnd`

Gate:

- hook simulation tests and manual smoke checks

### Stage 08 - Learning Queue And Worker

Goal:

- replace background-hook ownership with durable queued learning

Micro-steps:

1. enqueue flow
2. engine-owned lease and execution loop
3. internal Claude call and strict JSON parsing
4. active-space-only automatic write policy
5. apply actions with durable status updates

Gate:

- queue serialization and lease recovery tests

### Stage 09 - MCP Recall

Goal:

- make recall auto-start and active-space-aware

Micro-steps:

1. auto engine startup
2. context input and memory-space resolution
3. cold-start timeout split
4. markdown output updates with active-space annotations

Gate:

- MCP tests from stopped-engine and remote-space/directory-space scenarios

### Stage 10 - UI Rewrite

Goal:

- build the memory-space UI over the new model

Micro-steps:

1. aggregate stats and space selector
2. memory-space list and CRUD
3. jobs view
4. logs view

Gate:

- manual multi-space UI walkthrough

### Stage 11 - Packaging Cleanup

Goal:

- finalize manifests, build outputs, and docs around the new runtime

Micro-steps:

1. manifest updates
2. build config cleanup
3. remove native-runtime assumptions from docs and code
4. ensure the plan remains self-sufficient and matches the shipped manifest/runtime layout

Gate:

- clean build and correct plugin wiring

### Stage 12 - Hardening

Goal:

- validate end-to-end behavior and fix drift

Micro-steps:

1. concurrency and shared-space scenarios
2. idle restart scenarios
3. vendored vec load and fail-fast scenarios
4. security/privacy pass

Gate:

- full checklist in Section 19 passes

---

## 21) Final Acceptance Criteria

The rewrite is complete only when all of the following are true:

- there is one global engine process, not one engine per repo path
- there is one global SQLite DB for all memory spaces
- V1 support is explicitly macOS `darwin-arm64` only
- there is no global memory scope
- every memory belongs to exactly one memory space
- starting Claude in two worktrees of the same repo with the same normalized `origin` uses the same
  remote-scoped memory space
- starting Claude in two separate clones with the same normalized `origin` uses the same
  remote-scoped memory space
- starting Claude in a Git repo without usable `origin` falls back to a directory-scoped space at
  the Git top-level
- starting Claude outside Git uses a directory-scoped memory space rooted at the resolved working
  directory
- engine startup is lazy and automatic on access
- engine cleanup is idle-based after 1 hour, not session-based
- engine reuse only occurs when runtime/API/schema versions are compatible
- no `connected_session_ids` lifecycle model remains
- no repo-local `.memories` storage remains
- no runtime native DB install logic remains
- Node 24 is the explicit and consistent baseline
- the launcher/runtime boundary for Node 24 is explicitly validated
- MCP `recall` auto-starts the engine and works from a stopped-engine state
- memory/search/pinned contracts expose memory-space metadata explicitly
- startup context includes pinned memory for the active space only
- `Stop` enqueues durable learning jobs and returns immediately
- learning job execution is owned by the global engine
- learning job execution is queued and serialized safely
- the UI can browse all spaces and focus one space
- lexical retrieval remains tag-based and does not index main memory content
- vendored `sqlite-vec` is committed, packaged, and used as the only semantic vector store in V1
- vec load failure on the supported platform causes explicit startup failure rather than semantic
  fallback
- cold marketplace install works from shipped artifacts alone
- the system still fails open on hook errors
- lint, typecheck, build, and targeted tests pass

---

## 22) Working Assumptions To Confirm Before Implementation

These are reasonable default assumptions for the rewrite unless changed before Stage 01:

1. Global storage root is `~/.claude/memories`.
2. V1 support is macOS `darwin-arm64` only.
3. `SessionEnd` is removed from steady-state hook wiring.
4. V1 learning concurrency is global single-file execution: one learning Claude job at a time
   globally.
5. `origin` is the only remote used for shared remote-scoped identity in V1.
6. If a Git repo has no usable `origin`, the fallback is a directory-scoped space rooted at the Git
   top-level directory.
7. There is no automatic import from old repo-local DBs in V1.
8. If the launcher is not already Node 24, the fallback is one minimal explicit bootstrap wrapper,
   not renewed runtime-discovery complexity.

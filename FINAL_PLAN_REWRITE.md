# Claude Memory Rewrite - Unified Global Plan

This file is the authoritative plan for the rewrite that replaces the current proof-of-concept
architecture.

`implementation-stages/FINAL_PLAN.md` remains useful only as historical context. For the rewrite,
follow this file instead.

Until the stage docs are regenerated from this rewrite plan, all sibling stage files in
`implementation-stages/` other than `FINAL_PLAN_REWRITE.md` must be treated as archived. They
describe the previous repo-local, session-managed architecture and must not be used as
implementation instructions.

The current repository is valuable as a concept and behavior reference, but it should not be
treated as architecture to preserve. Several core parts are explicitly being removed because they
are fragile, hard to reason about, or wrong for worktree-heavy usage.

---

## 1) Product Definition

This repository remains a Claude Code plugin marketplace that publishes one plugin:

- `memories`: local memory for Claude Code with global scope, repo scope, memory retrieval, queued
  learning, and a local UI.

The rewrite keeps the product local-only:

- one marketplace repo
- one plugin
- no hosted backend
- loopback-only runtime services
- one read-only MCP tool (`recall`)

The rewrite changes the storage and lifecycle model:

- one global engine process
- one global SQLite database
- repo identity based on the actual Git repository, not the current working directory path
- no session-managed engine lifetime
- idle-based cleanup instead of session-based cleanup

---

## 2) Current Repo Learnings

The current repo is a useful POC. It proves the feature set is worth building, but it also proves
that the current architecture is too fragile and too implicit.

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
- `sqlite-vec` adds complexity but is not the real search path in practice.
- Lexical search indexing only tags is too weak.
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
- Current lexical search indexes `tags_text`, not the main memory content.

---

## 3) Non-Negotiable Rewrite Decisions

1. Node 24 is the required target runtime for the rewrite.
2. Stage 00 must verify whether Claude launches plugin entrypoints under Node 24. If that cannot be
   guaranteed, keep only a tiny launcher-compatible bootstrap wrapper that re-execs the real Node
   24 runtime while preserving fail-open behavior. Do not reintroduce heuristic runtime discovery.
3. Use built-in `node:sqlite` from Node 24. Do not keep runtime native dependency installation.
4. Store all persistent data under one global Claude memory directory, not inside repos.
5. Use one global DB for all repos, worktrees, and memory scopes.
6. Do not manage engine lifetime through sessions.
7. Engine startup must be lazy:
   - on `SessionStart`
   - on `UserPromptSubmit`
   - on `Stop`
   - on MCP `recall`
   - on any UI/API access that needs the engine
8. Engine cleanup must be idle-based:
   - after 1 hour without activity
   - never while a learning job is active
9. Repo identity must be Git-repo-aware and worktree-safe.
10. Global scope and repo scope must both exist.
11. All read/write/search contracts must carry scope and repo identity explicitly.
12. When working inside a repo, retrieval must combine:
    - global scope
    - current repo scope
13. Learning jobs must be queued and serialized in an explicit, durable way.
14. Learning jobs must be leased and executed only by the global engine, never by an untracked
    detached hook subprocess.
15. Global engine reuse and global DB access must be version- and schema-compatible.
16. Cold marketplace installs must work from shipped artifacts alone, with no plugin-local
    `npm install` step.
17. No repo-local DBs, lock files, logs, or runtime artifacts.
18. Hooks must remain fail-open.
19. MCP stdout must remain protocol-clean.

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
  -> repo registry + scoped memories + events + learning queue
```

High-level behavior:

1. A caller resolves or provides the current working context.
2. `ensureEngine()` reuses or starts one global engine.
3. The engine resolves repo identity when relevant.
4. Retrieval uses global scope plus repo scope when inside a repo.
5. `Stop` enqueues learning work instead of trying to own engine lifetime through sessions.
6. The engine exits after 1 hour of inactivity.
7. The next access starts it again automatically.

This is intentionally simpler than the current design:

- no per-repo engines
- no connected session registry
- no session drain callback model
- no background-hook-only in-memory ownership model

---

## 6) Repo Identity And Worktree Resolution

Repo identity must surround the actual Git repo, not the path Claude happened to start in.

### Resolution Rules

Given hook/MCP/UI input, resolve context in this order:

1. explicit `project_root` when provided
2. explicit `cwd` when provided
3. `CLAUDE_PROJECT_DIR`
4. `process.cwd()`

Then:

1. Check whether the resolved directory is inside a Git work tree.
2. If not inside Git:
   - operate in global-only mode
   - do not create repo-scoped state
3. If inside Git:
   - resolve absolute worktree root with `git rev-parse --show-toplevel`
   - resolve absolute common git dir with `git rev-parse --path-format=absolute --git-common-dir`
   - canonicalize both with `realpath`

### Stable Repo Key

The stable repo key must be derived from the canonical common git dir, not the current worktree
path.

Recommended shape:

- `repo_key = sha256(realpath(common_git_dir))`

Why:

- all worktrees of the same repo share the same common git dir
- separate clones remain separate repos
- symlinked openings normalize to the same repo

### Stored Repo Metadata

The repo registry must store enough information for search, UI, and debugging:

- `id`
- `repo_key`
- `display_name`
- `git_common_dir`
- `last_seen_worktree_root`
- `first_seen_worktree_root`
- `origin_url` when available
- `created_at`
- `updated_at`
- `last_seen_at`

Optional but useful:

- `default_branch`
- `current_branch_last_seen`

### Worktrees

Worktrees must not create separate repos.

Instead:

- one repo record
- many seen worktree roots
- one shared repo-scoped memory space

Path matchers must be stored as repo-relative paths, never as absolute filesystem paths.

---

## 7) Scope Model

The rewrite introduces explicit scope.

### Scope Kinds

- `global`
- `repo`

### Global Scope

Global scope is for durable memory that should apply everywhere, especially rules and preferences.

Examples:

- coding preferences that apply in every repo
- reusable safety constraints
- personal workflow conventions

### Repo Scope

Repo scope is for memory tied to one Git repo.

Examples:

- repo architecture decisions
- repo-specific rules
- repo-specific facts
- file/path-scoped constraints

### Scope Behavior

When Claude is inside a repo:

- retrieval uses `global + current repo`
- startup pinned context uses `global + current repo`
- UI repo focus shows repo memory and can optionally include global overlays

When Claude is not inside a repo:

- retrieval uses `global` only
- startup pinned context uses `global` only

### Path Matcher Rule

Path matchers are repo-relative and only valid for repo-scoped memories.

V1 rule:

- global memories do not support path matchers

This keeps the semantics obvious and avoids surprising cross-repo path behavior.

### Canonical Read/Write Contracts

The rewrite must not leave scope semantics implicit. Every memory-shaped read result must include:

- `id`
- `scope_kind`
- nullable `repo_id`
- nullable `repo_display_name`
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

- manual create requires explicit `scope_kind`
- repo-scoped create requires either explicit `repo_id` or current repo context
- global create rejects path matchers
- V1 updates may change content, tags, pin state, and path matchers
- V1 updates may not move a memory between `global` and `repo`
- V1 updates may not change `repo_id`

Automatic learning rules:

- when inside Git, automatic `Stop` learning may only create or update repo-scoped memories
- automatic learning must never create or update global-scope memories in V1
- when there is no repo context, automatic learning should skip rather than invent global scope

Cross-repo read rules:

- if an API/UI/MCP response can contain more than one repo or more than one scope, the response and
  rendered output must annotate repo and scope clearly
- `scope = 'all'` is only acceptable if those annotations are present

---

## 8) Data Model

The new DB must model repos, scopes, memories, retrieval indexes, events, and queued learning jobs.

### Core Tables

#### `repos`

Stores one record per real Git repo identity.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `repo_key TEXT NOT NULL UNIQUE`
- `display_name TEXT NOT NULL`
- `git_common_dir TEXT NOT NULL`
- `first_seen_worktree_root TEXT`
- `last_seen_worktree_root TEXT`
- `origin_url TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`

#### `repo_worktrees`

Tracks observed worktree roots for a repo.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE`
- `worktree_root TEXT NOT NULL UNIQUE`
- `first_seen_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`

#### `memories`

Source of truth for all memories.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'repo'))`
- `repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE`
- `memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'rule', 'decision', 'episode'))`
- `content TEXT NOT NULL`
- `tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json))`
- `is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1))`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Required invariant:

- `repo_id IS NULL` when `scope_kind = 'global'`
- `repo_id IS NOT NULL` when `scope_kind = 'repo'`

#### `memory_path_matchers`

Suggested columns:

- `id TEXT PRIMARY KEY`
- `memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE`
- `path_matcher TEXT NOT NULL`
- `created_at TEXT NOT NULL`

Required invariant:

- path matchers may only exist for repo-scoped memories

#### `memory_fts`

Lexical search must be stronger than the current implementation.

V1 requirement:

- index memory content and tags
- do not repeat the current tag-only FTS design

Suggested shape:

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  id UNINDEXED,
  content_text,
  tags_text
);
```

#### `memory_embeddings`

Suggested columns:

- `memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE`
- `vector_json TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

V1 decision:

- keep embeddings in JSON
- do not add `sqlite-vec` back into the first rewrite

#### `learning_jobs`

Durable queue for post-stop learning work.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE`
- `worktree_root TEXT`
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
- `repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL`
- `worktree_root TEXT`
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
4. sync embeddings
5. rollback on any failure

Delete sequence:

1. delete path matchers
2. delete FTS row
3. delete embedding row
4. delete memory row

### Important Non-Goals

- no session table as a lifecycle authority
- no repo-local lock metadata
- no per-repo DB files
- no sqlite-vec mirror table in v1

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
- repo-touch and job-enqueue paths must be idempotent under concurrent callers

### Activity Rules

The engine must update `last_activity_at` whenever it handles meaningful work:

- startup context fetch
- search
- CRUD
- repo resolution/touch
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

- never run more than one learning job at the same time for the same `repo_id`

### Worker Behavior

For each job:

1. read transcript
2. derive repo-relative related paths
3. search candidate memories using `global + repo`
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
- repo and time metadata

---

## 11) Retrieval Strategy

The rewrite keeps hybrid retrieval but fixes the current weak and implicit parts.

### Scope Of Search

When in repo:

- search `global + repo`

When outside repo:

- search `global`

### Branches

1. Path-aware branch:
   - repo-scoped memories only
   - repo-relative path matchers
2. Lexical branch:
   - FTS over content and tags
3. Semantic branch:
   - embeddings over content

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
3. scope relevance:
   - repo-scoped should beat global when relevance is otherwise equal
4. pinned status
5. recency

### Path Matcher Contract

Path matcher handling must be explicit because it has been one of the most failure-prone parts of
the current implementation.

V1 rules:

- only repo-relative path matchers are allowed
- reject broad catch-alls such as `*`, `**`, `**/*`, `/`, and `./`
- strip line-number suffixes and similar transcript noise before validation
- basename-only promotion is allowed only when it resolves unambiguously to one related repo path
- cap matcher count per memory/action to prevent noisy retrieval
- test ranking across exact file, exact dir, single-glob, and deep-glob cases

### Ollama Contract

Keep local Ollama embeddings, but do not repeat the current startup-blocking behavior.

Required behavior:

- engine must still start when Ollama is unavailable
- search must degrade to path + lexical retrieval
- UI and logs should surface semantic-unavailable state
- missing Ollama must not disable the whole plugin

### Token Budget

Keep a response token budget for MCP and startup injection.

Current useful default:

- `6000`

But the new plan must treat this as a real, wired setting if exposed, not dead config.

---

## 12) Startup Context

Pinned startup memory remains useful, but it now needs scope awareness.

### SessionStart Injection

When inside repo:

- inject pinned global memories
- inject pinned repo memories for the current repo

When outside repo:

- inject pinned global memories only

### Formatting

Startup markdown should clearly separate:

- global pinned memory
- repo pinned memory

This is better than one undifferentiated block because the user and model need to understand what
is cross-repo versus repo-specific.

### Guidance Contract

The startup additional context must preserve the behavioral cues that make memory actually usable:

- state clearly that `recall` is the main memory retrieval path
- state clearly that the startup block contains pinned memory only, not the full memory set
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
3. resolve repo identity when inside Git
4. upsert repo/worktree last-seen metadata
5. fetch pinned startup memory for the active scope
6. return:
   - top-level `systemMessage` with Memory UI URL
   - additional context with pinned memory markdown
7. fail open on any error

### `UserPromptSubmit`

Required behavior:

1. resolve current context
2. ensure global engine
3. refresh engine activity
4. refresh repo/worktree last-seen metadata when inside Git
5. inject lightweight reminder to use `recall`
6. fail open on any error

This hook should stay lightweight. It should not re-inject the full pinned startup block.

It should preserve the lightweight reminder behavior from the current implementation:

- use `recall` before acting when memory may matter
- direct requests do not override remembered project rules

### `Stop`

Required behavior:

1. resolve current context
2. ensure global engine
3. resolve repo identity when inside Git
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
4. search using the active scope
5. return markdown only

### Tool Description Policy

The `recall` tool description must continue to carry explicit invocation guidance:

- use `recall` before acting on non-trivial work
- use it again when scope changes
- pinned startup context is not the full memory set

### Scope Modes

Recommended input:

- `scope: 'auto' | 'global' | 'repo' | 'all'`

Meaning:

- `auto`
  - inside repo: `global + current repo`
  - outside repo: `global`
- `global`
  - global only
- `repo`
  - current repo only
- `all`
  - global plus all repos, mainly for diagnostics and UI-adjacent workflows

### Important Difference From Current Code

`recall` must not fail just because the engine is not already running.

It must:

- auto-start the engine
- not depend on a pre-existing repo-local lock file
- annotate repo and scope whenever results span more than one repo or more than one scope

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

The UI must stop assuming one repo per origin.

### High-Level Behavior

The UI is served from the global engine at `/ui` and reflects:

- global memories
- repo memories
- repo list
- learning queue
- operational logs

### Required Features

#### Top Bar

Show global stats:

- total memories
- total repos
- queued jobs
- running jobs
- uptime
- online/offline
- idle timeout status

#### Focus Selector

Support focus modes:

- `Current repo`
- `All repos`
- `Global only`
- explicit repo selection

#### Memories View

Show:

- scope chip (`global` or repo)
- repo chip when relevant
- type
- pin state
- path matchers
- tags
- updated time

Create/edit must support:

- scope selection
- repo selection when needed
- path matchers only for repo scope

#### Jobs View

Replace the current background-hooks tab with a real queue/jobs view.

Show:

- queued
- running
- completed
- failed
- repo
- transcript path
- attempts
- timestamps
- error details

#### Logs View

Show a unified event timeline with:

- repo filter
- status filter
- pagination or capped recent window
- expandable structured payloads

### Search Behavior

UI search must be scope-aware and repo-aware.

Examples:

- in `Current repo`, search `global + repo`
- in `Global only`, search global memories only
- in `All repos`, search across everything

---

## 16) API Surface

The new API drops sessions and background-hook endpoints.

### Required Endpoints

- `GET /health`
- `GET /stats`
- `GET /repos`
- `POST /repos/touch`
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

- memory CRUD/search/pinned payloads and results carry `scope_kind` and repo metadata explicitly
- `POST /memories/pinned` accepts scope mode and current repo context rather than assuming one
  implicit repo
- `POST /memories/search` accepts scope mode and optional repo filter
- `GET /memories` supports scope/repo filtering
- `POST /memories/add` requires explicit `scope_kind`
- repo-scoped writes require repo context
- global writes reject path matchers
- `PATCH /memories/:id` must not move memories across scope or repo in V1
- `POST /learning-jobs` records resolved repo/worktree context when available
- UI-facing results spanning multiple repos/scopes must include visible repo metadata

### Explicitly Removed

- `POST /sessions/connect`
- `POST /sessions/disconnect`
- `/background-hooks/*`

### Boundary Rules

- validate all input with zod
- keep route handlers thin
- attach repo context explicitly
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

Use built-in `node:sqlite` from Node 24.

Therefore remove from the new architecture:

- `better-sqlite3`
- `sqlite-vec`
- runtime `npm install` of DB dependencies
- ABI-specific native cache directories
- node runtime binary discovery logic
- `MEMORIES_NODE_BIN`

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
- validation must include a cold-install simulation with no plugin `node_modules`

### Config Surface

Do not keep dead config.

If a setting exists, it must be wired end-to-end.

Expected real settings for the rewrite:

- `CLAUDE_MEMORY_HOME`
- `MEMORIES_ENGINE_BOOT_TIMEOUT_MS`
- `MEMORIES_ENGINE_IDLE_TIMEOUT_MS`
- `MEMORIES_OLLAMA_URL`
- `MEMORIES_OLLAMA_PROFILE`
- `MEMORIES_MCP_REQUEST_TIMEOUT_MS`

Optional only if Stage 00 proves the launcher is not already Node 24:

- one explicit Node 24 bootstrap path setting for the minimal wrapper

---

## 18) Migration Strategy

This rewrite should be treated as a fresh architecture, not a patch on the current lifecycle model.

### Initial Position

- current repo-local DBs are reference data, not authoritative storage for the rewrite
- current implementation is a behavior reference, not a migration contract

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
6. repo identity resolution tests
7. storage transaction tests
8. schema migration and compatibility tests
9. retrieval tests
10. queue and lease recovery tests
11. MCP recall tests
12. cold-install packaging tests
13. parallel startup/idempotency tests

### Manual

1. Start inside one repo and verify startup context includes global + repo pinned memory.
2. Start in two worktrees of the same repo and verify both read/write the same repo-scoped memory.
3. Trigger `Stop` in both worktrees close together and verify queue serialization.
4. Run a marketplace-style cold install from committed artifacts only and verify hooks/MCP/UI start
   with no plugin-local `node_modules`.
5. Verify the launcher/runtime boundary:
   - either plugin entrypoints already run under Node 24
   - or the minimal bootstrap wrapper re-execs Node 24 correctly
6. Let the engine idle with a short test timeout and verify automatic shutdown.
7. Trigger `UserPromptSubmit`, `SessionStart`, `Stop`, and MCP `recall` against a stopped engine and
   verify auto-start.
8. Run without Ollama and verify:
   - engine still starts
   - lexical/path retrieval still works
9. Open `/ui` and verify:
   - repo selection works
   - global focus works
   - job queue is visible
   - logs are filterable
10. Verify search and list results visibly annotate scope and repo where needed.
11. Verify a repo with a legacy `.memories/ai_memory.db` gets a clear non-destructive notice.
12. Verify no repo-local `.memories` folders are created.
13. Verify no `native/<platform>-<arch>-abi...` artifacts are created.

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
2. confirm repo identity algorithm
3. confirm launcher/runtime boundary for Node 24
4. confirm `SessionEnd` removal or noop behavior
5. confirm queue concurrency rule
6. archive or mark old stage docs as non-authoritative before implementation begins

Gate:

- user approval on the plan

### Stage 01 - Shared Foundations

Goal:

- establish global paths, constants, schemas, repo resolver primitives, and event model

Micro-steps:

1. global storage path helpers
2. repo identity resolver
3. core zod schemas for scope-bearing memory/search/pinned contracts
4. jobs, logs, and event contracts
5. structured event service

Gate:

- unit tests for path resolution and repo identity

### Stage 02 - Node 24 And SQLite Baseline

Goal:

- enforce Node 24 and replace the native runtime story

Micro-steps:

1. package metadata and build target updates
2. decide and implement the minimal bootstrap boundary if Node 24 launcher guarantee is absent
3. remove new-design dependency on `better-sqlite3` and `sqlite-vec`
4. add SQLite bootstrap layer for built-in `node:sqlite`
5. prove cold-install packaging assumptions locally

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

- implement repos, worktrees, memories, FTS, embeddings, jobs, and events tables

Micro-steps:

1. repo tables
2. scoped memories and path matcher invariants
3. FTS and embeddings tables
4. jobs and events tables
5. schema versioning and ordered migrations

Gate:

- transaction and constraint tests

### Stage 05 - Retrieval

Goal:

- implement scoped retrieval with stronger lexical behavior

Micro-steps:

1. repo/global scope filters
2. content + tag lexical search
3. semantic branch with Ollama fallback
4. path-aware merge and ranking

Gate:

- retrieval tests for scope, path, lexical, semantic fallback, and ranking

### Stage 06 - API

Goal:

- expose the new sessionless API

Micro-steps:

1. `/health`, `/stats`, `/repos`
2. scope-bearing memory CRUD and search
3. pinned context endpoint
4. jobs and logs endpoints
5. explicit repo/scope metadata in all relevant responses

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
4. repo-only automatic write policy
5. apply actions with durable status updates

Gate:

- queue serialization and lease recovery tests

### Stage 09 - MCP Recall

Goal:

- make recall auto-start and scope-aware

Micro-steps:

1. auto engine startup
2. scope input and repo resolution
3. cold-start timeout split
4. markdown output updates with repo/scope annotations where needed

Gate:

- MCP tests from stopped-engine and inside/outside-repo scenarios

### Stage 10 - UI Rewrite

Goal:

- build the multi-repo UI over the new model

Micro-steps:

1. global stats and repo selector
2. scoped memory list and CRUD
3. jobs view
4. logs view

Gate:

- manual multi-repo UI walkthrough

### Stage 11 - Packaging Cleanup

Goal:

- finalize manifests, build outputs, and docs around the new runtime

Micro-steps:

1. manifest updates
2. build config cleanup
3. remove native-runtime assumptions from docs and code
4. ensure archived docs cannot be mistaken for live implementation instructions

Gate:

- clean build and correct plugin wiring

### Stage 12 - Hardening

Goal:

- validate end-to-end behavior and fix drift

Micro-steps:

1. concurrency and worktree scenarios
2. idle restart scenarios
3. semantic unavailable scenarios
4. security/privacy pass

Gate:

- full checklist in Section 19 passes

---

## 21) Final Acceptance Criteria

The rewrite is complete only when all of the following are true:

- there is one global engine process, not one engine per repo path
- there is one global SQLite DB for all repos and scopes
- starting Claude in two worktrees of the same repo uses the same repo-scoped memory
- engine startup is lazy and automatic on access
- engine cleanup is idle-based after 1 hour, not session-based
- engine reuse only occurs when runtime/API/schema versions are compatible
- no `connected_session_ids` lifecycle model remains
- no repo-local `.memories` storage remains
- no runtime native DB install logic remains
- Node 24 is the explicit and consistent baseline
- the launcher/runtime boundary for Node 24 is explicitly validated
- MCP `recall` auto-starts the engine and works from a stopped-engine state
- memory/search/pinned contracts expose scope and repo metadata explicitly
- startup context includes global and repo pinned memory correctly
- `Stop` enqueues durable learning jobs and returns immediately
- learning job execution is owned by the global engine
- learning job execution is queued and serialized safely
- the UI can browse all repos and focus one repo
- lexical retrieval searches real memory content, not just tags
- cold marketplace install works from shipped artifacts alone
- the system still fails open on hook errors
- lint, typecheck, build, and targeted tests pass

---

## 22) Working Assumptions To Confirm Before Implementation

These are reasonable default assumptions for the rewrite unless changed before Stage 01:

1. Global storage root is `~/.claude/memories`.
2. `SessionEnd` is removed from steady-state hook wiring.
3. V1 learning concurrency is global single-file execution:
   - one learning Claude job at a time globally
4. Global scope is available for all memory types, even though the first practical use will mostly
   be global rules/preferences.
5. There is no automatic import from old repo-local DBs in V1.
6. If the launcher is not already Node 24, the fallback is one minimal explicit bootstrap wrapper,
   not renewed runtime-discovery complexity.

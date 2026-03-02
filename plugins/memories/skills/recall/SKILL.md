---
name: recall
description: Use this for exploration, discovery, understanding, and before non-trivial implementation when prior project memory could change decisions. Always execute in a context-fork subagent and call mcp__memories__recall.
---

# Memory Recall

Use this skill only for memory discovery. It is read-only and non-destructive.

## Mandatory Usage Policy

1. Use this skill when prior memory context can affect correctness or safety.
2. For exploration/discovery/understanding tasks, run at least one recall query before assuming no memory exists.
3. Before non-trivial implementation work (new features, meaningful refactors, behavior-changing fixes), run at least one recall query unless the user explicitly says to skip memory lookup.
4. Every recall lookup must run in a context-fork subagent, never in the parent agent context.
5. The subagent must call `mcp__memories__recall` only.
6. Start with one broad query, then follow up with narrower queries if needed.
7. If results are empty or low-confidence, proceed without inventing memory.
8. Do not call memory write tools or routes from this skill.

## Execution Contract

### Step 1: Launch a context-fork subagent

Run one subagent call per lookup request.

### Step 2: Call MCP tool

Use:

- `mcp__memories__recall`

Input schema:

- `query` (string, required)
- `project_root` (string, optional absolute path; defaults to current working directory in the tool)
- `limit` (integer, optional, default 10, max 50)
- `memory_types` (array of `fact|rule|decision|episode`, optional)
- `include_pinned` (boolean, optional, default true)

### Step 3: Consume markdown response

The tool returns markdown only. Success output shape is:

- Begins with `# Memory Recall`
- Metadata bullets: `Query`, `Returned`, `Duration`, `Source`
- Sections in exact order:
  - `## Facts`
  - `## Rules`
  - `## Decisions`
  - `## Episodes`
- Each item includes memory content and metadata line with `id`, `score`, `pinned`, `updated_at`, `tags`
- Empty sections render `- None`

Use the returned markdown directly, then add concise synthesis when needed.

## Error Contract

- Tool/runtime failures come back as MCP errors (`isError=true`) with actionable text.
- Engine 4xx/5xx are surfaced as concise `code: message` text.
- On error, fail open: report briefly and continue normal repo analysis without fabricating memory.

## Forbidden Actions

- Direct HTTP calls from this skill (`curl`, raw fetch to memory routes).
- Memory write tools/routes.
- Any tool other than `mcp__memories__recall`.

# memories plugin

Local project-scoped memory for Claude Code with:

- Hook lifecycle integration (`SessionStart`, `PreToolUse`, `Stop`, `SessionEnd`)
- Local SQLite persistence (memories, FTS, path matchers)
- Hybrid retrieval (path-aware + lexical + semantic fallback)
- MCP stdio server exposing read-only `recall`
- Local web UI for memory CRUD and logs

## Build

From repository root:

```bash
npm install
npm run build
```

## Validate

```bash
npm run lint
npm run typecheck
npm run build
```

## Runtime Notes

- Engine binds to loopback only (`127.0.0.1`)
- Project storage root: `<projectRoot>/.memories`
- Stop extraction runs as detached worker and is fail-safe on invalid output

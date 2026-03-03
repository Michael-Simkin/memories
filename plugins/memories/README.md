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
- Semantic embeddings use local Ollama (`/api/embed`) with selectable profiles:
  - `MEMORIES_OLLAMA_PROFILE=bge` -> model `bge-m3` (1024 dims, default)
  - `MEMORIES_OLLAMA_PROFILE=nomic` -> model `nomic-embed-text` (768 dims)
- Ensure Ollama is running and model is present:
  - `ollama pull bge-m3`
  - `ollama pull nomic-embed-text`
  - `ollama serve` (if not already running as a service)
- Configure model choice in Claude settings (recommended):
  - `.claude/settings.json` or `.claude/settings.local.json`
  - Example:

    ```json
    {
      "env": {
        "MEMORIES_OLLAMA_PROFILE": "nomic"
      }
    }
    ```

- Optional embedding environment variables:
  - `MEMORIES_OLLAMA_URL` (default: `http://127.0.0.1:11434`)
  - `MEMORIES_OLLAMA_PROFILE` (`bge` or `nomic`, default: `bge`)
  - `MEMORIES_OLLAMA_MODEL` (explicit model override; default comes from profile)
  - `MEMORIES_OLLAMA_TIMEOUT_MS` (default: `10000`)
  - `MEMORIES_EMBEDDING_DIMENSIONS` (optional explicit override; default inferred from selected model/profile)

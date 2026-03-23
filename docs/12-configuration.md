# Configuration

## Plugin Configuration Files

### `settings.json` (plugin settings)

```json
{
  "maxHookInjectionTokens": 6000,
  "semanticK": 30,
  "lexicalK": 30
}
```

| Key | Purpose | Default |
|---|---|---|
| `maxHookInjectionTokens` | Token budget for recall results in hook context injection | 6000 |
| `semanticK` | Number of candidates from semantic (embedding) search | 30 |
| `lexicalK` | Number of candidates from lexical (FTS) search | 30 |

### `.mcp.json` (MCP server declaration)

Declares the `memories` MCP server for Claude Code to discover:
- Transport: stdio
- Command: `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp/search-server.js`
- Env: `MEMORIES_MCP_ENGINE_TIMEOUT_MS=2500`

### `plugin.json` (plugin manifest)

Plugin metadata: name, version, license, keywords.

### `marketplace.json` (marketplace listing)

Marketplace metadata: owner, category, description.

---

## Environment Variables

| Variable | Where Used | Default | Purpose |
|---|---|---|---|
| `MEMORIES_ENGINE_PORT` | engine/main.ts | ephemeral | Force a specific engine port |
| `MEMORIES_NODE_BIN` | engine/node-runtime.ts | (probe) | Override Node binary path for engine |
| `MEMORIES_OLLAMA_URL` | retrieval/embeddings.ts | `http://127.0.0.1:11434` | Ollama server URL |
| `MEMORIES_OLLAMA_PROFILE` | shared/constants.ts | `bge` | Embedding model profile (`bge` or `nomic`) |
| `MEMORIES_OLLAMA_TIMEOUT_MS` | retrieval/embeddings.ts | (per-profile) | Ollama request timeout |
| `MEMORIES_MCP_ENGINE_TIMEOUT_MS` | mcp/search-server.ts | `2500` | MCP recall engine request timeout |
| `LOG_LEVEL` | shared/logger.ts | `info` | Logging level (debug/info/warn/error) |
| `CLAUDE_CODE_SIMPLE` | extraction/run.ts | (injected as `1`) | Set on claude subprocess |
| `CLAUDE_PLUGIN_ROOT` | hooks, paths | (set by Claude Code) | Plugin installation directory |
| `CLAUDE_PROJECT_ROOT` | shared/paths.ts | (set by Claude Code) | Current project directory |
| `NVM_DIR` / `NVM_BIN` | engine/node-runtime.ts | (from shell) | NVM paths for Node discovery |

---

## Build Configuration

### tsup (backend bundler)

- Entry points: `engine/main`, `extraction/run`, `hooks/session-start`, `hooks/stop`, `hooks/user-prompt-submit`, `mcp/search-server`
- Format: ESM
- Target: Node 24
- Bundles all runtime dependencies (zero node_modules needed at runtime)
- Post-build: `sed` patches `from "sqlite"` to `from "node:sqlite"` in engine output
- Banner injects `createRequire` for CJS compatibility

### Vite (frontend bundler)

- Base path: `/ui/`
- Plugin: `@vitejs/plugin-react`
- Root: `web/`
- Output: `web/dist/`

---

## TypeScript Configuration

### Base (`tsconfig.base.json`)

- Target: ES2022
- Module: NodeNext
- Module resolution: NodeNext
- Strict mode + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`

### Backend (`plugins/memories/tsconfig.json`)

- Extends base
- Root: `src/`, Output: `dist/`
- Types: `["node"]`

### Frontend (`plugins/memories/web/tsconfig.json`)

- Extends base
- Module: ESNext, Resolution: Bundler
- JSX: react-jsx
- Lib: ES2022 + DOM + DOM.Iterable
- Types: `["vite/client"]`

# Engine HTTP API Routes

The engine runs at `http://127.0.0.1:<port>` (loopback only). Port is dynamically chosen and recorded in the lock file. All endpoints except `/health` and `/ui/*` reset the idle timer.

## Health & Control

### `GET /health`
Returns engine status. **Does not reset idle timer.**

**Response:**
```json
{ "ok": true, "port": 54321 }
```

---

### `GET /stats`
Returns engine metrics. Also triggers background hook sweep.

**Response:**
```json
{
  "active_background_hooks": 0,
  "online": true,
  "uptime_ms": 12345,
  "last_interaction_at": "2024-01-01T00:00:00.000Z",
  "idle_timeout_ms": 1800000,
  "idle_remaining_ms": 900000
}
```

---

### `POST /shutdown`
Triggers graceful shutdown asynchronously. Returns immediately.

**Response:**
```json
{ "status": "shutting_down" }
```

---

## Repository Management

### `GET /repos`
Lists all known repositories.

**Response:**
```json
{ "repos": [{ "repo_id": "abc123", "label": "my-project" }] }
```

---

### `POST /repos/label`
Upserts a human-readable label for a repo.

**Request:**
```json
{ "repo_id": "abc123", "label": "my-project" }
```

**Response:** `{ "ok": true }`

---

## Memory CRUD

### `GET /memories?repo_id=&limit=50&offset=0`
Lists memories paginated. Returns up to 200 at once.

**Response:**
```json
{
  "items": [Memory, ...],
  "total": 42
}
```

---

### `GET /memories/pinned?repo_id=`
Returns all pinned memories for a repo (no search, direct DB query).

**Response:**
```json
{
  "meta": { "duration_ms": 5, "query": "pinned", "returned": 3, "source": "hybrid" },
  "results": [SearchResult, ...]
}
```

---

### `POST /memories/search`
Hybrid search: semantic + lexical + path-match + RRF fusion.

**Request:**
```json
{
  "repo_id": "abc123",
  "query": "how do we handle auth",
  "limit": 20,
  "include_pinned": true,
  "target_paths": ["src/auth/middleware.ts"],
  "memory_types": ["rule", "fact"],
  "lexical_k": 20,
  "semantic_k": 20,
  "response_token_budget": 4000
}
```

**Response:**
```json
{
  "meta": { "duration_ms": 45, "query": "...", "returned": 8, "source": "hybrid" },
  "results": [
    {
      "id": "uuid", "content": "...", "memory_type": "rule",
      "tags": [], "is_pinned": false, "path_matchers": [],
      "score": 0.812, "matched_by": ["semantic", "lexical"],
      "path_score": 0.9, "lexical_score": 0.4, "semantic_score": 0.7,
      "rrf_score": 0.0123, "updated_at": "..."
    }
  ]
}
```

---

### `POST /memories/add`
Creates a new memory. Generates embedding if Ollama is available.

**Request:**
```json
{
  "repo_id": "abc123",
  "memory_type": "rule",
  "content": "Always use TypeScript strict mode",
  "tags": ["typescript"],
  "is_pinned": false,
  "path_matchers": [{ "path_matcher": "src/**/*.ts" }]
}
```

**Response:** `201 { "memory": Memory }`

---

### `PATCH /memories/:id`
Updates fields of an existing memory. Re-embeds if `content` changes.

**Request:**
```json
{
  "repo_id": "abc123",
  "content": "Updated content",
  "tags": ["new-tag"],
  "is_pinned": true,
  "path_matchers": [{ "path_matcher": "src/hooks" }]
}
```

**Response:** `{ "memory": Memory }`

---

### `DELETE /memories/:id?repo_id=`
Deletes a memory.

**Response:** `{ "memory_id": "uuid" }`

---

## Logs

### `GET /logs?limit=200&order=desc`
Returns persistent event log entries (from `ai_memory_events.log`).

**Response:**
```json
{
  "logs": [EventLog, ...],
  "total": 150
}
```

**EventLog shape:**
```json
{
  "at": "2024-01-01T00:00:00.000Z",
  "event": "extraction/apply",
  "kind": "operation",
  "status": "ok",
  "session_id": "sess-uuid",
  "memory_id": "mem-uuid",
  "detail": "created: prefer TypeScript strict mode",
  "data": { "hook_id": "bg-uuid", "action": "create", "confidence": 0.92 }
}
```

---

## Background Hooks

### `GET /background-hooks`
Lists currently active background hooks. Also triggers sweep.

**Response:**
```json
{
  "items": [BackgroundHook, ...],
  "meta": { "active": 1, "now": "2024-01-01T00:00:00.000Z" }
}
```

**BackgroundHook shape:**
```json
{
  "id": "uuid",
  "hook_name": "extraction",
  "state": "running",
  "started_at": "...",
  "last_heartbeat_at": "...",
  "stale_at": "...",
  "hard_timeout_at": "...",
  "session_id": "...",
  "pid": 12345
}
```

---

### `POST /background-hooks/start`
Registers an external background hook (not used by extraction — extraction registers itself).

**Request:**
```json
{ "id": "uuid", "hook_name": "my-hook", "session_id": "...", "pid": 12345 }
```

**Response:** `201 { "active": true, "ok": true }`

---

### `POST /background-hooks/:id/heartbeat`
Refreshes stale timeout for a running hook.

**Request:** `{ "pid": 12345 }`  
**Response:** `{ "active": true, "ok": true }`

---

### `POST /background-hooks/:id/finish`
Marks a background hook as complete and removes it.

**Request:** `{ "status": "ok" | "error" | "skipped", "detail": "..." }`  
**Response:** `{ "active": false, "ok": true }`

---

## Extraction Queue

### `GET /extraction/status`
Returns current extraction queue state.

**Response:**
```json
{
  "active": { "repo_id": "abc123", "transcript_path": "/path/to/file" },
  "queue": []
}
```

---

### `POST /extraction/enqueue`
Enqueues a transcript for memory extraction. If the same `repo_id` is already in the queue, it replaces the entry (deduplication).

**Request:**
```json
{
  "transcript_path": "/path/to/transcript.jsonl",
  "project_root": "/path/to/project",
  "repo_id": "abc123",
  "session_id": "sess-uuid",
  "last_assistant_message": "Here's how I implemented..."
}
```

**Response:** `202 { "ok": true }`

---

## Static Web UI

### `GET /ui` and `GET /ui/*`
Serves the built React web UI from `web/dist/`. Falls back to `index.html` for SPA routing. Asset files (`/ui/assets/*`) are served directly.

# Engine Lifecycle

The engine is a persistent local HTTP server (Express) that owns the SQLite database and coordinates all memory operations. It runs as a background process managed via a lockfile.

## Bootstrap Flow

Entry point: `engine/main.ts`

```mermaid
flowchart TD
    BOOT[bootstrap] --> PLUGIN[resolvePluginRoot]
    PLUGIN --> DIRS[ensureGlobalDirectories]
    DIRS --> VEC[resolveSqliteVecPath - check vendor/sqlite-vec]
    VEC --> PORT[pickPort]
    PORT --> APP[createEngineApp with all options]
    APP --> LISTEN[server.listen on LOOPBACK_HOST]
    LISTEN --> LOCK[writeLockMetadata to engine.lock]
    LOCK --> SIGNALS[Register SIGINT + SIGTERM handlers]
    SIGNALS --> RUNNING[Engine running]
```

### Port Selection (`pickPort`)
1. Check `MEMORIES_ENGINE_PORT` env var
2. If not set, bind to port 0 and read the assigned ephemeral port
3. Close the temp server, return the port

### Shutdown Flow

```mermaid
flowchart TD
    TRIGGER[Shutdown triggered] --> GUARD{Already shutting down?}
    GUARD -->|Yes| SKIP[Return]
    GUARD -->|No| SET[Set shuttingDown = true]
    SET --> LOG[Log reason]
    LOG --> CLOSE_SERVER[Close HTTP server]
    CLOSE_SERVER --> CLOSE_RUNTIME[runtime.close - stop timers]
    CLOSE_RUNTIME --> REMOVE_LOCK[removeLockIfOwned]
    REMOVE_LOCK --> EXIT[process.exit 0]
```

Shutdown reasons: `idle-timeout`, `api-request`, `sigint`, `sigterm`

---

## Engine Startup Coordination (`ensureEngine`)

Called by SessionStart and UserPromptSubmit hooks. Handles concurrent startup races.

```mermaid
flowchart TD
    START[ensureEngine called] --> DIRS[ensureGlobalDirectories]
    DIRS --> LOCK_READ[readHealthyEndpointFromLock]

    LOCK_READ -->|Healthy endpoint| RETURN_EXISTING[Return existing endpoint]
    LOCK_READ -->|Lock exists, PID alive, unhealthy| WAIT_RECOVERY[waitForExistingEngineRecovery]

    WAIT_RECOVERY -->|Recovers| RETURN_EXISTING
    WAIT_RECOVERY -->|Fails| STOP_UNHEALTHY[stopUnhealthyEngine]
    STOP_UNHEALTHY --> ACQUIRE

    LOCK_READ -->|No lock or dead PID| CLEAR[clearStaleStartupLock]
    CLEAR --> ACQUIRE[tryAcquireStartupLock]

    ACQUIRE -->|Lock acquired| RESOLVE_NODE[resolveEngineNodeRuntime]
    RESOLVE_NODE --> SPAWN[Spawn engine process]
    SPAWN --> POLL[Poll /health until healthy]
    POLL -->|Healthy| RETURN_NEW[Return new endpoint]
    POLL -->|Timeout 45s| THROW[Throw ENGINE_UNAVAILABLE]

    ACQUIRE -->|Lock held by another| WAIT_OTHER[Wait for other process to start engine]
    WAIT_OTHER --> POLL_LOCK[Poll lockfile for healthy endpoint]
    POLL_LOCK -->|Found| RETURN_OTHER[Return endpoint]
    POLL_LOCK -->|Timeout| THROW
```

### Key Timing Constants

| Constant | Default | Purpose |
|---|---|---|
| `DEFAULT_BOOT_TIMEOUT_MS` | 45,000ms | Max wait for engine to become healthy |
| `DEFAULT_BOOT_POLL_MS` | 120ms | Interval between health polls |
| `DEFAULT_HEALTH_TIMEOUT_MS` | 1,000ms | Timeout for single health check |
| `DEFAULT_UNHEALTHY_ENGINE_GRACE_MS` | 2,000ms | Grace period before killing unhealthy engine |
| `DEFAULT_ENGINE_TERMINATION_TIMEOUT_MS` | 5,000ms | Max wait for engine PID to exit after SIGTERM |
| `STARTUP_LOCK_STALE_MULTIPLIER` | 2x boot timeout | When startup lock is considered stale |

### Startup Lock Protocol

The startup lock (`startup.lock`) prevents multiple hook invocations from spawning duplicate engines:

```
1. Try to create startup.lock with O_EXCL (atomic create-or-fail)
2. If acquired: you are the spawner, proceed to spawn engine
3. If not acquired: another process is spawning, wait for lockfile to appear
4. Stale lock detection: if lock file's PID is dead or lock is older than 2x boot timeout, remove it
```

---

## Node Runtime Discovery

The engine requires Node 24 for `node:sqlite`. Discovery probes multiple sources.

```mermaid
flowchart TD
    START[resolveEngineNodeRuntime] --> CANDIDATES[candidateNodeExecutables]
    CANDIDATES --> PROBE[Probe each with node -p process.versions.node]
    PROBE --> FILTER[Filter to major >= 24]
    FILTER --> SELECT[selectPreferredNodeRuntime]
    SELECT --> RESULT[Return path + version]

    subgraph "Probe Order (10 sources)"
        P1["1. MEMORIES_NODE_BIN env var"]
        P2["2. /opt/homebrew/opt/node@24/bin/node"]
        P3["3. /usr/local/opt/node@24/bin/node"]
        P4["4. NVM_BIN/node"]
        P5["5. NVM_DIR/versions/node/*/bin/node (newest first)"]
        P6["6. ~/.asdf/installs/nodejs/*/bin/node"]
        P7["7. ~/.volta/tools/image/node/*/bin/node"]
        P8["8. process.execPath (current Node)"]
        P9["9. /opt/homebrew/bin/node"]
        P10["10. /usr/local/bin/node"]
    end
```

Selection priority: prefer exact major 24, fallback to highest available >= 24. Candidates are deduplicated by resolved path. Each probe runs `node -p process.versions.node` with a 1500ms timeout.

---

## Idle Timeout

The engine auto-shuts down after inactivity to avoid lingering processes.

```mermaid
flowchart TD
    START[Idle check interval runs] --> CHECK{Time since last interaction > idleTimeoutMs?}
    CHECK -->|No| WAIT[Wait for next interval]
    CHECK -->|Yes| BG_CHECK{Any active background hooks?}
    BG_CHECK -->|Yes| WAIT
    BG_CHECK -->|No| SHUTDOWN[Trigger onIdleTimeout callback]
    SHUTDOWN --> EXIT[Engine shuts down]
```

| Constant | Default |
|---|---|
| `DEFAULT_IDLE_TIMEOUT_MS` | 300,000ms (5 min) |
| `DEFAULT_IDLE_CHECK_INTERVAL_MS` | 30,000ms (30 sec) |

Any API request resets `lastInteractionAtMs`. Active background hooks (extraction workers) block idle shutdown.

---

## Lockfile Format

Stored at `~/.claude/memories/engine.lock`:

```json
{
  "host": "127.0.0.1",
  "port": 54321,
  "pid": 12345,
  "started_at": "2026-03-20T10:00:00.000Z"
}
```

- `host` must be loopback (`127.0.0.1`, `::1`, or `localhost`) -- validated on read
- PID liveness checked via `kill(pid, 0)` signal
- Written atomically (write to temp file, rename)
- Removed on shutdown only if PID matches current process

---

## `createEngineApp` Wiring

```mermaid
flowchart LR
    OPTIONS[EngineAppOptions] --> APP[Express App]
    OPTIONS --> STORE[MemoryStore]
    OPTIONS --> EMB_CLIENT[EmbeddingClient]
    OPTIONS --> RETRIEVAL[RetrievalService]

    APP --> ROUTES[REST Routes]
    ROUTES --> STORE
    ROUTES --> RETRIEVAL
    RETRIEVAL --> STORE
    RETRIEVAL --> EMB_CLIENT
    EMB_CLIENT --> OLLAMA[Ollama /api/embed]

    APP --> IDLE[Idle Timer]
    APP --> SWEEP[Background Hook Sweeper]
    APP --> QUEUE[Extraction Queue]
    APP --> STATIC[Static files: web/dist at /ui]
```

`EngineAppOptions` fields:
- `pluginRoot`, `dbPath`, `lockPath`, `eventLogPath`, `port`
- `sqliteVecExtensionPath` (nullable)
- `onIdleTimeout`, `onShutdownRequest` (callbacks)
- `idleTimeoutMs`, `idleCheckIntervalMs`, `backgroundHookPolicy` (overrides)

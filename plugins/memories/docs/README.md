# Memories Plugin — Flow Documentation

This folder documents the major flows, logic, and architecture of the `memories` Claude plugin.

## Contents

| File | Description |
|---|---|
| [session-start-flow.md](./session-start-flow.md) | How `SessionStart` bootstraps the engine and injects pinned memories |
| [stop-hook-flow.md](./stop-hook-flow.md) | How `Stop` enqueues extraction and spawns the background worker |
| [extraction-flow.md](./extraction-flow.md) | End-to-end extraction: transcript → Claude → memory actions → DB |
| [engine-lifecycle.md](./engine-lifecycle.md) | Engine bootstrap, lock management, idle timeout, and shutdown |
| [api-routes.md](./api-routes.md) | Engine HTTP API surface with request/response contracts |
| [retrieval-flow.md](./retrieval-flow.md) | Hybrid search (semantic + lexical + path-match + RRF fusion) |
| [logging-systems.md](./logging-systems.md) | Two logging systems: ephemeral stderr vs. persistent event log |
| [background-hooks.md](./background-hooks.md) | Background hook lease, heartbeat, expiry, and sweep |

## High-Level System Diagram

```mermaid
graph TD
    User[Claude Code session] --> SessionStart
    User --> UserPromptSubmit
    User --> Stop

    subgraph Hooks["Claude Code Hooks (short-lived Node processes)"]
        SessionStart["SessionStart Hook\nsession-start.ts"]
        UserPromptSubmit["UserPromptSubmit Hook\nuser-prompt-submit.ts"]
        Stop["Stop Hook\nstop.ts"]
    end

    subgraph Engine["Global Engine Process (persistent)"]
        API["Express HTTP API\napp.ts"]
        DB["SQLite DB\ndatabase.ts"]
        Retrieval["Hybrid Retrieval\nhybrid-retrieval.ts"]
        ExtractionQueue["Extraction Queue\n(in-memory)"]
        BackgroundHooks["Background Hook Tracker\n(in-memory Map)"]
    end

    subgraph Worker["Extraction Worker (detached child process)"]
        RunTS["run.ts\nexecuteWorker()"]
        ClaudeSubprocess["claude CLI\n(headless, -p)"]
    end

    SessionStart -->|ensureEngine| Engine
    SessionStart -->|GET /memories/pinned| API
    UserPromptSubmit -->|ensureEngine keepalive| API
    Stop -->|POST /extraction/enqueue| API
    API --> ExtractionQueue
    ExtractionQueue -->|spawns| Worker
    Worker -->|heartbeat/finish| API
    RunTS -->|search candidates| API
    RunTS -->|spawn| ClaudeSubprocess
    ClaudeSubprocess -->|JSON actions| RunTS
    RunTS -->|POST /memories/add\nPATCH /memories/:id\nDELETE /memories/:id| API
    API --> DB
    API --> Retrieval
    Retrieval --> DB
```

# SessionStart Flow

Triggered automatically by Claude Code when a new session begins.
Entry point: `src/hooks/session-start.ts → run()`

## Flow Diagram

```mermaid
flowchart TD
    A[Claude Code fires SessionStart hook] --> B[Read JSON payload from stdin]
    B --> C{Payload valid?}
    C -- No --> FAIL[writeFailOpenOutput\ncontinue=true, no context]
    C -- Yes --> D[ensureGlobalDirectories\ncreate ~/.claude/memories/*]

    D --> E[resolveRepoId\nhash of projectRoot path]
    E --> F[diagnoseOllamaStartupIssue]

    F --> G{Ollama OK?}
    G -- ollama_not_installed --> OI[Log skipped\nReturn systemMessage with brew install instructions]
    G -- ollama_service_not_running --> OS[Log skipped\nReturn systemMessage with brew services start]
    G -- ollama_model_missing --> OM[Log skipped\nReturn systemMessage with ollama pull]
    G -- OK --> H[resolveRepoLabel\nbasename of projectRoot]

    H --> I[ensureEngine\nStart or locate running engine]
    I --> J{Engine healthy?}
    J -- No / Node runtime missing --> NR[detectNodeRuntimeStartupIssue\nLog skipped, return setup instructions]
    J -- ENGINE_UNAVAILABLE error --> EU[Log skipped\nreturn generic failure message]
    J -- Other error --> ERR[Log error\nreturn generic failure message]
    J -- Yes --> K[POST /repos/label\nnon-fatal]

    K --> L[GET /memories/pinned?repo_id=...]
    L --> M[formatMemoryRecallMarkdown\nbuild pinned memories block]
    M --> N[appendEventLog kind=hook status=ok]
    N --> O[writeHookOutput\ncontinue=true\nsystemMessage=Memory UI URL\nadditionalContext=pinned memories XML block]
```

## Ollama Diagnosis

```pseudocode
diagnoseOllamaStartupIssue():
  profile = resolveOllamaProfile(MEMORIES_OLLAMA_PROFILE)
  model = OLLAMA_PROFILE_CONFIG[profile].model
  baseUrl = MEMORIES_OLLAMA_URL ?? "http://localhost:11434"

  if not isOllamaInstalled():
    return issue(ollama_not_installed)

  try:
    modelNames = fetchOllamaModelNames(baseUrl, timeout=min(configuredTimeout, 2500ms))
  catch OllamaServiceNotRunningError:
    return issue(ollama_service_not_running)

  if not hasOllamaModel(modelNames, model):
    return issue(ollama_model_missing)

  return null  // all good
```

## Session Context Injection

The hook returns `additionalContext` in this structure:

```xml
<memory>
  <guidance>
    The `recall` tool is your main memory brain for this project.
    REQUIRED: call `recall` before acting. Do not skip.
    ...
  </guidance>
  <pinned_memories>
    ## Memories
    ### [rule] ...
    ### [fact] ...
  </pinned_memories>
</memory>
```

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `MEMORIES_OLLAMA_PROFILE` | `default` | Selects Ollama model + embedding dimensions |
| `MEMORIES_OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `MEMORIES_OLLAMA_TIMEOUT_MS` | 5000 | Max wait for Ollama, capped at 2500ms for SessionStart |
| `MEMORIES_NODE_BIN` | (auto-detected) | Override Node binary for engine startup |

## Fail-Open Guarantee

All error branches return `{ continue: true }` — the hook never blocks Claude from starting.

// src/engine/ensure-engine.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import { setTimeout as wait } from "timers/promises";

// src/shared/fs-utils.ts
import { appendFile, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
async function readJsonFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function appendJsonLine(filePath, payload) {
  await appendFile(filePath, `${JSON.stringify(payload)}
`, "utf8");
}
async function removeFileIfExists(filePath) {
  try {
    await rm(filePath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function isErrnoException(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

// src/shared/lockfile.ts
import { z } from "zod";

// src/shared/constants.ts
var LOOPBACK_HOST = "127.0.0.1";
var LOOPBACK_HOST_ALIASES = [LOOPBACK_HOST, "localhost", "::1"];
var MEMORY_TYPES = ["fact", "rule", "decision", "episode"];
var MEMORY_DB_FILE = "ai_memory.db";
var ENGINE_LOCK_FILE = "engine.lock.json";
var MEMORY_EVENTS_LOG_FILE = "ai_memory_events.log";
var DEFAULT_SEARCH_LIMIT = 10;
var MAX_SEARCH_LIMIT = 50;
var DEFAULT_SEMANTIC_K = 30;
var DEFAULT_LEXICAL_K = 30;
var DEFAULT_RESPONSE_TOKEN_BUDGET = 6e3;

// src/shared/lockfile.ts
var lockMetadataSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  started_at: z.string().min(1),
  connected_session_ids: z.array(z.string().trim().min(1)).default([])
});
function isLoopback(host) {
  return LOOPBACK_HOST_ALIASES.includes(host);
}
async function readLockMetadata(lockPath) {
  const raw = await readJsonFile(lockPath);
  if (!raw) {
    return null;
  }
  const parsed = lockMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  if (!isLoopback(parsed.data.host)) {
    return null;
  }
  return {
    ...parsed.data,
    connected_session_ids: uniqueNonEmpty(parsed.data.connected_session_ids)
  };
}
function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

// src/shared/logger.ts
var LOG_LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
var REDACTION_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /(?<=token[=:]\s?)[A-Za-z0-9._-]+/gi
];
function resolveLogLevel(raw) {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error" || normalized === "silent") {
    return normalized;
  }
  return "info";
}
var configuredLogLevel = resolveLogLevel(process.env.LOG_LEVEL);
function shouldWrite(level) {
  if (configuredLogLevel === "silent") {
    return false;
  }
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[configuredLogLevel];
}
function redactString(value) {
  let redacted = value;
  for (const pattern of REDACTION_PATTERNS) {
    redacted = redacted.replaceAll(pattern, "[REDACTED]");
  }
  return redacted;
}
function redactUnknown(value) {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactUnknown(entry)
      ])
    );
  }
  return value;
}
function writeLog(level, message, data) {
  if (!shouldWrite(level)) {
    return;
  }
  const payload = {
    at: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    message: redactString(message),
    ...data ? { data: redactUnknown(data) } : {}
  };
  process.stderr.write(`${JSON.stringify(payload)}
`);
}
function logInfo(message, data) {
  writeLog("info", message, data);
}
function logWarn(message, data) {
  writeLog("warn", message, data);
}
function logError(message, data) {
  writeLog("error", message, data);
}

// src/shared/paths.ts
import { mkdir } from "fs/promises";
import path2 from "path";
import { fileURLToPath } from "url";
function resolveProjectRoot(explicitProjectRoot) {
  if (explicitProjectRoot && path2.isAbsolute(explicitProjectRoot)) {
    return explicitProjectRoot;
  }
  const envProjectRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envProjectRoot && path2.isAbsolute(envProjectRoot)) {
    return envProjectRoot;
  }
  return process.cwd();
}
function resolvePluginRoot() {
  const envPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envPluginRoot && path2.isAbsolute(envPluginRoot)) {
    return envPluginRoot;
  }
  const currentFilePath = fileURLToPath(import.meta.url);
  const moduleDirectory = path2.dirname(currentFilePath);
  return path2.resolve(moduleDirectory, "..", "..");
}
function getProjectPaths(projectRoot) {
  const memoriesDir = path2.join(projectRoot, ".memories");
  return {
    projectRoot,
    memoriesDir,
    dbPath: path2.join(memoriesDir, MEMORY_DB_FILE),
    lockPath: path2.join(memoriesDir, ENGINE_LOCK_FILE),
    eventLogPath: path2.join(memoriesDir, MEMORY_EVENTS_LOG_FILE)
  };
}
async function ensureProjectDirectories(projectRoot) {
  const projectPaths = getProjectPaths(projectRoot);
  await mkdir(projectPaths.memoriesDir, { recursive: true });
  return projectPaths;
}

// src/engine/ensure-engine.ts
var ENGINE_UNAVAILABLE_PREFIX = "ENGINE_UNAVAILABLE";
var REQUIRED_NODE_MAJOR = 20;
var DEFAULT_HEALTH_TIMEOUT_MS = 1e3;
var DEFAULT_BOOT_TIMEOUT_MS = 45e3;
var DEFAULT_BOOT_POLL_MS = 120;
function parseTimeoutMs(environmentName, fallback) {
  const rawValue = process.env[environmentName];
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
function engineUnavailable(message) {
  return new Error(`${ENGINE_UNAVAILABLE_PREFIX}: ${message}`);
}
function ensureNodeRuntimeSupported() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < REQUIRED_NODE_MAJOR) {
    throw engineUnavailable(`Node.js >=${REQUIRED_NODE_MAJOR} is required for engine startup.`);
  }
}
async function isEngineHealthy(endpoint) {
  const timeoutMs = parseTimeoutMs("MEMORIES_ENGINE_HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/health`, {
      method: "GET",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
async function ensureEngine(projectRoot) {
  ensureNodeRuntimeSupported();
  const paths = await ensureProjectDirectories(projectRoot);
  const pluginRoot = resolvePluginRoot();
  const lock = await readLockMetadata(paths.lockPath);
  if (lock && isPidAlive(lock.pid)) {
    const endpoint = { host: lock.host, port: lock.port };
    if (await isEngineHealthy(endpoint)) {
      return endpoint;
    }
    logWarn("Engine lock exists but endpoint is unhealthy; starting a replacement engine", endpoint);
  }
  if (lock && !isPidAlive(lock.pid)) {
    await removeFileIfExists(paths.lockPath);
  }
  const engineEntrypoint = `${pluginRoot}/dist/engine/main.js`;
  if (!existsSync(engineEntrypoint)) {
    throw engineUnavailable(`Engine entrypoint missing at ${engineEntrypoint}. Run npm run build.`);
  }
  const spawnState = { failure: null };
  const child = spawn(process.execPath, [engineEntrypoint], {
    detached: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PROJECT_ROOT: projectRoot
    },
    stdio: "ignore"
  });
  child.once("error", (spawnError) => {
    spawnState.failure = spawnError;
  });
  child.unref();
  const maxWaitMs = parseTimeoutMs("MEMORIES_ENGINE_BOOT_TIMEOUT_MS", DEFAULT_BOOT_TIMEOUT_MS);
  const pollMs = parseTimeoutMs("MEMORIES_ENGINE_BOOT_POLL_MS", DEFAULT_BOOT_POLL_MS);
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (spawnState.failure) {
      throw engineUnavailable(`Failed to spawn engine: ${spawnState.failure.message}`);
    }
    const nextLock = await readLockMetadata(paths.lockPath);
    if (nextLock && isPidAlive(nextLock.pid)) {
      const endpoint = {
        host: nextLock.host,
        port: nextLock.port
      };
      if (await isEngineHealthy(endpoint)) {
        logInfo("Engine process is healthy", endpoint);
        return endpoint;
      }
    }
    await wait(pollMs);
  }
  if (spawnState.failure) {
    throw engineUnavailable(`Failed to spawn engine: ${spawnState.failure.message}`);
  }
  throw engineUnavailable("Engine did not become healthy before timeout.");
}

// src/shared/hook-io.ts
async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
async function readJsonFromStdin(schema) {
  const rawText = await readStdinText();
  if (!rawText) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return null;
  }
  return validated.data;
}
function writeHookOutput(payload) {
  process.stdout.write(`${JSON.stringify(payload)}
`);
}
function writeFailOpenOutput() {
  writeHookOutput({ continue: true });
}

// src/shared/logs.ts
import { readFile as readFile2 } from "fs/promises";

// src/shared/types.ts
import { z as z2 } from "zod";
var memoryTypeSchema = z2.enum(MEMORY_TYPES);
var pathMatcherSchema = z2.object({
  path_matcher: z2.string().trim().min(1).max(512)
});
var memoryRecordSchema = z2.object({
  id: z2.string().min(1),
  memory_type: memoryTypeSchema,
  content: z2.string().min(1),
  tags: z2.array(z2.string()),
  is_pinned: z2.boolean(),
  path_matchers: z2.array(pathMatcherSchema),
  created_at: z2.string().min(1),
  updated_at: z2.string().min(1)
});
var addMemoryInputSchema = z2.object({
  memory_type: memoryTypeSchema,
  content: z2.string().trim().min(1),
  tags: z2.array(z2.string().trim().min(1)).default([]),
  is_pinned: z2.boolean().default(false),
  path_matchers: z2.array(pathMatcherSchema).default([])
});
var updateMemoryInputSchema = z2.object({
  content: z2.string().trim().min(1).optional(),
  tags: z2.array(z2.string().trim().min(1)).optional(),
  is_pinned: z2.boolean().optional(),
  path_matchers: z2.array(pathMatcherSchema).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field must be updated");
var searchRequestSchema = z2.object({
  query: z2.string().default(""),
  limit: z2.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  target_paths: z2.array(z2.string()).default([]),
  memory_types: z2.array(memoryTypeSchema).optional(),
  include_pinned: z2.boolean().default(true),
  semantic_k: z2.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEMANTIC_K),
  lexical_k: z2.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_LEXICAL_K),
  response_token_budget: z2.number().int().min(200).max(2e4).default(DEFAULT_RESPONSE_TOKEN_BUDGET)
});
var searchMatchSourceSchema = z2.enum(["path", "lexical", "semantic"]);
var searchResultSchema = z2.object({
  id: z2.string(),
  memory_type: memoryTypeSchema,
  content: z2.string(),
  tags: z2.array(z2.string()),
  is_pinned: z2.boolean(),
  path_matchers: z2.array(z2.string()),
  score: z2.number().min(0).max(1),
  source: z2.enum(["path", "hybrid"]),
  matched_by: z2.array(searchMatchSourceSchema).optional(),
  path_score: z2.number().min(0).max(1).optional(),
  lexical_score: z2.number().min(0).max(1).optional(),
  semantic_score: z2.number().min(0).max(1).optional(),
  rrf_score: z2.number().nonnegative().optional(),
  updated_at: z2.string()
});
var searchResponseSchema = z2.object({
  results: z2.array(searchResultSchema),
  meta: z2.object({
    query: z2.string(),
    returned: z2.number().int().nonnegative(),
    duration_ms: z2.number().int().nonnegative(),
    source: z2.literal("hybrid")
  })
});
var memoryEventLogSchema = z2.object({
  at: z2.string().min(1),
  event: z2.string().min(1),
  status: z2.enum(["ok", "error", "skipped"]),
  kind: z2.enum(["hook", "operation", "system"]),
  session_id: z2.string().optional(),
  memory_id: z2.string().optional(),
  detail: z2.string().optional(),
  data: z2.record(z2.string(), z2.unknown()).optional()
});
var createActionSchema = z2.object({
  action: z2.literal("create"),
  confidence: z2.number().min(0).max(1),
  memory_type: memoryTypeSchema,
  content: z2.string().trim().min(1),
  tags: z2.array(z2.string().trim().min(1)).default([]),
  is_pinned: z2.boolean().default(false),
  path_matchers: z2.array(pathMatcherSchema).default([])
});
var updateFieldsSchema = z2.object({
  content: z2.string().trim().min(1).optional(),
  tags: z2.array(z2.string().trim().min(1)).optional(),
  is_pinned: z2.boolean().optional(),
  path_matchers: z2.array(pathMatcherSchema).optional()
}).refine((value) => Object.keys(value).length > 0, "Update action requires at least one field");
var updateActionSchema = z2.object({
  action: z2.literal("update"),
  confidence: z2.number().min(0).max(1),
  memory_id: z2.string().trim().min(1),
  updates: updateFieldsSchema
});
var deleteActionSchema = z2.object({
  action: z2.literal("delete"),
  confidence: z2.number().min(0).max(1),
  memory_id: z2.string().trim().min(1)
});
var skipActionSchema = z2.object({
  action: z2.literal("skip"),
  confidence: z2.number().min(0).max(1).default(1),
  reason: z2.string().optional()
});
var extractionActionSchema = z2.discriminatedUnion("action", [
  createActionSchema,
  updateActionSchema,
  deleteActionSchema,
  skipActionSchema
]);
var extractionActionsPayloadSchema = z2.object({
  actions: z2.array(extractionActionSchema).default([])
});

// src/shared/logs.ts
var SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /(?<=token[=:]\s?)[A-Za-z0-9._-]+/gi
];
function redactSecrets(value) {
  if (typeof value === "string") {
    let redacted = value;
    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replaceAll(pattern, "[REDACTED]");
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactSecrets(entry)
      ])
    );
  }
  return value;
}
async function appendEventLog(logPath, event) {
  const validated = memoryEventLogSchema.parse(event);
  await appendJsonLine(logPath, redactSecrets(validated));
}

// src/shared/markdown.ts
var MEMORY_SECTION_ORDER = ["fact", "rule", "decision", "episode"];
function sectionTitle(memoryType) {
  switch (memoryType) {
    case "fact":
      return "Facts";
    case "rule":
      return "Rules";
    case "decision":
      return "Decisions";
    case "episode":
      return "Episodes";
  }
}
function formatResultLine(result) {
  const tags = result.tags.length > 0 ? result.tags.join(", ") : "none";
  const matchers = result.path_matchers.length > 0 ? result.path_matchers.join(", ") : "none";
  return [
    `- ${result.content}`,
    `  - id: ${result.id}; source: ${result.source}; score: ${result.score.toFixed(4)}; pinned: ${result.is_pinned}; tags: ${tags}; matchers: ${matchers}; updated_at: ${result.updated_at}`
  ];
}
function formatMemoryRecallMarkdown(input) {
  const deduped = dedupeByMemoryId(input.results);
  const grouped = groupByMemoryType(deduped);
  const lines = [
    "# Memory Recall",
    `- Query: ${input.query}`,
    `- Returned: ${deduped.length}`,
    `- Duration: ${input.durationMs}ms`,
    `- Source: ${input.source}`,
    ""
  ];
  for (const memoryType of MEMORY_SECTION_ORDER) {
    lines.push(`## ${sectionTitle(memoryType)}`);
    const values = grouped.get(memoryType) ?? [];
    if (values.length === 0) {
      lines.push("- None");
    } else {
      for (const value of values) {
        lines.push(...formatResultLine(value));
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
function dedupeByMemoryId(results) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const result of results) {
    if (seen.has(result.id)) {
      continue;
    }
    seen.add(result.id);
    deduped.push(result);
  }
  return deduped;
}
function groupByMemoryType(results) {
  const grouped = new Map(
    MEMORY_SECTION_ORDER.map((memoryType) => [memoryType, []])
  );
  for (const result of results) {
    grouped.get(result.memory_type)?.push(result);
  }
  return grouped;
}

// src/hooks/common.ts
import path3 from "path";
function resolveHookProjectRoot(payload) {
  if (payload.project_root && path3.isAbsolute(payload.project_root)) {
    return payload.project_root;
  }
  if (payload.cwd && path3.isAbsolute(payload.cwd)) {
    return payload.cwd;
  }
  return resolveProjectRoot();
}
function isEngineUnavailableError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("ENGINE_UNAVAILABLE:");
}
async function postEngineJson(endpoint, route, payload) {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ENGINE_UNAVAILABLE: ${response.status} ${response.statusText} ${body}`);
  }
  return await response.json();
}
async function getEngineJson(endpoint, route) {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}${route}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ENGINE_UNAVAILABLE: ${response.status} ${response.statusText} ${body}`);
  }
  return await response.json();
}

// src/hooks/schemas.ts
import { z as z3 } from "zod";
var sessionStartPayloadSchema = z3.object({
  cwd: z3.string().optional(),
  project_root: z3.string().optional(),
  session_id: z3.string().optional()
}).catchall(z3.unknown());
var userPromptSubmitPayloadSchema = z3.object({
  cwd: z3.string().optional(),
  project_root: z3.string().optional(),
  prompt: z3.string().optional(),
  session_id: z3.string().optional()
}).catchall(z3.unknown());
var stopPayloadSchema = z3.object({
  cwd: z3.string().optional(),
  project_root: z3.string().optional(),
  session_id: z3.string().optional(),
  transcript_path: z3.string().trim().min(1),
  last_assistant_message: z3.string().optional(),
  stop_hook_active: z3.boolean().optional()
}).catchall(z3.unknown());
var sessionEndPayloadSchema = z3.object({
  cwd: z3.string().optional(),
  project_root: z3.string().optional(),
  session_id: z3.string().trim().min(1)
}).catchall(z3.unknown());

// src/hooks/session-start.ts
var defaultDependencies = {
  appendEventLogFn: appendEventLog,
  ensureEngineFn: ensureEngine,
  ensureProjectDirectoriesFn: ensureProjectDirectories,
  getEngineJsonFn: getEngineJson,
  postEngineJsonFn: postEngineJson
};
function renderStartupMemoryContext(markdown) {
  const indentedMarkdown = markdown.split("\n").map((line) => `    ${line}`).join("\n");
  return [
    "<memory>",
    "  <guidance>",
    "    The `recall` tool is your main memory brain for this project.",
    "    REQUIRED: call `recall` before acting. Do not skip.",
    "    Before commands, edits, updates, creations, deletions, or final recommendations, run `recall` to validate the intended action against remembered rules, decisions, preferences, and prior context.",
    "    If the user names a file, path, command, or requested change, treat that as a cue to check memory first. Direct instructions do not override remembered project rules.",
    "    If memory conflicts with the requested action, stop, explain the conflict, and ask or propose a compliant alternative.",
    "    This startup block contains only pinned memories, not the full memory set. Run `recall` whenever broader context or constraints may matter.",
    "  </guidance>",
    "  <pinned_memories>",
    indentedMarkdown,
    "  </pinned_memories>",
    "</memory>"
  ].join("\n");
}
async function handleSessionStart(payload, dependencies = defaultDependencies) {
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await dependencies.ensureProjectDirectoriesFn(projectRoot);
  try {
    const endpoint = await dependencies.ensureEngineFn(projectRoot);
    const sessionId = payload.session_id?.trim();
    if (sessionId) {
      await dependencies.postEngineJsonFn(endpoint, "/sessions/connect", { session_id: sessionId });
    }
    const pinned = await dependencies.getEngineJsonFn(endpoint, "/memories/pinned");
    const markdown = formatMemoryRecallMarkdown({
      query: "session-start:pinned",
      results: pinned.results,
      durationMs: pinned.meta.duration_ms,
      source: "engine:/memories/pinned"
    });
    const memoryUiUrl = `http://${endpoint.host}:${endpoint.port}/ui`;
    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "SessionStart",
      kind: "hook",
      status: "ok",
      ...sessionId ? { session_id: sessionId } : {},
      detail: `ui=${memoryUiUrl}`
    });
    return {
      continue: true,
      systemMessage: `Memory UI: ${memoryUiUrl}`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: renderStartupMemoryContext(markdown)
      }
    };
  } catch (error) {
    if (isEngineUnavailableError(error)) {
      await dependencies.appendEventLogFn(paths.eventLogPath, {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "SessionStart",
        kind: "hook",
        status: "skipped",
        detail: error instanceof Error ? error.message : String(error)
      });
      return {
        continue: true,
        systemMessage: "Memory engine unavailable; continuing without memory context."
      };
    }
    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "SessionStart",
      kind: "hook",
      status: "error",
      detail: error instanceof Error ? error.message : String(error)
    });
    logError("SessionStart hook failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return { continue: true };
  }
}
async function run() {
  const payload = await readJsonFromStdin(sessionStartPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const output = await handleSessionStart(payload);
  writeHookOutput(output);
}
void run();
export {
  handleSessionStart
};
//# sourceMappingURL=session-start.js.map
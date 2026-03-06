// src/hooks/stop.ts
import { spawn } from "child_process";
import { access } from "fs/promises";

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
function logError(message, data) {
  writeLog("error", message, data);
}

// src/shared/logs.ts
import { readFile as readFile2 } from "fs/promises";

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
function isErrnoException(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

// src/shared/types.ts
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

// src/shared/types.ts
var memoryTypeSchema = z.enum(MEMORY_TYPES);
var pathMatcherSchema = z.object({
  path_matcher: z.string().trim().min(1).max(512)
});
var memoryRecordSchema = z.object({
  id: z.string().min(1),
  memory_type: memoryTypeSchema,
  content: z.string().min(1),
  tags: z.array(z.string()),
  is_pinned: z.boolean(),
  path_matchers: z.array(pathMatcherSchema),
  created_at: z.string().min(1),
  updated_at: z.string().min(1)
});
var addMemoryInputSchema = z.object({
  memory_type: memoryTypeSchema,
  content: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).default([]),
  is_pinned: z.boolean().default(false),
  path_matchers: z.array(pathMatcherSchema).default([])
});
var updateMemoryInputSchema = z.object({
  content: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  is_pinned: z.boolean().optional(),
  path_matchers: z.array(pathMatcherSchema).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field must be updated");
var searchRequestSchema = z.object({
  query: z.string().default(""),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  target_paths: z.array(z.string()).default([]),
  memory_types: z.array(memoryTypeSchema).optional(),
  include_pinned: z.boolean().default(true),
  semantic_k: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEMANTIC_K),
  lexical_k: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_LEXICAL_K),
  response_token_budget: z.number().int().min(200).max(2e4).default(DEFAULT_RESPONSE_TOKEN_BUDGET)
});
var searchResultSchema = z.object({
  id: z.string(),
  memory_type: memoryTypeSchema,
  content: z.string(),
  tags: z.array(z.string()),
  is_pinned: z.boolean(),
  path_matchers: z.array(z.string()),
  score: z.number(),
  source: z.enum(["path", "hybrid"]),
  updated_at: z.string()
});
var searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  meta: z.object({
    query: z.string(),
    returned: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    source: z.literal("hybrid")
  })
});
var memoryEventLogSchema = z.object({
  at: z.string().min(1),
  event: z.string().min(1),
  status: z.enum(["ok", "error", "skipped"]),
  kind: z.enum(["hook", "operation", "system"]),
  session_id: z.string().optional(),
  memory_id: z.string().optional(),
  detail: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional()
});
var createActionSchema = z.object({
  action: z.literal("create"),
  confidence: z.number().min(0).max(1),
  memory_type: memoryTypeSchema,
  content: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).default([]),
  is_pinned: z.boolean().default(false),
  path_matchers: z.array(pathMatcherSchema).default([])
});
var updateFieldsSchema = z.object({
  content: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  is_pinned: z.boolean().optional(),
  path_matchers: z.array(pathMatcherSchema).optional()
}).refine((value) => Object.keys(value).length > 0, "Update action requires at least one field");
var updateActionSchema = z.object({
  action: z.literal("update"),
  confidence: z.number().min(0).max(1),
  memory_id: z.string().trim().min(1),
  updates: updateFieldsSchema
});
var deleteActionSchema = z.object({
  action: z.literal("delete"),
  confidence: z.number().min(0).max(1),
  memory_id: z.string().trim().min(1)
});
var skipActionSchema = z.object({
  action: z.literal("skip"),
  confidence: z.number().min(0).max(1).default(1),
  reason: z.string().optional()
});
var extractionActionSchema = z.discriminatedUnion("action", [
  createActionSchema,
  updateActionSchema,
  deleteActionSchema,
  skipActionSchema
]);
var extractionActionsPayloadSchema = z.object({
  actions: z.array(extractionActionSchema).default([])
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

// src/hooks/common.ts
import path3 from "path";

// src/shared/lockfile.ts
import { z as z2 } from "zod";
var lockMetadataSchema = z2.object({
  host: z2.string().trim().min(1),
  port: z2.number().int().min(1).max(65535),
  pid: z2.number().int().positive(),
  started_at: z2.string().min(1),
  connected_session_ids: z2.array(z2.string().trim().min(1)).default([])
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

// src/hooks/common.ts
function resolveHookProjectRoot(payload) {
  if (payload.project_root && path3.isAbsolute(payload.project_root)) {
    return payload.project_root;
  }
  if (payload.cwd && path3.isAbsolute(payload.cwd)) {
    return payload.cwd;
  }
  return resolveProjectRoot();
}
async function resolveEndpointFromLock(projectRoot) {
  const paths = getProjectPaths(projectRoot);
  const lock = await readLockMetadata(paths.lockPath);
  if (!lock) {
    throw new Error("ENGINE_UNAVAILABLE: lock metadata not found");
  }
  if (!LOOPBACK_HOST_ALIASES.includes(lock.host)) {
    throw new Error(`ENGINE_UNAVAILABLE: lock host is not loopback (${lock.host})`);
  }
  return {
    host: lock.host,
    port: lock.port,
    lockPath: paths.lockPath
  };
}
function isEngineUnavailableError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("ENGINE_UNAVAILABLE:");
}

// src/hooks/schemas.ts
import { z as z3 } from "zod";
var sessionStartPayloadSchema = z3.object({
  cwd: z3.string().optional(),
  project_root: z3.string().optional(),
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

// src/hooks/stop.ts
function spawnStopWorker(handoff) {
  const pluginRoot = resolvePluginRoot();
  const workerEntrypoint = `${pluginRoot}/dist/extraction/run.js`;
  const handoffPayload = Buffer.from(JSON.stringify(handoff), "utf8").toString("base64");
  const child = spawn(process.execPath, [workerEntrypoint, "--handoff", handoffPayload], {
    detached: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PROJECT_ROOT: handoff.project_root
    },
    stdio: "ignore"
  });
  child.once("error", (error) => {
    logError("Failed to spawn stop extraction worker", {
      error: error.message,
      workerEntrypoint
    });
  });
  child.unref();
}
var defaultDependencies = {
  accessFn: access,
  appendEventLogFn: appendEventLog,
  ensureProjectDirectoriesFn: ensureProjectDirectories,
  resolveEndpointFromLockFn: resolveEndpointFromLock,
  spawnStopWorkerFn: spawnStopWorker
};
async function handleStopHook(payload, dependencies = defaultDependencies) {
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await dependencies.ensureProjectDirectoriesFn(projectRoot);
  if (payload.stop_hook_active === true) {
    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "Stop",
      kind: "hook",
      status: "skipped",
      ...payload.session_id ? { session_id: payload.session_id } : {},
      detail: "stop_hook_active=true"
    });
    return { continue: true };
  }
  try {
    await dependencies.accessFn(payload.transcript_path);
    const endpoint = await dependencies.resolveEndpointFromLockFn(projectRoot);
    dependencies.spawnStopWorkerFn({
      endpoint: {
        host: endpoint.host,
        port: endpoint.port
      },
      project_root: projectRoot,
      transcript_path: payload.transcript_path,
      ...payload.last_assistant_message ? { last_assistant_message: payload.last_assistant_message } : {},
      ...payload.session_id ? { session_id: payload.session_id } : {}
    });
    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "Stop",
      kind: "hook",
      status: "ok",
      ...payload.session_id ? { session_id: payload.session_id } : {},
      detail: `handoff=${payload.transcript_path}`
    });
    return { continue: true };
  } catch (error) {
    if (isEngineUnavailableError(error)) {
      await dependencies.appendEventLogFn(paths.eventLogPath, {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "Stop",
        kind: "hook",
        status: "skipped",
        ...payload.session_id ? { session_id: payload.session_id } : {},
        detail: error instanceof Error ? error.message : String(error)
      });
      return { continue: true };
    }
    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "Stop",
      kind: "hook",
      status: "error",
      ...payload.session_id ? { session_id: payload.session_id } : {},
      detail: error instanceof Error ? error.message : String(error)
    });
    logError("Stop hook failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return { continue: true };
  }
}
async function run() {
  const payload = await readJsonFromStdin(stopPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const output = await handleStopHook(payload);
  writeHookOutput(output);
}
void run();
export {
  handleStopHook
};
//# sourceMappingURL=stop.js.map
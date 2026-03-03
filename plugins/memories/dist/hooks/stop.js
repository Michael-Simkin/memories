import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

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
  const text = await readStdinText();
  if (!text) {
    return null;
  }
  let parsedJson;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}
function writeHookOutput(payload) {
  process.stdout.write(`${JSON.stringify(payload)}
`);
}
function writeFailOpenOutput() {
  writeHookOutput({ continue: true });
}

// src/shared/logger.ts
var ORDER = {
  info: 10,
  warn: 20,
  error: 30
};
var configuredLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();
function shouldWrite(level) {
  if (configuredLevel === "silent") {
    return false;
  }
  if (!(configuredLevel in ORDER)) {
    return true;
  }
  return ORDER[level] >= ORDER[configuredLevel];
}
function write(level, message, data) {
  if (!shouldWrite(level)) {
    return;
  }
  const payload = {
    level,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ...data ? { data } : {}
  };
  process.stderr.write(`${JSON.stringify(payload)}
`);
}
function error(message, data) {
  write("error", message, data);
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
  } catch (error2) {
    if (isErrno(error2) && error2.code === "ENOENT") {
      return null;
    }
    throw error2;
  }
}
async function appendJsonLine(filePath, payload) {
  await appendFile(filePath, `${JSON.stringify(payload)}
`, "utf8");
}
function isErrno(error2) {
  return typeof error2 === "object" && error2 !== null && "code" in error2;
}

// src/shared/logs.ts
var SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /(?<=token[=:]\s?)[A-Za-z0-9._-]+/gi
];
function redactValue(value) {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replaceAll(pattern, "[REDACTED]");
  }
  return redacted;
}
function redactUnknown(value) {
  if (typeof value === "string") {
    return redactValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return Object.fromEntries(entries.map(([key, entry]) => [key, redactUnknown(entry)]));
  }
  return value;
}
async function hookLog(path4, payload) {
  await appendJsonLine(path4, redactUnknown(payload));
}

// src/shared/paths.ts
import { mkdir } from "fs/promises";
import path2 from "path";
import { fileURLToPath } from "url";

// src/shared/constants.ts
var ENGINE_HOST = "127.0.0.1";
var ENGINE_LOCK_FILE = "engine.lock.json";
var MEMORY_DB_FILE = "ai_memory.db";
var OPERATION_LOG_FILE = "ai_memory_operations.log";
var HOOK_LOG_FILE = "ai_memory_hook_events.log";

// src/shared/paths.ts
function resolveProjectRoot(explicitProjectRoot) {
  if (explicitProjectRoot && path2.isAbsolute(explicitProjectRoot)) {
    return explicitProjectRoot;
  }
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envRoot && path2.isAbsolute(envRoot)) {
    return envRoot;
  }
  return process.cwd();
}
function resolvePluginRoot() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot && path2.isAbsolute(pluginRoot)) {
    return pluginRoot;
  }
  const currentFilePath = fileURLToPath(import.meta.url);
  const moduleDir = path2.dirname(currentFilePath);
  return path2.resolve(moduleDir, "..", "..");
}
function getProjectPaths(projectRoot) {
  const memoriesDir = path2.join(projectRoot, ".memories");
  return {
    projectRoot,
    memoriesDir,
    dbPath: path2.join(memoriesDir, MEMORY_DB_FILE),
    hookLogPath: path2.join(memoriesDir, HOOK_LOG_FILE),
    lockPath: path2.join(memoriesDir, ENGINE_LOCK_FILE),
    operationLogPath: path2.join(memoriesDir, OPERATION_LOG_FILE)
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
import { z } from "zod";
var lockMetadataSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  started_at: z.string().min(1),
  connected_session_ids: z.array(z.string()).default([])
});
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
    connected_session_ids: [...new Set(parsed.data.connected_session_ids)]
  };
}
function isLoopback(host) {
  return host === ENGINE_HOST || host === "localhost" || host === "::1";
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
  if (lock.host !== ENGINE_HOST && lock.host !== "localhost" && lock.host !== "::1") {
    throw new Error(`Lock host is not loopback: ${lock.host}`);
  }
  return {
    host: lock.host,
    port: lock.port,
    lockPath: paths.lockPath
  };
}
function isEngineUnavailableError(error2) {
  if (!(error2 instanceof Error)) {
    return false;
  }
  const message = error2.message;
  return message.includes("ENGINE_UNAVAILABLE:") || message.includes("Engine lock metadata not found") || message.includes("Engine failed to become healthy in time");
}
function isInternalClaudeRun() {
  return process.env.CLAUDE_MEMORY_INTERNAL_CLAUDE === "1";
}

// src/hooks/schemas.ts
import { z as z2 } from "zod";
var sessionStartPayloadSchema = z2.object({
  cwd: z2.string().optional(),
  project_root: z2.string().optional(),
  session_id: z2.string().optional()
}).catchall(z2.unknown());
var preToolUsePayloadSchema = z2.object({
  cwd: z2.string().optional(),
  project_root: z2.string().optional(),
  session_id: z2.string().optional(),
  tool_name: z2.string().optional(),
  tool_input: z2.record(z2.string(), z2.unknown()).optional()
}).catchall(z2.unknown());
var stopPayloadSchema = z2.object({
  cwd: z2.string().optional(),
  project_root: z2.string().optional(),
  session_id: z2.string().optional(),
  transcript_path: z2.string(),
  last_assistant_message: z2.string().optional(),
  stop_hook_active: z2.boolean().optional()
}).catchall(z2.unknown());
var sessionEndPayloadSchema = z2.object({
  cwd: z2.string().optional(),
  project_root: z2.string().optional(),
  session_id: z2.string().optional()
}).catchall(z2.unknown());

// src/hooks/stop.ts
function spawnWorker(payload) {
  const pluginRoot = resolvePluginRoot();
  const workerEntrypoint = `${pluginRoot}/dist/extraction/run.js`;
  const handoff = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const child = spawn("node", [workerEntrypoint, "--handoff", handoff], {
    detached: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PROJECT_ROOT: payload.project_root
    },
    stdio: "ignore"
  });
  child.unref();
}
async function run() {
  const payload = await readJsonFromStdin(stopPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const projectRoot = resolveHookProjectRoot(payload);
  const { hookLogPath } = await ensureProjectDirectories(projectRoot);
  if (isInternalClaudeRun()) {
    await hookLog(hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "Stop",
      status: "skipped",
      session_id: payload.session_id,
      detail: "internal Claude run; skipping memory hooks"
    });
    writeHookOutput({ continue: true });
    return;
  }
  try {
    if (payload.stop_hook_active) {
      await hookLog(hookLogPath, {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "Stop",
        status: "skipped",
        session_id: payload.session_id,
        detail: "stop_hook_active=true"
      });
      writeHookOutput({ continue: true });
      return;
    }
    await access(payload.transcript_path);
    const endpoint = await resolveEndpointFromLock(projectRoot);
    const workerPayload = {
      endpoint: { host: endpoint.host, port: endpoint.port },
      project_root: projectRoot,
      transcript_path: payload.transcript_path,
      ...payload.last_assistant_message ? { last_assistant_message: payload.last_assistant_message } : {},
      ...payload.session_id ? { session_id: payload.session_id } : {}
    };
    spawnWorker(workerPayload);
    await hookLog(hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "Stop",
      status: "ok",
      session_id: payload.session_id,
      data: { transcript_path: payload.transcript_path }
    });
    writeHookOutput({ continue: true });
  } catch (runError) {
    if (isEngineUnavailableError(runError)) {
      await hookLog(hookLogPath, {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "Stop",
        status: "skipped",
        session_id: payload.session_id,
        detail: "engine not running; skipping extraction handoff"
      });
      writeHookOutput({ continue: true });
      return;
    }
    await hookLog(hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "Stop",
      status: "error",
      session_id: payload.session_id,
      detail: runError instanceof Error ? runError.message : String(runError)
    });
    error("Stop hook failed", {
      error: runError instanceof Error ? runError.message : String(runError)
    });
    writeFailOpenOutput();
  }
}
void run();
//# sourceMappingURL=stop.js.map
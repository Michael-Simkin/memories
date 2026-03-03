import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

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
async function removeFileIfExists(filePath) {
  try {
    await rm(filePath);
  } catch (error2) {
    if (!isErrno(error2) || error2.code !== "ENOENT") {
      throw error2;
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
function isErrno(error2) {
  return typeof error2 === "object" && error2 !== null && "code" in error2;
}

// src/shared/lockfile.ts
import { z } from "zod";

// src/shared/constants.ts
var ENGINE_HOST = "127.0.0.1";
var ENGINE_LOCK_FILE = "engine.lock.json";
var MEMORY_DB_FILE = "ai_memory.db";
var OPERATION_LOG_FILE = "ai_memory_operations.log";
var HOOK_LOG_FILE = "ai_memory_hook_events.log";

// src/shared/lockfile.ts
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
function info(message, data) {
  write("info", message, data);
}
function warn(message, data) {
  write("warn", message, data);
}
function error(message, data) {
  write("error", message, data);
}

// src/shared/paths.ts
import { mkdir } from "fs/promises";
import path2 from "path";
import { fileURLToPath } from "url";
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

// src/engine/ensure-engine.ts
var ENGINE_UNAVAILABLE_PREFIX = "ENGINE_UNAVAILABLE";
var DEFAULT_HEALTH_TIMEOUT_MS = 1e3;
var DEFAULT_BOOT_TIMEOUT_MS = 45e3;
var DEFAULT_BOOT_POLL_MS = 120;
function parseTimeoutMs(envName, fallback) {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
function engineUnavailable(detail) {
  return new Error(`${ENGINE_UNAVAILABLE_PREFIX}: ${detail}`);
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
  const paths = await ensureProjectDirectories(projectRoot);
  const pluginRoot = resolvePluginRoot();
  const lock = await readLockMetadata(paths.lockPath);
  if (lock && isPidAlive(lock.pid)) {
    const endpoint = { host: lock.host, port: lock.port };
    if (await isEngineHealthy(endpoint)) {
      return endpoint;
    }
  }
  if (lock && !isPidAlive(lock.pid)) {
    await removeFileIfExists(paths.lockPath);
  }
  const engineEntrypoint = `${pluginRoot}/dist/engine/main.js`;
  if (!existsSync(engineEntrypoint)) {
    throw engineUnavailable(`engine entrypoint missing at ${engineEntrypoint}`);
  }
  const child = spawn("node", [engineEntrypoint], {
    detached: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PROJECT_ROOT: projectRoot
    },
    stdio: "ignore"
  });
  child.unref();
  const startedAt = Date.now();
  const maxWaitMs = parseTimeoutMs("MEMORIES_ENGINE_BOOT_TIMEOUT_MS", DEFAULT_BOOT_TIMEOUT_MS);
  const pollMs = parseTimeoutMs("MEMORIES_ENGINE_BOOT_POLL_MS", DEFAULT_BOOT_POLL_MS);
  while (Date.now() - startedAt < maxWaitMs) {
    const next = await readLockMetadata(paths.lockPath);
    if (next && isPidAlive(next.pid)) {
      const endpoint = { host: next.host, port: next.port };
      if (await isEngineHealthy(endpoint)) {
        info("Engine is ready", endpoint);
        return endpoint;
      }
    }
    await wait(pollMs);
  }
  warn("Engine readiness exceeded budget", { maxWaitMs, projectRoot });
  throw engineUnavailable("failed to become healthy in time");
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

// src/shared/logs.ts
import { readFile as readFile2 } from "fs/promises";
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

// src/shared/markdown.ts
var ORDER2 = ["fact", "rule", "decision", "episode"];
function sectionTitle(type) {
  switch (type) {
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
function renderItem(result) {
  const tags = result.tags.length > 0 ? result.tags.join(", ") : "none";
  return [
    `- ${result.content}`,
    `  - id: ${result.id}; score: ${result.score.toFixed(4)}; pinned: ${result.is_pinned}; updated_at: ${result.updated_at}; tags: ${tags}`
  ].join("\n");
}
function formatMemoryRecallMarkdown(input) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = input.results.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
  const grouped = new Map(
    ORDER2.map((type) => [type, []])
  );
  for (const result of deduped) {
    grouped.get(result.memory_type)?.push(result);
  }
  const lines = [
    "# Memory Recall",
    `- Query: ${input.query}`,
    `- Returned: ${deduped.length}`,
    `- Duration: ${input.durationMs}ms`,
    `- Source: ${input.source}`,
    ""
  ];
  for (const type of ORDER2) {
    lines.push(`## ${sectionTitle(type)}`);
    const values = grouped.get(type) ?? [];
    if (values.length === 0) {
      lines.push("- None");
    } else {
      for (const value of values) {
        lines.push(renderItem(value));
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
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
async function postEngineJson(endpoint, route, payload) {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${response.statusText} ${body}`);
  }
  return await response.json();
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

// src/hooks/session-start.ts
async function run() {
  const payload = await readJsonFromStdin(sessionStartPayloadSchema) ?? {};
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await ensureProjectDirectories(projectRoot);
  if (isInternalClaudeRun()) {
    await hookLog(paths.hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "SessionStart",
      status: "skipped",
      detail: "internal Claude run; skipping memory hooks"
    });
    writeHookOutput({ continue: true });
    return;
  }
  try {
    const endpoint = await ensureEngine(projectRoot);
    const sessionId = payload.session_id?.trim();
    if (sessionId) {
      await postEngineJson(endpoint, "/sessions/connect", { session_id: sessionId });
    }
    const pinnedResponse = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/pinned`);
    if (!pinnedResponse.ok) {
      throw new Error(`Pinned memory fetch failed: ${pinnedResponse.status} ${pinnedResponse.statusText}`);
    }
    const pinned = await pinnedResponse.json();
    const markdown = formatMemoryRecallMarkdown({
      query: "session-start:pinned",
      results: pinned.results,
      durationMs: pinned.meta.duration_ms,
      source: "engine:/memories/pinned"
    });
    const memoryUiUrl = `http://${endpoint.host}:${endpoint.port}/ui`;
    await hookLog(paths.hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "SessionStart",
      status: "ok",
      ...sessionId ? { session_id: sessionId } : {},
      data: { endpoint: `${endpoint.host}:${endpoint.port}` }
    });
    writeHookOutput({
      continue: true,
      systemMessage: `Memory UI: ${memoryUiUrl}`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Memory UI: ${memoryUiUrl}

${markdown}`
      }
    });
  } catch (runError) {
    if (isEngineUnavailableError(runError)) {
      await hookLog(paths.hookLogPath, {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "SessionStart",
        status: "skipped",
        detail: "engine not running; skipping memory injection"
      });
      writeHookOutput({ continue: true });
      return;
    }
    await hookLog(paths.hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "SessionStart",
      status: "error",
      detail: runError instanceof Error ? runError.message : String(runError)
    });
    error("SessionStart hook failed", {
      error: runError instanceof Error ? runError.message : String(runError)
    });
    writeFailOpenOutput();
  }
}
void run();
//# sourceMappingURL=session-start.js.map
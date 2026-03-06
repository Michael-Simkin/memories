// src/mcp/search-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z as z3 } from "zod";

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
var DEFAULT_MCP_ENGINE_TIMEOUT_MS = 2500;

// src/shared/lockfile.ts
import { z } from "zod";

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
function isErrnoException(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

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
function logError(message, data) {
  writeLog("error", message, data);
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
var searchResultSchema = z2.object({
  id: z2.string(),
  memory_type: memoryTypeSchema,
  content: z2.string(),
  tags: z2.array(z2.string()),
  is_pinned: z2.boolean(),
  path_matchers: z2.array(z2.string()),
  score: z2.number(),
  source: z2.enum(["path", "hybrid"]),
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

// src/mcp/search-server.ts
var recallInvocationPolicyText = "Use this tool by default before most non-trivial work. Skip only for trivial context-free one-liners. Re-run whenever task scope changes.";
var recallInputFields = {
  query: z3.string().trim().min(1),
  project_root: z3.string().optional(),
  limit: z3.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  target_paths: z3.array(z3.string()).optional(),
  include_pinned: z3.boolean().optional(),
  memory_types: z3.array(z3.enum(["fact", "rule", "decision", "episode"])).optional()
};
var recallInputSchema = z3.object(recallInputFields);
function parseTimeoutMs(rawValue) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MCP_ENGINE_TIMEOUT_MS;
  }
  return parsed;
}
async function runRecall(rawInput) {
  const parsed = recallInputSchema.parse(rawInput);
  const projectRoot = resolveProjectRoot(parsed.project_root);
  const lockPath = getProjectPaths(projectRoot).lockPath;
  const lock = await readLockMetadata(lockPath);
  if (!lock) {
    throw new Error(`ENGINE_NOT_FOUND: lock metadata not found at ${lockPath}`);
  }
  if (!isLoopback(lock.host)) {
    throw new Error(`ENGINE_NOT_LOOPBACK: ${lock.host}`);
  }
  const controller = new AbortController();
  const timeoutMs = parseTimeoutMs(process.env.MEMORIES_MCP_ENGINE_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${lock.host}:${lock.port}/memories/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        query: parsed.query,
        limit: parsed.limit ?? DEFAULT_SEARCH_LIMIT,
        include_pinned: parsed.include_pinned ?? true,
        target_paths: parsed.target_paths ?? [],
        ...parsed.memory_types ? { memory_types: parsed.memory_types } : {}
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${response.status}: ${response.statusText} ${body}`);
    }
    const payload = searchResponseSchema.parse(await response.json());
    return formatMemoryRecallMarkdown({
      query: payload.meta.query,
      results: payload.results,
      durationMs: payload.meta.duration_ms,
      source: payload.meta.source
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ENGINE_CALL_FAILED: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
function createRecallMcpServer() {
  const server = new McpServer({
    name: "memories",
    version: "0.2.10"
  });
  server.registerTool(
    "recall",
    {
      description: "Retrieve relevant project memories and return canonical markdown recall sections. " + recallInvocationPolicyText,
      inputSchema: recallInputFields
    },
    async (rawInput) => {
      const markdown = await runRecall(rawInput);
      return {
        content: [{ type: "text", text: markdown }]
      };
    }
  );
  return server;
}
async function run() {
  const server = createRecallMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
void run().catch((error) => {
  logError("MCP recall server failed to start", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
export {
  createRecallMcpServer,
  recallInputSchema,
  recallInvocationPolicyText,
  runRecall
};
//# sourceMappingURL=search-server.js.map
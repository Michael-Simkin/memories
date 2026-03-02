// src/mcp/search-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z3 from "zod/v4";

// src/shared/constants.ts
var ENGINE_HOST = "127.0.0.1";
var DEFAULT_SEARCH_LIMIT = 10;
var MAX_SEARCH_LIMIT = 50;
var MEMORY_TYPES = ["fact", "rule", "decision", "episode"];
var ENGINE_LOCK_FILE = "engine.lock.json";
var MEMORY_DB_FILE = "ai_memory.db";
var OPERATION_LOG_FILE = "ai_memory_operations.log";
var HOOK_LOG_FILE = "ai_memory_hook_events.log";

// src/shared/lockfile.ts
import { z } from "zod";

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
function isErrno(error2) {
  return typeof error2 === "object" && error2 !== null && "code" in error2;
}

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
function error(message, data) {
  write("error", message, data);
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

// src/shared/paths.ts
import { mkdir } from "fs/promises";
import path2 from "path";
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

// src/shared/types.ts
import { z as z2 } from "zod";
var memoryTypeSchema = z2.enum(MEMORY_TYPES);
var pathMatcherSchema = z2.object({
  path_matcher: z2.string().min(1),
  priority: z2.number().int().min(0).max(1e3).default(100)
});
var memorySchema = z2.object({
  id: z2.string().min(1),
  memory_type: memoryTypeSchema,
  content: z2.string().min(1),
  tags: z2.array(z2.string()),
  is_pinned: z2.boolean(),
  path_matchers: z2.array(pathMatcherSchema),
  created_at: z2.string().min(1),
  updated_at: z2.string().min(1)
});
var searchRequestSchema = z2.object({
  query: z2.string().default(""),
  limit: z2.number().int().min(1).max(50).default(10),
  memory_types: z2.array(memoryTypeSchema).optional(),
  include_pinned: z2.boolean().default(true)
});
var searchResultSchema = z2.object({
  id: z2.string(),
  memory_type: memoryTypeSchema,
  content: z2.string(),
  tags: z2.array(z2.string()),
  score: z2.number(),
  is_pinned: z2.boolean(),
  updated_at: z2.string()
});
var searchResponseSchema = z2.object({
  results: z2.array(searchResultSchema),
  meta: z2.object({
    query: z2.string(),
    returned: z2.number().int(),
    duration_ms: z2.number().int().nonnegative(),
    source: z2.string()
  })
});
var addMemorySchema = z2.object({
  memory_type: memoryTypeSchema,
  content: z2.string().min(1),
  tags: z2.array(z2.string()).default([]),
  is_pinned: z2.boolean().default(false),
  path_matchers: z2.array(pathMatcherSchema).default([])
});
var updateMemorySchema = z2.object({
  content: z2.string().min(1).optional(),
  tags: z2.array(z2.string()).optional(),
  is_pinned: z2.boolean().optional(),
  path_matchers: z2.array(pathMatcherSchema).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field must be updated");
var retrievalPretoolSchema = z2.object({
  query: z2.string().default(""),
  target_paths: z2.array(z2.string()).default([]),
  max_tokens: z2.number().int().min(100).max(2e4).default(6e3)
});
var hookEventLogSchema = z2.object({
  at: z2.string(),
  event: z2.string(),
  status: z2.enum(["ok", "error", "skipped"]),
  session_id: z2.string().optional(),
  detail: z2.string().optional(),
  data: z2.record(z2.string(), z2.unknown()).optional()
});
var operationLogSchema = z2.object({
  at: z2.string(),
  op: z2.string(),
  status: z2.enum(["ok", "error", "skipped"]),
  memory_id: z2.string().optional(),
  detail: z2.string().optional(),
  data: z2.record(z2.string(), z2.unknown()).optional()
});

// src/mcp/search-server.ts
var toolInputFields = {
  query: z3.string().min(1),
  project_root: z3.string().optional(),
  limit: z3.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  memory_types: z3.array(z3.enum(["fact", "rule", "decision", "episode"])).optional(),
  include_pinned: z3.boolean().optional()
};
var toolInputSchema = z3.object(toolInputFields);
async function run() {
  const server = new McpServer({
    name: "memories",
    version: "0.1.0"
  });
  server.registerTool(
    "recall",
    {
      description: "Search memory engine and return markdown recall output.",
      inputSchema: toolInputFields
    },
    async (rawInput) => {
      const parsed = toolInputSchema.parse(rawInput);
      const input = {
        query: parsed.query,
        project_root: parsed.project_root,
        limit: parsed.limit ?? DEFAULT_SEARCH_LIMIT,
        include_pinned: parsed.include_pinned ?? true,
        memory_types: parsed.memory_types
      };
      const projectRoot = resolveProjectRoot(input.project_root);
      const lockPath = getProjectPaths(projectRoot).lockPath;
      const lock = await readLockMetadata(lockPath);
      if (!lock) {
        throw new Error(`ENGINE_NOT_FOUND: lock file not found at ${lockPath}`);
      }
      if (!isLoopback(lock.host)) {
        throw new Error(`INVALID_LOCK_HOST: ${lock.host}`);
      }
      const timeoutMs = Number.parseInt(process.env.MEMORIES_MCP_ENGINE_TIMEOUT_MS ?? "2500", 10);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Number.isFinite(timeoutMs) ? timeoutMs : 2500
      );
      try {
        const response = await fetch(`http://${lock.host}:${lock.port}/memories/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            include_pinned: input.include_pinned,
            limit: input.limit,
            query: input.query,
            ...input.memory_types ? { memory_types: input.memory_types } : {}
          })
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`${response.status}: ${response.statusText} ${body}`);
        }
        const payload = searchResponseSchema.parse(await response.json());
        const markdown = formatMemoryRecallMarkdown({
          query: payload.meta.query,
          results: payload.results,
          durationMs: payload.meta.duration_ms,
          source: payload.meta.source
        });
        return {
          content: [{ type: "text", text: markdown }]
        };
      } catch (callError) {
        const message = callError instanceof Error ? callError.message : String(callError);
        throw new Error(`ENGINE_CALL_FAILED: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
void run().catch((runError) => {
  error("MCP server startup failed", {
    error: runError instanceof Error ? runError.message : String(runError)
  });
  process.exit(1);
});
//# sourceMappingURL=search-server.js.map
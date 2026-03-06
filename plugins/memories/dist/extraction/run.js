// src/extraction/run.ts
import { spawn } from "child_process";
import { createHash } from "crypto";
import { readFile as readFile3 } from "fs/promises";
import path3 from "path";
import { ZodError } from "zod";

// src/shared/fs-utils.ts
import { appendFile, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
async function appendJsonLine(filePath, payload) {
  await appendFile(filePath, `${JSON.stringify(payload)}
`, "utf8");
}
function normalizePathForMatch(inputPath) {
  const posixPath = inputPath.replaceAll("\\", "/").trim();
  if (!posixPath) {
    return "";
  }
  const normalized = path.posix.normalize(posixPath);
  if (normalized === ".") {
    return "";
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
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

// src/shared/types.ts
import { z } from "zod";

// src/shared/constants.ts
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

// src/extraction/contracts.ts
import { z as z2 } from "zod";
var workerPayloadSchema = z2.object({
  endpoint: z2.object({
    host: z2.string().min(1),
    port: z2.number().int().min(1).max(65535)
  }),
  project_root: z2.string().min(1),
  transcript_path: z2.string().min(1),
  last_assistant_message: z2.string().optional(),
  session_id: z2.string().optional()
});
var updateFieldsSchema2 = z2.object({
  content: z2.string().trim().min(1).optional(),
  tags: z2.array(z2.string().trim().min(1)).optional(),
  is_pinned: z2.boolean().optional(),
  path_matchers: z2.array(pathMatcherSchema).optional()
}).refine((value) => Object.keys(value).length > 0, "Update action must include at least one field");
var createActionSchema2 = z2.object({
  action: z2.literal("create"),
  confidence: z2.number().min(0).max(1),
  reason: z2.string().optional(),
  memory_type: memoryTypeSchema,
  content: z2.string().trim().min(1),
  tags: z2.array(z2.string().trim().min(1)).default([]),
  is_pinned: z2.boolean().default(false),
  path_matchers: z2.array(pathMatcherSchema).default([])
});
var updateActionSchema2 = z2.object({
  action: z2.literal("update"),
  confidence: z2.number().min(0).max(1),
  reason: z2.string().optional(),
  memory_id: z2.string().trim().min(1),
  updates: updateFieldsSchema2
});
var deleteActionSchema2 = z2.object({
  action: z2.literal("delete"),
  confidence: z2.number().min(0).max(1),
  reason: z2.string().optional(),
  memory_id: z2.string().trim().min(1)
});
var skipActionSchema2 = z2.object({
  action: z2.literal("skip"),
  confidence: z2.number().min(0).max(1).default(1),
  reason: z2.string().optional()
});
var workerActionSchema = z2.discriminatedUnion("action", [
  createActionSchema2,
  updateActionSchema2,
  deleteActionSchema2,
  skipActionSchema2
]);
var workerOutputSchema = z2.object({
  actions: z2.array(workerActionSchema)
});

// src/extraction/run.ts
var CONFIDENCE_THRESHOLD = 0.75;
var ExtractionParseError = class extends Error {
  debugInfo;
  constructor(message, debugInfo) {
    super(message);
    this.name = "ExtractionParseError";
    this.debugInfo = debugInfo;
  }
};
var CLAUDE_OUTPUT_PREVIEW_MAX_CHARS = 1600;
var defaultDependencies = {
  appendEventLogFn: appendEventLog,
  applyActionFn: applyAction,
  readTranscriptContextFn: readTranscriptContext,
  runClaudeFn: runClaudePrompt,
  searchCandidatesFn: searchCandidates
};
function summarizeClaudeRunResult(result) {
  return {
    exit_code: result.code,
    stderr_chars: result.stderr.length,
    stderr_line_count: countLines(result.stderr),
    stderr_preview: summarizeTextPreview(result.stderr, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    stderr_tail_preview: summarizeTextTailPreview(result.stderr, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    stderr_sha256: sha256(result.stderr),
    stdout_chars: result.stdout.length,
    stdout_line_count: countLines(result.stdout),
    stdout_preview: summarizeTextPreview(result.stdout, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    stdout_tail_preview: summarizeTextTailPreview(result.stdout, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    stdout_sha256: sha256(result.stdout)
  };
}
function buildErrorDebugData(error) {
  if (error instanceof ExtractionParseError) {
    return {
      error_name: error.name,
      parser_debug: error.debugInfo
    };
  }
  if (error instanceof ZodError) {
    return {
      error_name: error.name,
      validation_issues: error.issues.slice(0, 12).map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.join(".")
      }))
    };
  }
  if (error instanceof Error) {
    return {
      error_name: error.name
    };
  }
  return void 0;
}
function summarizeTextPreview(text, maxChars) {
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}\u2026[truncated ${normalized.length - maxChars} chars]`;
}
function summarizeTextTailPreview(text, maxChars) {
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `\u2026[truncated ${normalized.length - maxChars} chars]${normalized.slice(-maxChars)}`;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function countLines(text) {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}
function buildClaudeProcessEnv(baseEnv) {
  return {
    ...baseEnv,
    CLAUDE_CODE_SIMPLE: "1"
  };
}
function readHandoffArg(argv) {
  const index = argv.indexOf("--handoff");
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}
function decodeWorkerPayload(encodedHandoff) {
  const decoded = Buffer.from(encodedHandoff, "base64").toString("utf8");
  const parsed = JSON.parse(decoded);
  return workerPayloadSchema.parse(parsed);
}
async function executeWorker(payload, dependencies = defaultDependencies) {
  const projectPaths = getProjectPaths(payload.project_root);
  await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
    at: (/* @__PURE__ */ new Date()).toISOString(),
    event: "extraction/start",
    kind: "operation",
    status: "ok",
    ...payload.session_id ? { session_id: payload.session_id } : {}
  });
  try {
    const context = await dependencies.readTranscriptContextFn(
      payload.transcript_path,
      payload.project_root
    );
    const candidateQuery = payload.last_assistant_message?.trim() || context.transcriptSnippet.slice(0, 500);
    const candidates = await dependencies.searchCandidatesFn(
      payload.endpoint,
      candidateQuery,
      context.relatedPaths
    );
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "extraction/context",
      kind: "operation",
      status: "ok",
      ...payload.session_id ? { session_id: payload.session_id } : {},
      data: {
        candidate_query_chars: candidateQuery.length,
        candidate_results: candidates.results.length,
        related_path_count: context.relatedPaths.length,
        transcript_path: payload.transcript_path,
        transcript_snippet_chars: context.transcriptSnippet.length
      }
    });
    const prompt = buildExtractionPrompt({
      transcriptSnippet: context.transcriptSnippet,
      relatedPaths: context.relatedPaths,
      candidateMemories: candidates.results,
      ...payload.last_assistant_message ? { lastAssistantMessage: payload.last_assistant_message } : {}
    });
    const claudeResult = await dependencies.runClaudeFn(prompt, payload.project_root);
    const claudeRunSummary = summarizeClaudeRunResult(claudeResult);
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "extraction/claude-response",
      kind: "operation",
      status: claudeResult.code === 0 ? "ok" : "error",
      ...payload.session_id ? { session_id: payload.session_id } : {},
      ...claudeResult.code === 0 ? {} : { detail: `claude exited with status ${claudeResult.code}` },
      data: claudeRunSummary
    });
    if (claudeResult.code !== 0) {
      throw new Error(`Claude exited with status ${claudeResult.code}: ${claudeResult.stderr}`);
    }
    let output;
    try {
      output = parseWorkerOutput(claudeResult.stdout);
    } catch (error) {
      await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "extraction/parse",
        kind: "operation",
        status: "error",
        ...payload.session_id ? { session_id: payload.session_id } : {},
        detail: error instanceof Error ? error.message : String(error),
        ...buildErrorDebugData(error) ? { data: buildErrorDebugData(error) } : {}
      });
      throw error;
    }
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "extraction/parse",
      kind: "operation",
      status: "ok",
      ...payload.session_id ? { session_id: payload.session_id } : {},
      detail: `parsed ${output.actions.length} actions`,
      data: {
        action_types: output.actions.map((action) => action.action)
      }
    });
    const sanitizedActions = output.actions.map(
      (action) => sanitizeWorkerAction(action, context.relatedPaths)
    );
    let failed = false;
    for (const action of sanitizedActions) {
      if (action.action === "skip" || action.confidence < CONFIDENCE_THRESHOLD) {
        await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
          at: (/* @__PURE__ */ new Date()).toISOString(),
          event: "extraction/skip",
          kind: "operation",
          status: "skipped",
          ...payload.session_id ? { session_id: payload.session_id } : {},
          detail: action.reason ?? "low confidence or skip action",
          data: {
            action: action.action,
            confidence: action.confidence
          }
        });
        continue;
      }
      const outcome = await dependencies.applyActionFn(payload.endpoint, action);
      if (!outcome.ok) {
        failed = true;
        await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
          at: (/* @__PURE__ */ new Date()).toISOString(),
          event: "extraction/apply",
          kind: "operation",
          status: "error",
          ...payload.session_id ? { session_id: payload.session_id } : {},
          ...action.action === "update" || action.action === "delete" ? { memory_id: action.memory_id } : {},
          detail: `${outcome.code}: ${outcome.message}`,
          data: {
            action: action.action,
            confidence: action.confidence
          }
        });
        break;
      }
      await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "extraction/apply",
        kind: "operation",
        status: "ok",
        ...payload.session_id ? { session_id: payload.session_id } : {},
        ...action.action === "update" || action.action === "delete" ? { memory_id: action.memory_id } : {},
        detail: action.reason ?? action.action,
        data: {
          action: action.action,
          confidence: action.confidence
        }
      });
    }
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "extraction/complete",
      kind: "operation",
      status: failed ? "error" : "ok",
      ...payload.session_id ? { session_id: payload.session_id } : {},
      detail: failed ? "stopped after first write failure" : "completed"
    });
  } catch (error) {
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "extraction/error",
      kind: "operation",
      status: "error",
      ...payload.session_id ? { session_id: payload.session_id } : {},
      detail: error instanceof Error ? error.message : String(error),
      ...buildErrorDebugData(error) ? { data: buildErrorDebugData(error) } : {}
    });
    logError("Stop worker failed", {
      error: error instanceof Error ? error.message : String(error),
      ...buildErrorDebugData(error) ? { debug: buildErrorDebugData(error) } : {}
    });
  }
}
async function readTranscriptContext(transcriptPath, projectRoot) {
  const raw = await readFile3(transcriptPath, "utf8");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const recentLines = lines.slice(Math.max(0, lines.length - 300));
  const transcriptSnippet = recentLines.slice(Math.max(0, recentLines.length - 120)).join("\n");
  const relatedPaths = /* @__PURE__ */ new Set();
  for (const line of recentLines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    for (const value of collectPathValues(parsed)) {
      const normalized = normalizeCandidatePath(value, projectRoot);
      if (normalized) {
        relatedPaths.add(normalized);
      }
    }
  }
  return {
    transcriptSnippet,
    relatedPaths: [...relatedPaths].slice(0, 80)
  };
}
function collectPathValues(value) {
  const collected = [];
  const walk = (node, parentKey = "") => {
    if (typeof node === "string") {
      if (parentKey.toLowerCase().includes("path")) {
        collected.push(node);
      }
      for (const token of node.matchAll(/(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g)) {
        const maybePath = token[0];
        if (maybePath) {
          collected.push(maybePath);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, parentKey);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        walk(child, key);
      }
    }
  };
  walk(value);
  return collected;
}
function normalizeCandidatePath(rawPath, projectRoot) {
  const trimmed = rawPath.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return null;
  }
  const withoutLineSuffix = trimmed.replace(/:[0-9]+$/g, "");
  const normalized = normalizePathForMatch(withoutLineSuffix);
  if (!normalized || normalized === "." || normalized === "/") {
    return null;
  }
  if (path3.isAbsolute(normalized)) {
    const relative = path3.relative(projectRoot, normalized).replaceAll("\\", "/");
    if (relative.startsWith("..")) {
      return null;
    }
    return normalizePathForMatch(relative);
  }
  return normalized;
}
function buildExtractionPrompt(input) {
  const candidateMemoriesText = JSON.stringify(
    input.candidateMemories.map((memory) => ({
      id: memory.id,
      memory_type: memory.memory_type,
      content: memory.content,
      tags: memory.tags,
      is_pinned: memory.is_pinned,
      path_matchers: memory.path_matchers
    })),
    null,
    2
  );
  return [
    "Extract durable memory actions from this transcript context.",
    "Return strict JSON only (no prose, no markdown fences) with this exact top-level shape:",
    '{"actions":[...]}',
    "",
    "Allowed action contracts:",
    '- create: {"action":"create","confidence":0..1,"reason":"...","memory_type":"fact|rule|decision|episode","content":"...","tags":[...],"is_pinned":boolean,"path_matchers":[{"path_matcher":"..."}]}',
    '- update: {"action":"update","confidence":0..1,"reason":"...","memory_id":"...","updates":{"content?":"...","tags?":[...],"is_pinned?":boolean,"path_matchers?":[{"path_matcher":"..."}]}}',
    '- delete: {"action":"delete","confidence":0..1,"reason":"...","memory_id":"..."}',
    '- skip: {"action":"skip","confidence":0..1,"reason":"..."}',
    "",
    "Hard requirements:",
    "- Every create action MUST include memory_type.",
    "- memory_type must be exactly one of: fact, rule, decision, episode.",
    "- update/delete must target existing memory ids from candidate memories.",
    "- If required fields are missing or uncertain, emit skip instead of partial create/update/delete.",
    "- Do not invent IDs.",
    "",
    "Safety rules:",
    "- prefer no-op when uncertain",
    "- never include secrets",
    "- create/update may include path_matchers only when file scope is clear",
    "- confidence must be in range [0,1]",
    "",
    "Candidate memories:",
    candidateMemoriesText,
    "",
    "Related paths:",
    input.relatedPaths.length > 0 ? input.relatedPaths.map((value) => `- ${value}`).join("\n") : "- none",
    "",
    "Last assistant message:",
    input.lastAssistantMessage ?? "(none)",
    "",
    "Transcript snippet:",
    input.transcriptSnippet
  ].join("\n");
}
async function runClaudePrompt(prompt, projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--model",
        "claude-opus-4-6"
      ],
      {
        cwd: projectRoot,
        env: buildClaudeProcessEnv(process.env),
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
function parseWorkerOutput(rawStdout) {
  const parsed = parseClaudeJson(rawStdout);
  return workerOutputSchema.parse(parsed);
}
function parseClaudeJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ExtractionParseError("Claude extraction produced empty output", {
      parser_stage: "top-level",
      stdout_chars: raw.length,
      stdout_preview: summarizeTextPreview(raw, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS)
    });
  }
  let outer;
  try {
    outer = JSON.parse(trimmed);
  } catch (error) {
    throw new ExtractionParseError("Claude extraction output was not valid JSON", {
      parser_stage: "top-level",
      stdout_chars: raw.length,
      stdout_preview: summarizeTextPreview(raw, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
      ...error instanceof Error ? { parse_error: error.message } : {}
    });
  }
  if (workerOutputSchema.safeParse(outer).success) {
    return outer;
  }
  if (isActionsObject(outer)) {
    return outer;
  }
  const topLevelKeys = isRecord(outer) ? Object.keys(outer) : [];
  const parseDebugInfo = {
    parser_stage: "payload-extraction",
    stdout_chars: raw.length,
    stdout_preview: summarizeTextPreview(raw, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    ...topLevelKeys.length > 0 ? { top_level_keys: topLevelKeys } : {}
  };
  if (outer && typeof outer === "object") {
    const candidate = outer;
    parseDebugInfo.has_result_string = typeof candidate.result === "string";
    parseDebugInfo.has_result_object = !!candidate.result && typeof candidate.result === "object";
    parseDebugInfo.content_block_count = Array.isArray(candidate.content) ? candidate.content.length : 0;
    parseDebugInfo.content_text_block_count = Array.isArray(candidate.content) ? candidate.content.filter((block) => typeof block?.text === "string").length : 0;
    if (typeof candidate.result === "string") {
      const parsedResult = parseWorkerOutputFromText(candidate.result);
      if (parsedResult) {
        return parsedResult;
      }
    }
    if (Array.isArray(candidate.content)) {
      for (const block of candidate.content) {
        if (typeof block.text !== "string") {
          continue;
        }
        const parsedBlock = parseWorkerOutputFromText(block.text);
        if (parsedBlock) {
          return parsedBlock;
        }
      }
    }
  }
  throw new ExtractionParseError(
    "Claude extraction output did not include a valid actions payload",
    parseDebugInfo
  );
}
function parseWorkerOutputFromText(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const direct = safeJsonParse(trimmed);
  if (direct && isActionsObject(direct)) {
    return direct;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!fenced || !fenced[1]) {
    return null;
  }
  const fromFence = safeJsonParse(fenced[1]);
  if (fromFence && isActionsObject(fromFence)) {
    return fromFence;
  }
  return null;
}
function sanitizeWorkerAction(action, relatedPaths) {
  if (action.action === "create") {
    return {
      ...action,
      path_matchers: sanitizePathMatchers(action.path_matchers, relatedPaths)
    };
  }
  if (action.action === "update" && action.updates.path_matchers) {
    return {
      ...action,
      updates: {
        ...action.updates,
        path_matchers: sanitizePathMatchers(action.updates.path_matchers, relatedPaths)
      }
    };
  }
  return action;
}
function sanitizePathMatchers(matchers, relatedPaths) {
  const disallowed = /* @__PURE__ */ new Set(["*", "**", "**/*", "/", "./"]);
  const byBasename = new Map(
    relatedPaths.map((relatedPath) => [path3.posix.basename(relatedPath), relatedPath])
  );
  const seen = /* @__PURE__ */ new Set();
  const sanitized = [];
  for (const matcher of matchers) {
    const raw = matcher.path_matcher.trim();
    if (!raw) {
      continue;
    }
    const withoutLineSuffix = raw.replace(/:(?:L)?\d+$/i, "");
    let normalized = normalizePathForMatch(withoutLineSuffix);
    if (!normalized || disallowed.has(normalized)) {
      continue;
    }
    if (!normalized.includes("/") && byBasename.has(normalized)) {
      normalized = byBasename.get(normalized) ?? normalized;
    }
    if (disallowed.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    sanitized.push({ path_matcher: normalized });
    if (sanitized.length >= 12) {
      break;
    }
  }
  return sanitized;
}
async function searchCandidates(endpoint, query, relatedPaths) {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      limit: 20,
      include_pinned: true,
      target_paths: relatedPaths.slice(0, 20)
    })
  });
  if (!response.ok) {
    throw new Error(`Candidate lookup failed: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}
async function applyAction(endpoint, action) {
  if (action.action === "skip") {
    return { ok: true };
  }
  if (action.action === "create") {
    const response2 = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        memory_type: action.memory_type,
        content: action.content,
        tags: action.tags,
        is_pinned: action.is_pinned,
        path_matchers: action.path_matchers
      })
    });
    return toActionApplyOutcome(response2);
  }
  if (action.action === "update") {
    const response2 = await fetch(
      `http://${endpoint.host}:${endpoint.port}/memories/${action.memory_id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action.updates)
      }
    );
    return toActionApplyOutcome(response2);
  }
  const response = await fetch(
    `http://${endpoint.host}:${endpoint.port}/memories/${action.memory_id}`,
    {
      method: "DELETE"
    }
  );
  return toActionApplyOutcome(response);
}
async function toActionApplyOutcome(response) {
  if (response.ok) {
    return { ok: true };
  }
  try {
    const body = await response.json();
    return {
      ok: false,
      code: body.error?.code ?? `HTTP_${response.status}`,
      message: body.error?.message ?? response.statusText
    };
  } catch {
    return {
      ok: false,
      code: `HTTP_${response.status}`,
      message: response.statusText
    };
  }
}
function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isActionsObject(value) {
  return isRecord(value) && Array.isArray(value.actions);
}
async function runFromCli() {
  const encodedHandoff = readHandoffArg(process.argv);
  if (!encodedHandoff) {
    return;
  }
  const payload = decodeWorkerPayload(encodedHandoff);
  await executeWorker(payload);
}
void runFromCli();
export {
  CONFIDENCE_THRESHOLD,
  buildClaudeProcessEnv,
  decodeWorkerPayload,
  executeWorker,
  readHandoffArg,
  readTranscriptContext
};
//# sourceMappingURL=run.js.map
// src/extraction/run.ts
import { spawn } from "child_process";
import { readFile as readFile3 } from "fs/promises";

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
async function appendJsonLine(filePath, payload) {
  await appendFile(filePath, `${JSON.stringify(payload)}
`, "utf8");
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
async function hookLog(path3, payload) {
  await appendJsonLine(path3, redactUnknown(payload));
}
async function appendOperationLog(path3, payload) {
  await appendJsonLine(path3, redactUnknown(payload));
}

// src/shared/paths.ts
import { mkdir } from "fs/promises";
import path2 from "path";

// src/shared/constants.ts
var MEMORY_TYPES = ["fact", "rule", "decision", "episode"];
var ENGINE_LOCK_FILE = "engine.lock.json";
var MEMORY_DB_FILE = "ai_memory.db";
var OPERATION_LOG_FILE = "ai_memory_operations.log";
var HOOK_LOG_FILE = "ai_memory_hook_events.log";

// src/shared/paths.ts
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

// src/extraction/contracts.ts
import { z as z2 } from "zod";

// src/shared/types.ts
import { z } from "zod";
var memoryTypeSchema = z.enum(MEMORY_TYPES);
var pathMatcherSchema = z.object({
  path_matcher: z.string().min(1),
  priority: z.number().int().min(0).max(1e3).default(100)
});
var memorySchema = z.object({
  id: z.string().min(1),
  memory_type: memoryTypeSchema,
  content: z.string().min(1),
  tags: z.array(z.string()),
  is_pinned: z.boolean(),
  path_matchers: z.array(pathMatcherSchema),
  created_at: z.string().min(1),
  updated_at: z.string().min(1)
});
var searchRequestSchema = z.object({
  query: z.string().default(""),
  limit: z.number().int().min(1).max(50).default(10),
  memory_types: z.array(memoryTypeSchema).optional(),
  include_pinned: z.boolean().default(true)
});
var searchResultSchema = z.object({
  id: z.string(),
  memory_type: memoryTypeSchema,
  content: z.string(),
  tags: z.array(z.string()),
  score: z.number(),
  is_pinned: z.boolean(),
  updated_at: z.string()
});
var searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  meta: z.object({
    query: z.string(),
    returned: z.number().int(),
    duration_ms: z.number().int().nonnegative(),
    source: z.string()
  })
});
var addMemorySchema = z.object({
  memory_type: memoryTypeSchema,
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  is_pinned: z.boolean().default(false),
  path_matchers: z.array(pathMatcherSchema).default([])
});
var updateMemorySchema = z.object({
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  is_pinned: z.boolean().optional(),
  path_matchers: z.array(pathMatcherSchema).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field must be updated");
var retrievalPretoolSchema = z.object({
  query: z.string().default(""),
  target_paths: z.array(z.string()).default([]),
  max_tokens: z.number().int().min(100).max(2e4).default(6e3)
});
var hookEventLogSchema = z.object({
  at: z.string(),
  event: z.string(),
  status: z.enum(["ok", "error", "skipped"]),
  session_id: z.string().optional(),
  detail: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional()
});
var operationLogSchema = z.object({
  at: z.string(),
  op: z.string(),
  status: z.enum(["ok", "error", "skipped"]),
  memory_id: z.string().optional(),
  detail: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional()
});

// src/extraction/contracts.ts
var memoryActionSchema = z2.object({
  action: z2.enum(["create", "update", "delete", "skip"]),
  memory_type: memoryTypeSchema,
  id: z2.string().optional(),
  content: z2.string().optional(),
  tags: z2.array(z2.string()).default([]),
  is_pinned: z2.boolean().default(false),
  path_matchers: z2.array(pathMatcherSchema).default([]),
  confidence: z2.number().min(0).max(1),
  reason: z2.string().min(1),
  evidence: z2.array(z2.string()).default([])
}).superRefine((value, context) => {
  if (value.action === "create" && value.id) {
    context.addIssue({
      code: z2.ZodIssueCode.custom,
      message: "create action must not include id"
    });
  }
  if ((value.action === "update" || value.action === "delete") && !value.id) {
    context.addIssue({
      code: z2.ZodIssueCode.custom,
      message: `${value.action} action requires id`
    });
  }
  if ((value.action === "create" || value.action === "update") && !value.content) {
    context.addIssue({
      code: z2.ZodIssueCode.custom,
      message: `${value.action} action requires content`
    });
  }
});
var extractionOutputSchema = z2.object({
  actions: z2.array(memoryActionSchema)
});
var workerPayloadSchema = z2.object({
  endpoint: z2.object({
    host: z2.string(),
    port: z2.number().int().min(1).max(65535)
  }),
  project_root: z2.string().min(1),
  transcript_path: z2.string().min(1),
  last_assistant_message: z2.string().optional(),
  session_id: z2.string().optional()
});

// src/extraction/run.ts
var CONFIDENCE_THRESHOLD = 0.75;
function readHandoffArg(argv) {
  const index = argv.indexOf("--handoff");
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}
async function readTranscriptSnippet(transcriptPath) {
  const raw = await readFile3(transcriptPath, "utf8");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - 80));
  return tail.join("\n");
}
function buildExtractionPrompt(input) {
  const candidateText = input.candidateMemories.length === 0 ? "[]" : JSON.stringify(
    input.candidateMemories.map((memory) => ({
      id: memory.id,
      memory_type: memory.memory_type,
      content: memory.content,
      tags: memory.tags,
      is_pinned: memory.is_pinned
    })),
    null,
    2
  );
  return [
    "SYSTEM",
    "You are the memory curator for a local Claude Code memory engine.",
    "Extract only durable, high-signal memories from the provided session context.",
    "Never invent facts. Never include secrets, tokens, passwords, private keys, or credentials.",
    "Prefer precision over recall. If uncertain, output `skip`.",
    "",
    "TASK",
    "Return all high-confidence memory actions as strict JSON (no markdown, no prose).",
    "",
    "MEMORY TYPES",
    "- fact: stable project/domain truth",
    "- rule: recurring instruction/preference/constraint",
    "- decision: chosen approach with rationale/tradeoff",
    "- episode: notable one-off event worth later reference",
    "",
    "ACTION RULES",
    "- create: new durable memory not already present",
    "- update: existing memory is same concept but content/tags/pin/matchers must change",
    "- delete: existing memory explicitly invalidated/superseded",
    "- skip: no durable action",
    "",
    "PINNING RULES",
    "- Set `is_pinned=true` only for durable context that should be injected every SessionStart",
    "  (e.g., stable user preferences, hard project rules, long-lived architecture decisions).",
    "- Keep `is_pinned=false` for transient implementation notes, one-off episodes, and short-lived decisions.",
    "- If uncertain whether something should be pinned, prefer `is_pinned=false`.",
    "",
    "OUTPUT JSON SCHEMA",
    "{",
    '  "actions": [',
    "    {",
    '      "action": "create|update|delete|skip",',
    '      "memory_type": "fact|rule|decision|episode",',
    '      "id": "required for update/delete; forbidden for create",',
    '      "content": "required for create/update",',
    '      "tags": ["string"],',
    '      "is_pinned": false,',
    '      "path_matchers": [',
    '        { "path_matcher": "glob-like string", "priority": 100 }',
    "      ],",
    '      "confidence": 0.0,',
    '      "reason": "short justification",',
    '      "evidence": ["direct quote or concise reference from the session"]',
    "    }",
    "  ]",
    "}",
    "",
    "HARD CONSTRAINTS",
    "- Output must be a valid JSON object with key `actions` only.",
    "- `confidence` must be in [0,1].",
    "- Emit only high-confidence actions (default threshold: `confidence >= 0.75`).",
    "- Do not emit duplicate actions for the same semantic memory.",
    "- For `delete`, include `id`, `reason`, and evidence of explicit invalidation.",
    "",
    "EXISTING MEMORY CANDIDATES",
    candidateText,
    "",
    "LAST ASSISTANT MESSAGE",
    input.lastAssistantMessage ?? "",
    "",
    "TRANSCRIPT SNIPPET",
    input.transcriptSnippet
  ].join("\n");
}
async function runClaudePrompt(prompt) {
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
    child.on("error", (spawnError) => reject(spawnError));
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stderr,
        stdout
      });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
function parseCliJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Claude extraction produced empty output");
  }
  const outer = JSON.parse(trimmed);
  if (extractionOutputSchema.safeParse(outer).success) {
    return outer;
  }
  if (isObject(outer)) {
    const result = outer.result;
    if (typeof result === "string") {
      const fromResultString = tryParseExtractionPayload(result);
      if (fromResultString) {
        return fromResultString;
      }
    }
    if (isObject(result) && extractionOutputSchema.safeParse(result).success) {
      return result;
    }
    const content = outer.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObject(block)) {
          continue;
        }
        if (typeof block.text !== "string") {
          continue;
        }
        const fromText = tryParseExtractionPayload(block.text);
        if (fromText) {
          return fromText;
        }
      }
    }
  }
  throw new Error(
    `Claude extraction output did not include an actions payload. Top-level keys: ${listTopLevelKeys(outer)}`
  );
}
function tryParseExtractionPayload(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const direct = safeJsonParse(trimmed);
  if (direct && extractionOutputSchema.safeParse(direct).success) {
    return direct;
  }
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch) {
    const fencedJson = safeJsonParse(fencedMatch[1] ?? "");
    if (fencedJson && extractionOutputSchema.safeParse(fencedJson).success) {
      return fencedJson;
    }
  }
  return null;
}
function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function listTopLevelKeys(value) {
  if (!isObject(value)) {
    return "(non-object JSON output)";
  }
  const keys = Object.keys(value);
  return keys.length > 0 ? keys.join(", ") : "(none)";
}
async function searchCandidates(endpoint, query) {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      include_pinned: true,
      limit: 20,
      query
    })
  });
  if (!response.ok) {
    throw new Error(`Candidate lookup failed: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}
async function applyAction(endpoint, action) {
  if (action.action === "skip" || action.confidence < CONFIDENCE_THRESHOLD) {
    return { ok: true };
  }
  if (action.action === "create") {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: action.content,
        is_pinned: action.is_pinned,
        memory_type: action.memory_type,
        path_matchers: action.path_matchers,
        tags: action.tags
      })
    });
    return handleActionResponse(response);
  }
  if (action.action === "update") {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/${action.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: action.content,
        is_pinned: action.is_pinned,
        path_matchers: action.path_matchers,
        tags: action.tags
      })
    });
    return handleActionResponse(response);
  }
  if (action.action === "delete") {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/${action.id}`, {
      method: "DELETE"
    });
    return handleActionResponse(response);
  }
  return { ok: true };
}
async function handleActionResponse(response) {
  if (response.ok) {
    return { ok: true };
  }
  try {
    const body = await response.json();
    const code = body.error?.code ?? `HTTP_${response.status}`;
    const message = body.error?.message ?? response.statusText;
    return { code, message, ok: false };
  } catch {
    return { code: `HTTP_${response.status}`, message: response.statusText, ok: false };
  }
}
async function run() {
  const encoded = readHandoffArg(process.argv);
  if (!encoded) {
    return;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const payload = workerPayloadSchema.parse(JSON.parse(decoded));
  const projectPaths = getProjectPaths(payload.project_root);
  try {
    await hookLog(projectPaths.hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "StopWorker",
      status: "ok",
      session_id: payload.session_id,
      detail: "worker-started"
    });
    const transcriptSnippet = await readTranscriptSnippet(payload.transcript_path);
    const candidateQuery = payload.last_assistant_message ?? transcriptSnippet.slice(0, 500);
    const candidates = await searchCandidates(payload.endpoint, candidateQuery);
    const prompt = buildExtractionPrompt({
      transcriptSnippet,
      candidateMemories: candidates.results,
      ...payload.last_assistant_message ? { lastAssistantMessage: payload.last_assistant_message } : {}
    });
    const claudeResult = await runClaudePrompt(prompt);
    if (claudeResult.code !== 0) {
      throw new Error(`Claude exited with ${claudeResult.code}: ${claudeResult.stderr}`);
    }
    const extraction = extractionOutputSchema.parse(parseCliJson(claudeResult.stdout));
    for (const action of extraction.actions) {
      const operationAt = (/* @__PURE__ */ new Date()).toISOString();
      if (action.action === "skip" || action.confidence < CONFIDENCE_THRESHOLD) {
        await appendOperationLog(projectPaths.operationLogPath, {
          at: operationAt,
          op: "extraction/skip",
          status: "skipped",
          detail: action.reason,
          data: {
            action: action.action,
            confidence: action.confidence
          }
        });
        continue;
      }
      const result = await applyAction(payload.endpoint, action);
      if (!result.ok) {
        await appendOperationLog(projectPaths.operationLogPath, {
          at: operationAt,
          op: "extraction/apply",
          status: "error",
          memory_id: action.id,
          detail: `${result.code}: ${result.message}`,
          data: { action: action.action }
        });
        break;
      }
      await appendOperationLog(projectPaths.operationLogPath, {
        at: operationAt,
        op: "extraction/apply",
        status: "ok",
        memory_id: action.id,
        detail: action.reason,
        data: { action: action.action, confidence: action.confidence }
      });
    }
    await hookLog(projectPaths.hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "StopWorker",
      status: "ok",
      session_id: payload.session_id,
      detail: "worker-completed"
    });
  } catch (runError) {
    await appendOperationLog(projectPaths.operationLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      op: "extraction/error",
      status: "error",
      detail: runError instanceof Error ? runError.message : String(runError)
    });
    await hookLog(projectPaths.hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "StopWorker",
      status: "error",
      session_id: payload.session_id,
      detail: runError instanceof Error ? runError.message : String(runError)
    });
    error("Stop worker failed", {
      error: runError instanceof Error ? runError.message : String(runError)
    });
  }
}
void run();
//# sourceMappingURL=run.js.map
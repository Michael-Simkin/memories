import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/extraction/run.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import { readFile as readFile3 } from "fs/promises";
import path3 from "path";
import picomatch from "picomatch";

// src/shared/fs-utils.ts
import { appendFile, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
async function appendJsonLine(filePath, payload) {
  await appendFile(filePath, `${JSON.stringify(payload)}
`, "utf8");
}
function normalizePathForMatch(inputPath) {
  const posixPath = inputPath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(posixPath);
  if (normalized === ".") {
    return "";
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
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
async function appendOperationLog(path4, payload) {
  await appendJsonLine(path4, redactUnknown(payload));
}

// src/shared/paths.ts
import { mkdir } from "fs/promises";
import path2 from "path";
import { fileURLToPath } from "url";

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
  path_matcher: z.string().min(1)
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
var COMMAND_PATH_REGEX = /(?:^|[\s"'`])((?:\/[^\s"'`]+)|(?:\.\.?\/[^\s"'`]+)|(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+))(?=$|[\s"'`])/g;
var INLINE_PATH_REGEX = /(?:\/[A-Za-z0-9._-][A-Za-z0-9._/\\-]*|(?:\.\.?\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;
var BARE_FILENAME_REGEX = /\b[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12}\b/g;
var NATURAL_LANGUAGE_FILE_REGEX = /\b([a-z0-9][a-z0-9 _-]{0,80}?)\s+([a-z0-9]{1,8})\s+file\b/gi;
function readHandoffArg(argv) {
  const index = argv.indexOf("--handoff");
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}
async function readTranscriptContext(transcriptPath, projectRoot) {
  const raw = await readFile3(transcriptPath, "utf8");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const recentLines = lines.slice(Math.max(0, lines.length - 300));
  const snippetLines = recentLines.slice(Math.max(0, recentLines.length - 120));
  const events = recentLines.map((line) => safeJsonParse(line)).filter((line) => isObject(line));
  return {
    relatedPaths: collectRelatedPathsFromEvents(events, projectRoot),
    transcriptSnippet: snippetLines.join("\n")
  };
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
    "PATH MATCHER QUALITY RULES",
    "- Use exact file matchers when memory is tied to one specific file (for example: `src/app.ts`).",
    "- Use directory globs (`dir/**`) only when memory clearly applies to multiple files under that directory.",
    "- Do not emit broad catch-all patterns (`*`, `**`, `**/*`, `/`).",
    "- Never include line suffixes in path matchers (invalid: `foo.ts:12`, `foo.ts#L12`).",
    "- Never output sentence fragments or prose as path matchers.",
    "- If there is no clear file relation, use `path_matchers: []`.",
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
    '        { "path_matcher": "glob-like string" }',
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
    "RELATED FILE CONTEXT (project-relative)",
    ...input.relatedPaths.length > 0 ? input.relatedPaths.slice(0, 80).map((relatedPath) => `- ${relatedPath}`) : ["- None detected"],
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
        cwd: process.env.PROJECT_ROOT ?? process.cwd(),
        env: {
          ...process.env,
          CLAUDE_CODE_SIMPLE: "1",
          CLAUDE_KB_RUN: "1",
          CLAUDE_MEMORY_INTERNAL_CLAUDE: "1"
        },
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
function collectRelatedPathsFromEvents(events, projectRoot) {
  const discovered = /* @__PURE__ */ new Set();
  for (const event of events) {
    const message = isObject(event.message) ? event.message : null;
    if (!message) {
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block)) {
        continue;
      }
      if (block.type !== "tool_use") {
        continue;
      }
      const input = isObject(block.input) ? block.input : null;
      if (!input) {
        continue;
      }
      collectPathCandidatesFromObject(input, projectRoot, discovered);
      const command = typeof input.command === "string" ? input.command : null;
      if (command) {
        collectPathCandidatesFromCommand(command, projectRoot, discovered);
      }
    }
  }
  return [...discovered].sort();
}
function collectPathCandidatesFromObject(value, projectRoot, discovered) {
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === "string") {
      const keyLower = key.toLowerCase();
      if (keyLower.includes("path") || keyLower.includes("file") || keyLower.includes("target") || keyLower.includes("cwd")) {
        const normalized = normalizeTranscriptPathCandidate(candidate, projectRoot);
        if (normalized) {
          discovered.add(normalized);
        }
      }
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (isObject(entry)) {
          collectPathCandidatesFromObject(entry, projectRoot, discovered);
        } else if (typeof entry === "string") {
          const normalized = normalizeTranscriptPathCandidate(entry, projectRoot);
          if (normalized) {
            discovered.add(normalized);
          }
        }
      }
      continue;
    }
    if (isObject(candidate)) {
      collectPathCandidatesFromObject(candidate, projectRoot, discovered);
    }
  }
}
function collectPathCandidatesFromCommand(command, projectRoot, discovered) {
  for (const match of command.matchAll(COMMAND_PATH_REGEX)) {
    const candidate = match[1];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeTranscriptPathCandidate(candidate, projectRoot);
    if (normalized) {
      discovered.add(normalized);
    }
  }
}
function normalizeTranscriptPathCandidate(candidate, projectRoot) {
  let value = candidate.trim();
  if (!value) {
    return null;
  }
  value = value.replace(/^['"`]+|['"`]+$/g, "").replaceAll("\\", "/");
  if (!value || value.includes("*") || value.startsWith("http://") || value.startsWith("https://")) {
    return null;
  }
  if (value.startsWith("~") || value.startsWith("$") || value.includes("${")) {
    return null;
  }
  const projectRootPosix = projectRoot.replaceAll("\\", "/");
  if (path3.isAbsolute(value)) {
    const absolutePosix = value.replaceAll("\\", "/");
    if (!absolutePosix.startsWith(`${projectRootPosix}/`) && absolutePosix !== projectRootPosix) {
      return null;
    }
    const relative = path3.posix.relative(projectRootPosix, absolutePosix);
    value = relative;
  }
  const normalized = normalizePathForMatch(value);
  if (!normalized || normalized.startsWith("..")) {
    return null;
  }
  if (!/[A-Za-z0-9]/.test(normalized)) {
    return null;
  }
  return normalized;
}
function tightenActionPathMatchers(action, relatedPaths, projectRoot) {
  if (action.action === "skip" || action.action === "delete") {
    return action;
  }
  const relatedPathSet = new Set(relatedPaths);
  const explicitPaths = extractActionPathHints(action, projectRoot, relatedPaths).map((pathHint) => resolveHintToRelatedPath(pathHint, relatedPaths)).filter((pathHint) => relatedPathSet.has(pathHint) || isExistingProjectPath(pathHint, projectRoot));
  if (explicitPaths.length > 0) {
    const explicitMatchers = explicitPaths.map((pathHint) => ({
      path_matcher: pathHint
    }));
    if (arePathMatchersEqual(action.path_matchers, explicitMatchers)) {
      return action;
    }
    return {
      ...action,
      path_matchers: explicitMatchers
    };
  }
  const sanitized = sanitizePathMatchers(action.path_matchers, relatedPaths, projectRoot);
  if (arePathMatchersEqual(action.path_matchers, sanitized)) {
    return action;
  }
  return {
    ...action,
    path_matchers: sanitized
  };
}
function extractActionPathHints(action, projectRoot, relatedPaths) {
  const combined = [action.content ?? "", action.reason, ...action.evidence].join("\n");
  const matched = /* @__PURE__ */ new Set();
  for (const pathMatch of combined.matchAll(INLINE_PATH_REGEX)) {
    const candidate = pathMatch[0];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeTranscriptPathCandidate(candidate, projectRoot);
    if (normalized) {
      matched.add(normalized);
    }
  }
  for (const fileMatch of combined.matchAll(BARE_FILENAME_REGEX)) {
    const candidate = fileMatch[0];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeTranscriptPathCandidate(candidate, projectRoot);
    if (normalized) {
      matched.add(normalized);
    }
  }
  for (const inferredPath of inferMentionedRelatedFiles(combined, relatedPaths)) {
    matched.add(inferredPath);
  }
  for (const naturalHint of extractNaturalLanguageFileHints(combined, relatedPaths)) {
    matched.add(naturalHint);
  }
  return [...matched];
}
function sanitizePathMatchers(inputMatchers, relatedPaths, projectRoot) {
  const seen = /* @__PURE__ */ new Set();
  const sanitized = [];
  for (const matcher of inputMatchers) {
    const normalizedPattern = normalizeMatcherPattern(matcher.path_matcher, projectRoot);
    if (!normalizedPattern || isOverlyBroadMatcher(normalizedPattern)) {
      continue;
    }
    const hasGlobPattern = hasGlobChars(normalizedPattern);
    if (!hasGlobPattern && relatedPaths.length === 0 && !isExistingProjectPath(normalizedPattern, projectRoot)) {
      continue;
    }
    if (relatedPaths.length > 0) {
      const matcherFn = picomatch(normalizedPattern, { dot: true });
      const matches = relatedPaths.filter((relatedPath) => matcherFn(relatedPath));
      if (matches.length === 0) {
        continue;
      }
      if ((normalizedPattern.includes("*") || isDirectoryMatcher(normalizedPattern)) && matches.length === 1) {
        const exact = matches[0] ?? normalizedPattern;
        if (!seen.has(exact)) {
          seen.add(exact);
          sanitized.push({ path_matcher: exact });
        }
        continue;
      }
    }
    if (seen.has(normalizedPattern)) {
      continue;
    }
    seen.add(normalizedPattern);
    sanitized.push({ path_matcher: normalizedPattern });
  }
  return sanitized;
}
function normalizeMatcherPattern(pattern, projectRoot) {
  let normalized = pattern.trim().replace(/^['"`]+|['"`]+$/g, "").replaceAll("\\", "/");
  if (!normalized) {
    return null;
  }
  normalized = stripTrailingLineReference(normalized);
  if (!normalized || normalized.includes(":")) {
    return null;
  }
  const projectRootPosix = projectRoot.replaceAll("\\", "/");
  if (path3.isAbsolute(normalized)) {
    const absolutePosix = normalized.replaceAll("\\", "/");
    if (!absolutePosix.startsWith(`${projectRootPosix}/`) && absolutePosix !== projectRootPosix) {
      return null;
    }
    normalized = path3.posix.relative(projectRootPosix, absolutePosix);
  }
  normalized = normalized.replaceAll(/\/{2,}/g, "/").replaceAll(/^\.\//g, "");
  if (!normalized || normalized.startsWith("..") || normalized.startsWith("/")) {
    return null;
  }
  return normalized;
}
function isDirectoryMatcher(matcher) {
  return matcher.endsWith("/**") || matcher.endsWith("/**/*");
}
function isOverlyBroadMatcher(matcher) {
  return matcher === "*" || matcher === "**" || matcher === "**/*" || matcher === "/" || matcher === "./*" || matcher === "./**" || /^\*\*\/[^/*?]+\/\*\*\/?$/.test(matcher);
}
function stripTrailingLineReference(value) {
  return value.replace(/#L?\d+$/i, "").replace(/:\d+$/, "");
}
function hasGlobChars(value) {
  return /[*?[\]{}()]/.test(value);
}
function isExistingProjectPath(candidate, projectRoot) {
  if (!candidate || hasGlobChars(candidate)) {
    return false;
  }
  const absoluteRoot = path3.resolve(projectRoot);
  const absoluteCandidate = path3.resolve(projectRoot, candidate);
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(`${absoluteRoot}${path3.sep}`)) {
    return false;
  }
  return existsSync(absoluteCandidate);
}
function arePathMatchersEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const lhs = left[index];
    const rhs = right[index];
    if (!lhs || !rhs) {
      return false;
    }
    if (lhs.path_matcher !== rhs.path_matcher) {
      return false;
    }
  }
  return true;
}
function looksFileLikePath(value) {
  const base = value.split("/").filter(Boolean).at(-1) ?? "";
  if (!base) {
    return false;
  }
  return base.includes(".") || base.startsWith(".");
}
function resolveHintToRelatedPath(hint, relatedPaths) {
  if (relatedPaths.includes(hint)) {
    return hint;
  }
  if (hint.includes("/")) {
    return hint;
  }
  const lowerHint = hint.toLowerCase();
  const basenameMatches = relatedPaths.filter((relatedPath) => {
    return path3.posix.basename(relatedPath).toLowerCase() === lowerHint;
  });
  if (basenameMatches.length === 1) {
    return basenameMatches[0] ?? hint;
  }
  return hint;
}
function inferMentionedRelatedFiles(text, relatedPaths) {
  const loweredText = text.toLowerCase();
  const textTokens = toWordTokens(loweredText);
  if (textTokens.length === 0) {
    return [];
  }
  const tokenSet = new Set(textTokens);
  const scored = [];
  for (const relatedPath of relatedPaths) {
    if (!looksFileLikePath(relatedPath)) {
      continue;
    }
    const base = path3.posix.basename(relatedPath).toLowerCase();
    let score = 0;
    if (loweredText.includes(base)) {
      score += 0.7;
    }
    const baseTokens = toWordTokens(base).filter((token) => token.length >= 2);
    if (baseTokens.length === 0) {
      continue;
    }
    const matchedTokenCount = baseTokens.reduce((count, token) => {
      return tokenSet.has(token) ? count + 1 : count;
    }, 0);
    score += matchedTokenCount / baseTokens.length;
    if (score >= 0.85) {
      scored.push({ path: relatedPath, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const topScore = scored[0]?.score ?? 0;
  if (topScore < 0.85) {
    return [];
  }
  return scored.filter((item) => item.score >= topScore - 0.05).map((item) => item.path);
}
function extractNaturalLanguageFileHints(text, relatedPaths) {
  const hints = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(NATURAL_LANGUAGE_FILE_REGEX)) {
    const stemRaw = match[1]?.trim();
    const extRaw = match[2]?.trim().toLowerCase();
    if (!stemRaw || !extRaw) {
      continue;
    }
    const stemTokens = toWordTokens(stemRaw).filter((token) => token.length >= 2);
    if (stemTokens.length === 0) {
      continue;
    }
    const relatedMatches = relatedPaths.filter((relatedPath) => {
      if (!looksFileLikePath(relatedPath)) {
        return false;
      }
      const base = path3.posix.basename(relatedPath);
      const parsed = path3.posix.parse(base);
      const fileExt = parsed.ext.replace(/^\./, "").toLowerCase();
      if (fileExt !== extRaw) {
        return false;
      }
      const baseTokens = toWordTokens(parsed.name);
      if (baseTokens.length === 0) {
        return false;
      }
      return stemTokens.every((token) => baseTokens.includes(token));
    });
    if (relatedMatches.length > 0) {
      for (const relatedMatch of relatedMatches) {
        hints.add(relatedMatch);
      }
      continue;
    }
    hints.add(`${stemTokens.join("_")}.${extRaw}`);
  }
  return [...hints];
}
function toWordTokens(input) {
  return input.toLowerCase().split(/[^a-z0-9]+/g).map((token) => token.trim()).filter((token) => token.length >= 2);
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
    const transcript = await readTranscriptContext(payload.transcript_path, payload.project_root);
    const candidateQuery = payload.last_assistant_message ?? transcript.transcriptSnippet.slice(0, 500);
    const candidates = await searchCandidates(payload.endpoint, candidateQuery);
    const prompt = buildExtractionPrompt({
      transcriptSnippet: transcript.transcriptSnippet,
      relatedPaths: transcript.relatedPaths,
      candidateMemories: candidates.results,
      ...payload.last_assistant_message ? { lastAssistantMessage: payload.last_assistant_message } : {}
    });
    const claudeResult = await runClaudePrompt(prompt);
    if (claudeResult.code !== 0) {
      throw new Error(`Claude exited with ${claudeResult.code}: ${claudeResult.stderr}`);
    }
    const extraction = extractionOutputSchema.parse(parseCliJson(claudeResult.stdout));
    const tightenedActions = extraction.actions.map(
      (action) => tightenActionPathMatchers(action, transcript.relatedPaths, payload.project_root)
    );
    for (const action of tightenedActions) {
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
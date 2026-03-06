// src/engine/main.ts
import { execFile } from "child_process";
import { existsSync as existsSync2 } from "fs";
import { mkdir as mkdir2, writeFile as writeFile2 } from "fs/promises";
import { createRequire as createRequire2 } from "module";
import net from "net";
import os from "os";
import path5 from "path";
import { promisify } from "util";

// src/api/app.ts
import { existsSync } from "fs";
import path3 from "path";
import express from "express";
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
var DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
var DEFAULT_OLLAMA_TIMEOUT_MS = 1e4;
var OLLAMA_PROFILE_CONFIG = {
  bge: {
    dimensions: 1024,
    model: "bge-m3"
  },
  nomic: {
    dimensions: 768,
    model: "nomic-embed-text"
  }
};
function parsePositiveInteger(rawValue, fallback) {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
function resolveOllamaProfile(rawProfile) {
  const normalized = rawProfile?.trim().toLowerCase();
  if (normalized === "nomic") {
    return "nomic";
  }
  return "bge";
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

// src/retrieval/embeddings.ts
var REQUEST_FAILURE_BACKOFF_MS = 15e3;
var DEFAULT_KEEP_ALIVE = "30m";
var EmbeddingClient = class {
  baseUrl;
  profile;
  timeoutMs;
  nextRetryAtMs;
  constructor(config = {}) {
    const profile = config.profile ?? resolveOllamaProfile(process.env.MEMORIES_OLLAMA_PROFILE);
    this.baseUrl = (config.baseUrl ?? process.env.MEMORIES_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(
      /\/+$/,
      ""
    );
    this.profile = profile;
    this.timeoutMs = config.timeoutMs ?? parsePositiveInteger(process.env.MEMORIES_OLLAMA_TIMEOUT_MS, DEFAULT_OLLAMA_TIMEOUT_MS);
    this.nextRetryAtMs = 0;
  }
  get model() {
    return OLLAMA_PROFILE_CONFIG[this.profile].model;
  }
  get dimensions() {
    return OLLAMA_PROFILE_CONFIG[this.profile].dimensions;
  }
  isConfigured() {
    return this.baseUrl.length > 0;
  }
  async embed(text) {
    if (!this.isConfigured()) {
      return null;
    }
    if (Date.now() < this.nextRetryAtMs) {
      return null;
    }
    const normalizedText = text.trim();
    if (!normalizedText) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          input: normalizedText,
          keep_alive: DEFAULT_KEEP_ALIVE
        })
      });
      if (!response.ok) {
        const responseText = await response.text();
        logWarn("Ollama embed request failed", {
          model: this.model,
          responseText,
          status: response.status,
          statusText: response.statusText
        });
        this.nextRetryAtMs = Date.now() + REQUEST_FAILURE_BACKOFF_MS;
        return null;
      }
      const payload = await response.json();
      const vector = this.parseEmbedding(payload);
      if (!vector) {
        logWarn("Ollama response did not include a valid embedding vector", {
          model: this.model
        });
        this.nextRetryAtMs = Date.now() + REQUEST_FAILURE_BACKOFF_MS;
        return null;
      }
      if (vector.length !== this.dimensions) {
        logWarn("Embedding dimensions mismatch for profile", {
          expected: this.dimensions,
          actual: vector.length,
          model: this.model,
          profile: this.profile
        });
      }
      this.nextRetryAtMs = 0;
      return vector;
    } catch (error) {
      logWarn("Ollama embed request threw an error", {
        error: error instanceof Error ? error.message : String(error),
        model: this.model,
        timeoutMs: this.timeoutMs
      });
      this.nextRetryAtMs = Date.now() + REQUEST_FAILURE_BACKOFF_MS;
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
  parseEmbedding(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const maybePayload = payload;
    if (Array.isArray(maybePayload.embedding) && maybePayload.embedding.every(isNumber)) {
      return maybePayload.embedding;
    }
    if (Array.isArray(maybePayload.embeddings) && Array.isArray(maybePayload.embeddings[0]) && maybePayload.embeddings[0].every(isNumber)) {
      return maybePayload.embeddings[0];
    }
    return null;
  }
};
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// src/retrieval/hybrid-retrieval.ts
import picomatch from "picomatch";

// src/shared/fs-utils.ts
import { appendFile, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
async function atomicWriteJson(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(payload, null, 2)}
`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}
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
function isErrnoException(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

// src/shared/token-budget.ts
function estimateTextTokens(text) {
  return Math.ceil(text.length / 4);
}
function estimateSearchResultTokens(result) {
  return estimateTextTokens(
    `${result.content} ${result.tags.join(" ")} ${result.path_matchers.join(" ")}`
  );
}
function applyTokenBudget(results, maxTokens) {
  const selected = [];
  let consumed = 0;
  for (const result of results) {
    const cost = estimateSearchResultTokens(result);
    if (selected.length > 0 && consumed + cost > maxTokens) {
      break;
    }
    selected.push(result);
    consumed += cost;
  }
  return selected;
}

// src/retrieval/hybrid-retrieval.ts
var RRF_RANK_CONSTANT = 60;
function cosineSimilarity(a, b) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
var RetrievalService = class {
  store;
  embeddingClient;
  constructor(store, embeddingClient) {
    this.store = store;
    this.embeddingClient = embeddingClient;
  }
  async search(options) {
    const pathMatches = this.findPathMatches(
      options.targetPaths ?? [],
      options.memoryTypes,
      options.includePinned
    );
    const lexical = this.store.lexicalSearch({
      query: options.query,
      limit: options.lexicalK ?? DEFAULT_LEXICAL_K,
      includePinned: options.includePinned,
      ...options.memoryTypes ? { memoryTypes: options.memoryTypes } : {}
    });
    const semantic = await this.semanticSearch({
      query: options.query,
      semanticK: options.semanticK ?? DEFAULT_SEMANTIC_K,
      includePinned: options.includePinned,
      ...options.memoryTypes ? { memoryTypes: options.memoryTypes } : {}
    });
    const hybrid = this.mergeHybrid({
      lexical,
      semantic,
      limit: options.limit
    });
    const merged = [];
    const seenIds = /* @__PURE__ */ new Set();
    for (const result of pathMatches) {
      if (seenIds.has(result.id)) {
        continue;
      }
      merged.push(result);
      seenIds.add(result.id);
      if (merged.length >= options.limit) {
        return merged;
      }
    }
    for (const result of hybrid) {
      if (seenIds.has(result.id)) {
        continue;
      }
      merged.push(result);
      seenIds.add(result.id);
      if (merged.length >= options.limit) {
        break;
      }
    }
    const budgeted = typeof options.responseTokenBudget === "number" && options.responseTokenBudget > 0 ? applyTokenBudget(merged, options.responseTokenBudget) : merged;
    return budgeted.slice(0, options.limit);
  }
  async semanticSearch(input) {
    if (!this.embeddingClient.isConfigured() || !input.query.trim()) {
      return [];
    }
    const queryVector = await this.embeddingClient.embed(input.query);
    if (!queryVector) {
      return [];
    }
    const rows = this.store.listEmbeddings(input.memoryTypes, input.includePinned);
    return rows.filter((row) => row.vector.length === queryVector.length).map((row) => {
      const cosine = cosineSimilarity(queryVector, row.vector);
      const normalizedScore = (cosine + 1) / 2;
      const pathMatchers = this.store.getMemory(row.id)?.path_matchers.map((value) => value.path_matcher) ?? [];
      return {
        id: row.id,
        memory_type: row.memory_type,
        content: row.content,
        tags: row.tags,
        is_pinned: row.is_pinned,
        path_matchers: pathMatchers,
        score: normalizedScore,
        source: "hybrid",
        updated_at: row.updated_at
      };
    }).sort((left, right) => this.sortSearchResults(left, right)).slice(0, input.semanticK);
  }
  findPathMatches(targetPaths, memoryTypes, includePinned) {
    const normalizedTargets = targetPaths.map((value) => normalizePathForMatch(value)).filter(Boolean);
    if (normalizedTargets.length === 0) {
      return [];
    }
    const bestMatchByMemoryId = /* @__PURE__ */ new Map();
    for (const matcher of this.store.listPathMatchers()) {
      if (!this.matchesAnyTarget(matcher.path_matcher, normalizedTargets)) {
        continue;
      }
      const specificity = this.computeMatcherSpecificity(matcher.path_matcher);
      const existing = bestMatchByMemoryId.get(matcher.memory_id);
      if (!existing || this.sortByMatcherSpecificity(specificity, existing) < 0) {
        bestMatchByMemoryId.set(matcher.memory_id, specificity);
      }
    }
    const memoryIds = [...bestMatchByMemoryId.keys()];
    if (memoryIds.length === 0) {
      return [];
    }
    const ranked = this.store.getMemoriesByIds(memoryIds).filter((memory) => memoryTypes ? memoryTypes.includes(memory.memory_type) : true).filter((memory) => includePinned ? true : !memory.is_pinned).flatMap((memory) => {
      const specificity = bestMatchByMemoryId.get(memory.id);
      if (!specificity) {
        return [];
      }
      return [
        {
          memory,
          specificity,
          effectRank: this.classifyPolicyEffect(memory)
        }
      ];
    });
    ranked.sort((left, right) => this.sortPathMatches(left, right));
    return ranked.map((entry, index) => ({
      ...entry.memory,
      source: "path",
      score: 1 / (index + 1)
    }));
  }
  matchesAnyTarget(pathMatcher, targets) {
    try {
      const matcher = picomatch(pathMatcher, { dot: true });
      return targets.some((target) => matcher(target));
    } catch {
      return false;
    }
  }
  mergeHybrid(input) {
    const byMemoryId = /* @__PURE__ */ new Map();
    const addRankedBranch = (branch) => {
      for (let index = 0; index < branch.length; index += 1) {
        const result = branch[index];
        if (!result) {
          continue;
        }
        const rank = index + 1;
        const contribution = 1 / (RRF_RANK_CONSTANT + rank);
        const current = byMemoryId.get(result.id);
        if (!current) {
          byMemoryId.set(result.id, {
            representative: result,
            bestRank: rank,
            rrfScore: contribution
          });
          continue;
        }
        current.rrfScore += contribution;
        if (rank < current.bestRank) {
          current.bestRank = rank;
          current.representative = result;
        }
      }
    };
    addRankedBranch(input.lexical);
    addRankedBranch(input.semantic);
    return [...byMemoryId.values()].map((entry) => ({
      ...entry.representative,
      score: entry.rrfScore,
      source: "hybrid"
    })).sort((left, right) => this.sortSearchResults(left, right)).slice(0, input.limit);
  }
  sortSearchResults(left, right) {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const timeOrder = right.updated_at.localeCompare(left.updated_at);
    if (timeOrder !== 0) {
      return timeOrder;
    }
    return left.id.localeCompare(right.id);
  }
  sortPathMatches(left, right) {
    if (left.effectRank !== right.effectRank) {
      return right.effectRank - left.effectRank;
    }
    const specificityOrder = this.sortByMatcherSpecificity(left.specificity, right.specificity);
    if (specificityOrder !== 0) {
      return specificityOrder;
    }
    if (left.memory.is_pinned !== right.memory.is_pinned) {
      return left.memory.is_pinned ? -1 : 1;
    }
    const timeOrder = right.memory.updated_at.localeCompare(left.memory.updated_at);
    if (timeOrder !== 0) {
      return timeOrder;
    }
    return left.memory.id.localeCompare(right.memory.id);
  }
  sortByMatcherSpecificity(left, right) {
    if (left.scopeRank !== right.scopeRank) {
      return right.scopeRank - left.scopeRank;
    }
    if (left.literalSegmentCount !== right.literalSegmentCount) {
      return right.literalSegmentCount - left.literalSegmentCount;
    }
    if (left.wildcardSegmentCount !== right.wildcardSegmentCount) {
      return left.wildcardSegmentCount - right.wildcardSegmentCount;
    }
    if (left.hasDoubleStar !== right.hasDoubleStar) {
      return left.hasDoubleStar ? 1 : -1;
    }
    return right.matcherLength - left.matcherLength;
  }
  computeMatcherSpecificity(pathMatcher) {
    const normalized = normalizePathForMatch(pathMatcher);
    const segments = normalized.split("/").filter(Boolean);
    const hasDoubleStar = normalized.includes("**");
    const wildcardSegmentCount = segments.reduce((count, segment) => {
      return this.hasGlobChars(segment) ? count + 1 : count;
    }, 0);
    const literalSegmentCount = segments.length - wildcardSegmentCount;
    const hasGlob = this.hasGlobChars(normalized);
    let scopeRank = 1;
    if (!hasGlob) {
      scopeRank = this.looksFileLikePath(normalized) ? 4 : 3;
    } else if (!hasDoubleStar) {
      scopeRank = 2;
    }
    return {
      hasDoubleStar,
      literalSegmentCount,
      matcherLength: normalized.length,
      scopeRank,
      wildcardSegmentCount
    };
  }
  classifyPolicyEffect(memory) {
    if (memory.memory_type !== "rule") {
      return 0;
    }
    const text = `${memory.content} ${memory.tags.join(" ")}`.toLowerCase();
    if (/\b(do not|don't|never|must not|forbidden|deny|prohibit|cannot|can't)\b/.test(text)) {
      return 4;
    }
    if (/\b(must|always|required|enforce|only)\b/.test(text)) {
      return 3;
    }
    if (/\b(prefer|should|recommended|ideally)\b/.test(text)) {
      return 2;
    }
    return 1;
  }
  hasGlobChars(value) {
    return /[*?[\]{}()]/.test(value);
  }
  looksFileLikePath(value) {
    const lastSegment = value.split("/").filter(Boolean).at(-1) ?? "";
    return Boolean(lastSegment) && (lastSegment.includes(".") || lastSegment.startsWith("."));
  }
};

// src/shared/lockfile.ts
import { z } from "zod";
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
async function writeLockMetadata(lockPath, payload) {
  const normalized = lockMetadataSchema.parse({
    ...payload,
    connected_session_ids: uniqueNonEmpty(payload.connected_session_ids)
  });
  if (!isLoopback(normalized.host)) {
    throw new Error(`Lock host must be loopback, received: ${normalized.host}`);
  }
  await atomicWriteJson(lockPath, normalized);
}
async function updateConnectedSessions(lockPath, updater) {
  const current = await readLockMetadata(lockPath);
  if (!current) {
    return null;
  }
  const next = {
    ...current,
    connected_session_ids: uniqueNonEmpty(updater(current.connected_session_ids))
  };
  await writeLockMetadata(lockPath, next);
  return next;
}
async function removeLockIfOwned(lockPath, ownerPid) {
  const current = await readLockMetadata(lockPath);
  if (!current || current.pid !== ownerPid) {
    return;
  }
  await removeFileIfExists(lockPath);
}
function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
async function readEventLogs(logPath, limit = 200) {
  try {
    const raw = await readFile2(logPath, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const selected = lines.slice(Math.max(0, lines.length - limit));
    return selected.flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        const validated = memoryEventLogSchema.safeParse(parsed);
        return validated.success ? [validated.data] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (isErrnoException2(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
function isErrnoException2(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

// src/storage/database.ts
import { createRequire } from "module";
import path2 from "path";
import { ulid } from "ulid";
function loadBetterSqlite3(pluginRoot) {
  const nativeRoot = path2.join(pluginRoot, "native");
  const requireFromStorage = createRequire(import.meta.url);
  let resolvedPath;
  try {
    resolvedPath = requireFromStorage.resolve("better-sqlite3", { paths: [nativeRoot] });
  } catch (error) {
    throw new Error(
      `better-sqlite3 is missing from runtime native dependencies at ${nativeRoot}. Run engine startup to install dependencies. ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const loaded = requireFromStorage(resolvedPath);
  const constructor = typeof loaded === "object" && loaded !== null && "default" in loaded && typeof loaded.default === "function" ? loaded.default : loaded;
  if (typeof constructor !== "function") {
    throw new Error(`better-sqlite3 resolved at ${resolvedPath} but did not export a constructor`);
  }
  return constructor;
}
function parseTags(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value) => typeof value === "string");
  } catch {
    return [];
  }
}
function parseVector(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value) => typeof value === "number");
  } catch {
    return [];
  }
}
function normalizeMatchers(matchers) {
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const matcher of matchers) {
    const value = matcher.path_matcher.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push({ path_matcher: value });
  }
  return normalized;
}
function extractTerms(query) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/g).map((term) => term.trim()).filter((term) => term.length >= 2);
  return [...new Set(terms)];
}
function makeTagFtsQuery(terms) {
  return terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
}
function clamp01(value) {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
function normalizeBm25(value, range) {
  const magnitude = Math.abs(value);
  if (range.max <= range.min) {
    return 1;
  }
  return clamp01(1 - (magnitude - range.min) / (range.max - range.min));
}
function computeBm25Range(rows) {
  if (rows.length === 0) {
    return { min: 0, max: 0 };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const magnitude = Math.abs(row.score);
    if (magnitude < min) {
      min = magnitude;
    }
    if (magnitude > max) {
      max = magnitude;
    }
  }
  return { min, max };
}
var MemoryStore = class {
  database;
  vecEnabled;
  embeddingDimensions;
  constructor(options) {
    this.embeddingDimensions = options.embeddingDimensions;
    const BetterSqlite3 = loadBetterSqlite3(options.pluginRoot);
    this.database = new BetterSqlite3(options.dbPath, {
      timeout: 5e3
    });
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.initializeSchema();
    this.vecEnabled = this.tryEnableVec(options.sqliteVecExtensionPath ?? null);
    this.initializeVecSchemaIfEnabled();
  }
  close() {
    this.database.close();
  }
  memoryCount() {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM memories").get();
    return row?.count ?? 0;
  }
  listMemories(limit, offset) {
    const rows = this.database.prepare(
      `
          SELECT id, memory_type, content, tags_json, is_pinned, created_at, updated_at
          FROM memories
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?
        `
    ).all(limit, offset);
    return rows.map((row) => this.inflateMemory(row));
  }
  getMemory(id) {
    const row = this.database.prepare(
      `
          SELECT id, memory_type, content, tags_json, is_pinned, created_at, updated_at
          FROM memories
          WHERE id = ?
        `
    ).get(id);
    return row ? this.inflateMemory(row) : null;
  }
  getPinnedMemories() {
    const rows = this.database.prepare(
      `
          SELECT id, memory_type, content, tags_json, is_pinned, updated_at
          FROM memories
          WHERE is_pinned = 1
          ORDER BY updated_at DESC
        `
    ).all();
    return rows.map((row) => ({
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: parseTags(row.tags_json),
      is_pinned: row.is_pinned === 1,
      path_matchers: this.getPathMatchersByMemoryId(row.id),
      score: 1,
      source: "hybrid",
      updated_at: row.updated_at
    }));
  }
  createMemory(input, embeddingVector) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const memoryId = ulid();
    const normalizedTags = input.tags.map((tag) => tag.trim()).filter(Boolean);
    const normalizedMatchers = normalizeMatchers(input.path_matchers);
    const transaction = this.database.transaction(() => {
      this.database.prepare(
        `
            INSERT INTO memories (id, memory_type, content, tags_json, is_pinned, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `
      ).run(
        memoryId,
        input.memory_type,
        input.content,
        JSON.stringify(normalizedTags),
        input.is_pinned ? 1 : 0,
        now,
        now
      );
      this.syncFts(memoryId, normalizedTags);
      this.replacePathMatchers(memoryId, normalizedMatchers, now);
      this.syncEmbedding(memoryId, embeddingVector, now);
    });
    transaction();
    const created = this.getMemory(memoryId);
    if (!created) {
      throw new Error("Memory was not found after create transaction");
    }
    return created;
  }
  updateMemory(memoryId, updates, embeddingVector) {
    const current = this.getMemory(memoryId);
    if (!current) {
      return null;
    }
    const nextContent = updates.content ?? current.content;
    const nextTags = updates.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [...current.tags.map((tag) => tag.trim())];
    const nextPinned = updates.is_pinned ?? current.is_pinned;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const transaction = this.database.transaction(() => {
      this.database.prepare(
        `
            UPDATE memories
            SET content = ?, tags_json = ?, is_pinned = ?, updated_at = ?
            WHERE id = ?
          `
      ).run(nextContent, JSON.stringify(nextTags), nextPinned ? 1 : 0, now, memoryId);
      this.syncFts(memoryId, nextTags);
      if (updates.path_matchers) {
        this.replacePathMatchers(memoryId, normalizeMatchers(updates.path_matchers), now);
      }
      this.syncEmbedding(memoryId, embeddingVector, now);
    });
    transaction();
    return this.getMemory(memoryId);
  }
  deleteMemory(memoryId) {
    const transaction = this.database.transaction(() => {
      this.database.prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?").run(memoryId);
      this.database.prepare("DELETE FROM memory_fts WHERE id = ?").run(memoryId);
      this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
      if (this.vecEnabled) {
        this.database.prepare("DELETE FROM vec_memory WHERE id = ?").run(memoryId);
      }
      return this.database.prepare("DELETE FROM memories WHERE id = ?").run(memoryId).changes > 0;
    });
    return transaction();
  }
  lexicalSearch(input) {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      const rows2 = this.database.prepare(
        `
            SELECT id, memory_type, content, tags_json, is_pinned, updated_at
            FROM memories
            WHERE (${input.includePinned ? "1=1" : "is_pinned = 0"})
            ORDER BY updated_at DESC
            LIMIT ?
          `
      ).all(input.limit);
      return rows2.filter((row) => !input.memoryTypes || input.memoryTypes.includes(row.memory_type)).map((row) => ({
        id: row.id,
        memory_type: row.memory_type,
        content: row.content,
        tags: parseTags(row.tags_json),
        is_pinned: row.is_pinned === 1,
        path_matchers: this.getPathMatchersByMemoryId(row.id),
        score: 0.1,
        source: "hybrid",
        updated_at: row.updated_at
      }));
    }
    const terms = extractTerms(trimmedQuery);
    if (terms.length === 0) {
      return [];
    }
    const candidateLimit = Math.min(Math.max(input.limit * 3, input.limit), 200);
    const rows = this.database.prepare(
      `
          SELECT m.id, m.memory_type, m.content, m.tags_json, m.is_pinned, m.created_at, m.updated_at, bm25(memory_fts) AS score
          FROM memory_fts
          JOIN memories m ON m.id = memory_fts.id
          WHERE memory_fts MATCH ?
            AND (${input.includePinned ? "1=1" : "m.is_pinned = 0"})
          ORDER BY score
          LIMIT ?
        `
    ).all(makeTagFtsQuery(terms), candidateLimit);
    const bm25Range = computeBm25Range(rows);
    return rows.filter((row) => !input.memoryTypes || input.memoryTypes.includes(row.memory_type)).map((row) => {
      const tags = parseTags(row.tags_json);
      const loweredTags = tags.join(" ").toLowerCase();
      const matchedTerms = terms.reduce((count, term) => {
        return loweredTags.includes(term) ? count + 1 : count;
      }, 0);
      const coverage = matchedTerms / terms.length;
      const score = clamp01(0.8 * normalizeBm25(row.score, bm25Range) + 0.2 * coverage);
      return {
        id: row.id,
        memory_type: row.memory_type,
        content: row.content,
        tags,
        is_pinned: row.is_pinned === 1,
        path_matchers: this.getPathMatchersByMemoryId(row.id),
        score,
        source: "hybrid",
        updated_at: row.updated_at
      };
    }).sort((left, right) => right.score - left.score || right.updated_at.localeCompare(left.updated_at)).slice(0, input.limit);
  }
  listEmbeddings(memoryTypes, includePinned = true) {
    const rows = this.database.prepare(
      `
          SELECT e.memory_id, e.vector_json, e.updated_at,
                 m.memory_type, m.content, m.tags_json, m.is_pinned
          FROM memory_embeddings e
          JOIN memories m ON m.id = e.memory_id
          WHERE (${includePinned ? "1=1" : "m.is_pinned = 0"})
        `
    ).all();
    return rows.filter((row) => !memoryTypes || memoryTypes.includes(row.memory_type)).map((row) => ({
      id: row.memory_id,
      memory_type: row.memory_type,
      content: row.content,
      tags: parseTags(row.tags_json),
      is_pinned: row.is_pinned === 1,
      updated_at: row.updated_at,
      vector: parseVector(row.vector_json)
    }));
  }
  upsertEmbedding(memoryId, vector) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.syncEmbedding(memoryId, vector, now);
  }
  removeEmbedding(memoryId) {
    this.syncEmbedding(memoryId, null, (/* @__PURE__ */ new Date()).toISOString());
  }
  listPathMatchers() {
    return this.database.prepare(
      `
          SELECT memory_id, path_matcher
          FROM memory_path_matchers
          ORDER BY created_at DESC
        `
    ).all();
  }
  getMemoriesByIds(ids) {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.database.prepare(
      `
          SELECT id, memory_type, content, tags_json, is_pinned, updated_at
          FROM memories
          WHERE id IN (${placeholders})
        `
    ).all(...ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) {
        return [];
      }
      return [
        {
          id: row.id,
          memory_type: row.memory_type,
          content: row.content,
          tags: parseTags(row.tags_json),
          is_pinned: row.is_pinned === 1,
          path_matchers: this.getPathMatchersByMemoryId(row.id),
          score: 1,
          source: "hybrid",
          updated_at: row.updated_at
        }
      ];
    });
  }
  initializeSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (memory_type IN ('fact', 'rule', 'decision', 'episode')),
        CHECK (json_valid(tags_json)),
        CHECK (is_pinned IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS memory_path_matchers (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        path_matcher TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_mpm_unique ON memory_path_matchers(memory_id, path_matcher);
      CREATE INDEX IF NOT EXISTS idx_mpm_memory_id ON memory_path_matchers(memory_id);
      CREATE INDEX IF NOT EXISTS idx_mpm_path_matcher ON memory_path_matchers(path_matcher);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        tags_text
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  initializeVecSchemaIfEnabled() {
    if (!this.vecEnabled) {
      return;
    }
    try {
      this.database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
          id TEXT PRIMARY KEY,
          vector float[${this.embeddingDimensions}] distance_metric=cosine
        );
      `);
    } catch (error) {
      logWarn("Failed creating vec_memory virtual table; fallback to JSON vectors only", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  tryEnableVec(extensionPath) {
    if (!extensionPath) {
      return false;
    }
    try {
      this.database.loadExtension(extensionPath);
      return true;
    } catch (error) {
      logWarn("sqlite-vec extension failed to load; continuing without vec table", {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
  inflateMemory(row) {
    return {
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: parseTags(row.tags_json),
      is_pinned: row.is_pinned === 1,
      path_matchers: this.getPathMatchersByMemoryId(row.id).map((pathMatcher) => ({
        path_matcher: pathMatcher
      })),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
  getPathMatchersByMemoryId(memoryId) {
    const rows = this.database.prepare(
      `
          SELECT path_matcher
          FROM memory_path_matchers
          WHERE memory_id = ?
          ORDER BY created_at DESC
        `
    ).all(memoryId);
    return rows.map((row) => row.path_matcher);
  }
  syncFts(memoryId, tags) {
    this.database.prepare("DELETE FROM memory_fts WHERE id = ?").run(memoryId);
    this.database.prepare("INSERT INTO memory_fts (id, tags_text) VALUES (?, ?)").run(memoryId, tags.join(" "));
  }
  replacePathMatchers(memoryId, pathMatchers, createdAt) {
    this.database.prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?").run(memoryId);
    if (pathMatchers.length === 0) {
      return;
    }
    const insertStatement = this.database.prepare(
      `
        INSERT INTO memory_path_matchers (id, memory_id, path_matcher, created_at)
        VALUES (?, ?, ?, ?)
      `
    );
    for (const matcher of pathMatchers) {
      insertStatement.run(ulid(), memoryId, matcher.path_matcher, createdAt);
    }
  }
  syncEmbedding(memoryId, vector, updatedAt) {
    if (vector === void 0) {
      return;
    }
    if (vector === null) {
      this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
      if (this.vecEnabled) {
        this.database.prepare("DELETE FROM vec_memory WHERE id = ?").run(memoryId);
      }
      return;
    }
    this.database.prepare(
      `
          INSERT INTO memory_embeddings (memory_id, vector_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(memory_id) DO UPDATE SET
            vector_json = excluded.vector_json,
            updated_at = excluded.updated_at
        `
    ).run(memoryId, JSON.stringify(vector), updatedAt);
    if (!this.vecEnabled) {
      return;
    }
    if (vector.length !== this.embeddingDimensions) {
      logWarn("Skipping vec_memory sync because embedding dimensions mismatch", {
        actual: vector.length,
        expected: this.embeddingDimensions,
        memoryId
      });
      return;
    }
    try {
      this.database.prepare("DELETE FROM vec_memory WHERE id = ?").run(memoryId);
      this.database.prepare(
        `
            INSERT INTO vec_memory (id, vector)
            VALUES (?, ?)
          `
      ).run(memoryId, JSON.stringify(vector));
    } catch (error) {
      logWarn("Failed syncing vec_memory row; keeping JSON embedding row", {
        error: error instanceof Error ? error.message : String(error),
        memoryId
      });
    }
  }
};

// src/api/errors.ts
function sendError(response, status, code, message) {
  return response.status(status).json({
    error: {
      code,
      message
    }
  });
}

// src/api/app.ts
var sessionsPayloadSchema = z3.object({
  session_id: z3.string().trim().min(1)
});
var listMemoriesQuerySchema = z3.object({
  limit: z3.coerce.number().int().min(1).max(200).default(50),
  offset: z3.coerce.number().int().min(0).default(0)
});
var logsQuerySchema = z3.object({
  limit: z3.coerce.number().int().min(1).max(1e3).default(200),
  order: z3.enum(["asc", "desc"]).default("desc")
});
var memoryIdParamSchema = z3.object({
  id: z3.string().trim().min(1)
});
function toEventLog(input) {
  return memoryEventLogSchema.parse(input);
}
function createEngineApp(options) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const startedAtMs = Date.now();
  const profile = resolveOllamaProfile(process.env.MEMORIES_OLLAMA_PROFILE);
  const store = new MemoryStore({
    dbPath: path3.join(options.projectRoot, ".memories", "ai_memory.db"),
    pluginRoot: options.pluginRoot,
    sqliteVecExtensionPath: options.sqliteVecExtensionPath,
    embeddingDimensions: OLLAMA_PROFILE_CONFIG[profile].dimensions
  });
  const embeddingClient = new EmbeddingClient();
  const retrieval = new RetrievalService(store, embeddingClient);
  const activeSessions = /* @__PURE__ */ new Set();
  let drainTriggered = false;
  const staticUiDir = path3.join(options.pluginRoot, "web", "dist");
  if (existsSync(staticUiDir)) {
    app.use("/ui", express.static(staticUiDir));
    app.get("/ui{*path}", (request, response, next) => {
      if (request.path.startsWith("/ui/assets/")) {
        next();
        return;
      }
      response.sendFile(path3.join(staticUiDir, "index.html"));
    });
  }
  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      port: options.port
    });
  });
  app.get("/stats", (_request, response) => {
    response.json({
      active_sessions: activeSessions.size,
      memory_count: store.memoryCount(),
      online: true,
      uptime_ms: Date.now() - startedAtMs
    });
  });
  app.post("/sessions/connect", async (request, response) => {
    const parsed = sessionsPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, "INVALID_SESSION_ID", parsed.error.message);
    }
    const sessionId = parsed.data.session_id;
    activeSessions.add(sessionId);
    drainTriggered = false;
    await updateConnectedSessions(options.lockPath, (currentSessions) => [...currentSessions, sessionId]);
    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "sessions/connect",
        kind: "hook",
        status: "ok",
        session_id: sessionId
      })
    );
    return response.json({ active_sessions: activeSessions.size, ok: true });
  });
  app.post("/sessions/disconnect", async (request, response) => {
    const parsed = sessionsPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, "INVALID_SESSION_ID", parsed.error.message);
    }
    const sessionId = parsed.data.session_id;
    activeSessions.delete(sessionId);
    await updateConnectedSessions(
      options.lockPath,
      (currentSessions) => currentSessions.filter((value) => value !== sessionId)
    );
    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "sessions/disconnect",
        kind: "hook",
        status: "ok",
        session_id: sessionId
      })
    );
    if (activeSessions.size === 0 && !drainTriggered) {
      drainTriggered = true;
      void options.onSessionDrain().catch((error) => {
        logError("Session drain callback failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return response.json({ active_sessions: activeSessions.size, ok: true });
  });
  app.get("/memories/pinned", (_request, response) => {
    const startedAt = Date.now();
    const results = store.getPinnedMemories();
    return response.json({
      meta: {
        duration_ms: Date.now() - startedAt,
        query: "pinned",
        returned: results.length,
        source: "hybrid"
      },
      results
    });
  });
  app.post("/memories/search", async (request, response) => {
    const parsed = searchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, "INVALID_PAYLOAD", parsed.error.message);
    }
    const startedAt = Date.now();
    const results = await retrieval.search({
      query: parsed.data.query,
      limit: parsed.data.limit,
      includePinned: parsed.data.include_pinned,
      targetPaths: parsed.data.target_paths,
      memoryTypes: parsed.data.memory_types,
      lexicalK: parsed.data.lexical_k,
      semanticK: parsed.data.semantic_k,
      responseTokenBudget: parsed.data.response_token_budget
    });
    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "memory/search",
        kind: "operation",
        status: "ok",
        detail: `returned=${results.length}`
      })
    );
    return response.json({
      meta: {
        duration_ms: Date.now() - startedAt,
        query: parsed.data.query,
        returned: results.length,
        source: "hybrid"
      },
      results
    });
  });
  app.post("/memories/add", async (request, response) => {
    const parsed = addMemoryInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, "INVALID_PAYLOAD", parsed.error.message);
    }
    let vector = null;
    if (embeddingClient.isConfigured()) {
      vector = await embeddingClient.embed(parsed.data.content);
    }
    const created = store.createMemory(parsed.data, vector);
    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "memory/create",
        kind: "operation",
        status: "ok",
        memory_id: created.id
      })
    );
    return response.status(201).json({ memory: created });
  });
  app.get("/memories", (request, response) => {
    const parsed = listMemoriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(response, 400, "INVALID_QUERY", parsed.error.message);
    }
    const items = store.listMemories(parsed.data.limit, parsed.data.offset);
    return response.json({
      items,
      total: store.memoryCount()
    });
  });
  app.patch("/memories/:id", async (request, response) => {
    const parsedId = memoryIdParamSchema.safeParse(request.params);
    if (!parsedId.success) {
      return sendError(response, 400, "INVALID_MEMORY_ID", parsedId.error.message);
    }
    const parsedBody = updateMemoryInputSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 400, "INVALID_PAYLOAD", parsedBody.error.message);
    }
    let vector = void 0;
    if (typeof parsedBody.data.content === "string" && embeddingClient.isConfigured()) {
      vector = await embeddingClient.embed(parsedBody.data.content);
      if (!vector) {
        logWarn("Embedding update skipped due failed embedding request", {
          memoryId: parsedId.data.id
        });
      }
    }
    const updated = store.updateMemory(parsedId.data.id, parsedBody.data, vector);
    if (!updated) {
      return sendError(response, 404, "NOT_FOUND", `Memory ${parsedId.data.id} was not found`);
    }
    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "memory/update",
        kind: "operation",
        status: "ok",
        memory_id: updated.id
      })
    );
    return response.json({ memory: updated });
  });
  app.delete("/memories/:id", async (request, response) => {
    const parsedId = memoryIdParamSchema.safeParse(request.params);
    if (!parsedId.success) {
      return sendError(response, 400, "INVALID_MEMORY_ID", parsedId.error.message);
    }
    const deleted = store.deleteMemory(parsedId.data.id);
    if (!deleted) {
      return sendError(response, 404, "NOT_FOUND", `Memory ${parsedId.data.id} was not found`);
    }
    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        event: "memory/delete",
        kind: "operation",
        status: "ok",
        memory_id: parsedId.data.id
      })
    );
    return response.json({ deleted: true, id: parsedId.data.id });
  });
  app.get("/logs", async (request, response) => {
    const parsed = logsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(response, 400, "INVALID_QUERY", parsed.error.message);
    }
    const entries = await readEventLogs(options.eventLogPath, parsed.data.limit);
    const items = parsed.data.order === "desc" ? [...entries].reverse() : entries;
    return response.json({ items });
  });
  app.use((error, _request, response, _next) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    return sendError(response, 500, "INTERNAL_ERROR", message);
  });
  return {
    app,
    close: () => store.close(),
    getSessionCount: () => activeSessions.size
  };
}

// src/shared/paths.ts
import { mkdir } from "fs/promises";
import path4 from "path";
import { fileURLToPath } from "url";
function resolveProjectRoot(explicitProjectRoot) {
  if (explicitProjectRoot && path4.isAbsolute(explicitProjectRoot)) {
    return explicitProjectRoot;
  }
  const envProjectRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envProjectRoot && path4.isAbsolute(envProjectRoot)) {
    return envProjectRoot;
  }
  return process.cwd();
}
function resolvePluginRoot() {
  const envPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envPluginRoot && path4.isAbsolute(envPluginRoot)) {
    return envPluginRoot;
  }
  const currentFilePath = fileURLToPath(import.meta.url);
  const moduleDirectory = path4.dirname(currentFilePath);
  return path4.resolve(moduleDirectory, "..", "..");
}
function getProjectPaths(projectRoot) {
  const memoriesDir = path4.join(projectRoot, ".memories");
  return {
    projectRoot,
    memoriesDir,
    dbPath: path4.join(memoriesDir, MEMORY_DB_FILE),
    lockPath: path4.join(memoriesDir, ENGINE_LOCK_FILE),
    eventLogPath: path4.join(memoriesDir, MEMORY_EVENTS_LOG_FILE)
  };
}
async function ensureProjectDirectories(projectRoot) {
  const projectPaths = getProjectPaths(projectRoot);
  await mkdir(projectPaths.memoriesDir, { recursive: true });
  return projectPaths;
}

// src/engine/main.ts
var SQLITE_VEC_VERSION = "0.1.7-alpha.2";
var NATIVE_INSTALL_TIMEOUT_MS = 12e4;
var requireFromEngine = createRequire2(import.meta.url);
var closeServer = promisify((server, callback) => {
  server.close(callback);
});
function sqliteVecPackageName() {
  return `sqlite-vec-${os.platform()}-${os.arch()}`;
}
function sqliteVecBinaryExtension() {
  if (os.platform() === "darwin") {
    return ".dylib";
  }
  if (os.platform() === "win32") {
    return ".dll";
  }
  return ".so";
}
function sqliteVecBinaryPath(nativeRoot) {
  return path5.join(
    nativeRoot,
    "node_modules",
    sqliteVecPackageName(),
    `vec0${sqliteVecBinaryExtension()}`
  );
}
function sqliteVecExtensionPath(nativeRoot) {
  return sqliteVecBinaryPath(nativeRoot);
}
function resolvePackage(packageName, nativeRoot) {
  try {
    return requireFromEngine.resolve(packageName, { paths: [nativeRoot] });
  } catch {
    return null;
  }
}
async function ensureNativeRoot(pluginRoot) {
  const nativeRoot = path5.join(pluginRoot, "native");
  await mkdir2(nativeRoot, { recursive: true });
  const packageJsonPath = path5.join(nativeRoot, "package.json");
  if (!existsSync2(packageJsonPath)) {
    await writeFile2(
      packageJsonPath,
      `${JSON.stringify({ name: "memories-native-runtime", private: true }, null, 2)}
`,
      "utf8"
    );
  }
  return nativeRoot;
}
async function installNativePackage(nativeRoot, packageSpec) {
  await new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["install", "--prefix", nativeRoot, packageSpec],
      { timeout: NATIVE_INSTALL_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve();
      }
    );
  });
}
async function ensureBetterSqlite3(nativeRoot) {
  if (!resolvePackage("better-sqlite3", nativeRoot)) {
    try {
      await installNativePackage(nativeRoot, "better-sqlite3");
    } catch (error) {
      throw new Error(
        `Failed to install better-sqlite3 at runtime. Run "npm install --prefix ${nativeRoot} better-sqlite3". ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const resolvedPath = resolvePackage("better-sqlite3", nativeRoot);
  if (!resolvedPath) {
    throw new Error(
      `better-sqlite3 is not resolvable from ${nativeRoot} after installation. Verify native runtime dependencies.`
    );
  }
  try {
    requireFromEngine(resolvedPath);
  } catch (error) {
    throw new Error(
      `better-sqlite3 failed to load from ${resolvedPath}. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
async function ensureSqliteVec(nativeRoot) {
  if (existsSync2(sqliteVecBinaryPath(nativeRoot))) {
    return sqliteVecExtensionPath(nativeRoot);
  }
  const packageSpec = `${sqliteVecPackageName()}@${SQLITE_VEC_VERSION}`;
  try {
    await installNativePackage(nativeRoot, packageSpec);
  } catch (error) {
    logWarn("sqlite-vec install failed; continuing with non-vec fallback", {
      error: error instanceof Error ? error.message : String(error),
      packageSpec
    });
    return null;
  }
  if (!existsSync2(sqliteVecBinaryPath(nativeRoot))) {
    logWarn("sqlite-vec binary not found after install; continuing with non-vec fallback", {
      packageSpec
    });
    return null;
  }
  return sqliteVecExtensionPath(nativeRoot);
}
async function pickPort() {
  const portFromEnvironment = process.env.MEMORIES_ENGINE_PORT;
  if (portFromEnvironment) {
    const parsed = Number.parseInt(portFromEnvironment.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve an engine port")));
        return;
      }
      const selectedPort = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(selectedPort);
      });
    });
  });
}
async function bootstrap() {
  const projectRoot = resolveProjectRoot(process.env.PROJECT_ROOT);
  const pluginRoot = resolvePluginRoot();
  const projectPaths = await ensureProjectDirectories(projectRoot);
  const nativeRoot = await ensureNativeRoot(pluginRoot);
  await ensureBetterSqlite3(nativeRoot);
  const vecExtensionPath = await ensureSqliteVec(nativeRoot);
  const port = await pickPort();
  const runtime = createEngineApp({
    pluginRoot,
    projectRoot,
    lockPath: projectPaths.lockPath,
    eventLogPath: projectPaths.eventLogPath,
    port,
    sqliteVecExtensionPath: vecExtensionPath,
    onSessionDrain: async () => {
      await shutdown("session-drain");
    }
  });
  let server = null;
  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo("Engine shutting down", { reason });
    if (server) {
      await closeServer(server);
    }
    runtime.close();
    await removeLockIfOwned(projectPaths.lockPath, process.pid);
    process.exit(0);
  }
  server = runtime.app.listen(port, LOOPBACK_HOST, () => {
    void writeLockMetadata(projectPaths.lockPath, {
      host: LOOPBACK_HOST,
      port,
      pid: process.pid,
      started_at: (/* @__PURE__ */ new Date()).toISOString(),
      connected_session_ids: []
    }).then(() => {
      logInfo("Engine started", {
        host: LOOPBACK_HOST,
        pid: process.pid,
        port,
        projectRoot
      });
    }).catch((error) => {
      logError("Failed to write lock metadata", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
  process.on("SIGINT", () => {
    void shutdown("sigint").catch((error) => {
      logError("Engine SIGINT shutdown failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    void shutdown("sigterm").catch((error) => {
      logError("Engine SIGTERM shutdown failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      process.exit(1);
    });
  });
}
void bootstrap().catch((error) => {
  logError("Engine bootstrap failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
//# sourceMappingURL=main.js.map
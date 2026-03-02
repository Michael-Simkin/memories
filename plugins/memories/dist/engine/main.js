// src/engine/main.ts
import net from "net";
import { promisify as promisify2 } from "util";

// src/api/app.ts
import { existsSync } from "fs";
import path2 from "path";
import express from "express";

// src/retrieval/embeddings.ts
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleAuth } from "google-auth-library";

// src/shared/constants.ts
var ENGINE_HOST = "127.0.0.1";
var DEFAULT_SEMANTIC_K = 30;
var DEFAULT_LEXICAL_K = 30;
var DEFAULT_SEARCH_LIMIT = 10;
var MEMORY_TYPES = ["fact", "rule", "decision", "episode"];
var ENGINE_LOCK_FILE = "engine.lock.json";
var MEMORY_DB_FILE = "ai_memory.db";
var OPERATION_LOG_FILE = "ai_memory_operations.log";
var HOOK_LOG_FILE = "ai_memory_hook_events.log";
var EMBEDDING_DIMENSIONS = 3072;

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

// src/retrieval/embeddings.ts
var execFileAsync = promisify(execFile);
var TOKEN_CACHE_TTL_MS = 45 * 60 * 1e3;
var TOKEN_FAILURE_BACKOFF_MS = 15 * 1e3;
var EmbeddingClient = class {
  auth;
  projectId;
  region;
  model;
  tokenCache;
  nextTokenRetryAtMs;
  constructor(model = "gemini-embedding-001") {
    this.projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? null;
    this.region = process.env.CLOUD_ML_REGION ?? null;
    this.model = model;
    this.auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      ...this.projectId ? { projectId: this.projectId } : {}
    });
    this.tokenCache = null;
    this.nextTokenRetryAtMs = 0;
  }
  isConfigured() {
    return Boolean(this.projectId && this.region);
  }
  async embed(text) {
    if (!this.projectId || !this.region) {
      return null;
    }
    const token = await this.getAccessToken();
    if (!token) {
      warn("Embedding auth unavailable: unable to acquire Google access token");
      return null;
    }
    const endpoint = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${this.model}:predict`;
    const body = {
      instances: [{ content: text, task_type: "RETRIEVAL_QUERY" }],
      parameters: { outputDimensionality: EMBEDDING_DIMENSIONS }
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errorText = await response.text();
      warn("Embedding call failed", {
        status: response.status,
        statusText: response.statusText,
        errorText
      });
      return null;
    }
    const payload = await response.json();
    const parsed = this.parseEmbedding(payload);
    if (!parsed) {
      warn("Embedding response did not contain vector");
      return null;
    }
    if (parsed.length !== EMBEDDING_DIMENSIONS) {
      warn("Embedding dimensions mismatch", {
        expected: EMBEDDING_DIMENSIONS,
        actual: parsed.length
      });
      return null;
    }
    return parsed;
  }
  parseEmbedding(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const value = payload;
    const values = value.predictions?.[0]?.embeddings?.values;
    if (!Array.isArray(values)) {
      return null;
    }
    if (!values.every((entry) => typeof entry === "number")) {
      return null;
    }
    return values;
  }
  async getAccessToken() {
    const cached = this.tokenCache;
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.token;
    }
    if (this.nextTokenRetryAtMs > Date.now()) {
      return null;
    }
    const adcToken = await this.getAccessTokenFromGoogleAuth();
    if (adcToken) {
      this.tokenCache = {
        token: adcToken,
        expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS
      };
      this.nextTokenRetryAtMs = 0;
      return adcToken;
    }
    const gcloudAdcToken = await this.getAccessTokenFromGcloud([
      "auth",
      "application-default",
      "print-access-token"
    ]);
    if (gcloudAdcToken) {
      this.tokenCache = {
        token: gcloudAdcToken,
        expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS
      };
      this.nextTokenRetryAtMs = 0;
      return gcloudAdcToken;
    }
    const gcloudUserToken = await this.getAccessTokenFromGcloud(["auth", "print-access-token"]);
    if (gcloudUserToken) {
      this.tokenCache = {
        token: gcloudUserToken,
        expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS
      };
      this.nextTokenRetryAtMs = 0;
      return gcloudUserToken;
    }
    this.nextTokenRetryAtMs = Date.now() + TOKEN_FAILURE_BACKOFF_MS;
    return null;
  }
  async getAccessTokenFromGoogleAuth() {
    try {
      const client = await this.auth.getClient();
      const accessToken = await client.getAccessToken();
      const token = accessToken.token ?? null;
      if (!token) {
        return null;
      }
      const trimmed = token.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (error2) {
      warn("GoogleAuth access token acquisition failed", {
        error: error2 instanceof Error ? error2.message : String(error2)
      });
      return null;
    }
  }
  async getAccessTokenFromGcloud(args) {
    try {
      const result = await execFileAsync("gcloud", args, {
        timeout: 2e3
      });
      const token = result.stdout.trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
};

// src/retrieval/hybrid-retrieval.ts
import picomatch from "picomatch";

// src/shared/fs-utils.ts
import { appendFile, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
async function atomicWriteJson(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(payload, null, 2)}
`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}
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
function normalizePathForMatch(inputPath) {
  const posixPath = inputPath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(posixPath);
  if (normalized === ".") {
    return "";
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}
function isErrno(error2) {
  return typeof error2 === "object" && error2 !== null && "code" in error2;
}

// src/retrieval/hybrid-retrieval.ts
function cosineSimilarity(a, b) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const ai = a[index] ?? 0;
    const bi = b[index] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
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
    const lexical = this.store.lexicalSearch({
      query: options.query,
      limit: options.lexicalK ?? DEFAULT_LEXICAL_K,
      includePinned: options.includePinned,
      ...options.memoryTypes ? { memoryTypes: options.memoryTypes } : {}
    });
    const semantic = await this.semanticSearch(options);
    return this.mergeHybrid({
      lexical,
      semantic,
      limit: options.limit
    });
  }
  async searchForPretool(input) {
    const pathMatches = this.findPathMatches(
      input.targetPaths,
      input.memoryTypes,
      input.includePinned
    );
    const hybrid = await this.search({
      query: input.query,
      limit: input.limit,
      includePinned: input.includePinned,
      ...input.memoryTypes ? { memoryTypes: input.memoryTypes } : {},
      ...typeof input.semanticK === "number" ? { semanticK: input.semanticK } : {},
      ...typeof input.lexicalK === "number" ? { lexicalK: input.lexicalK } : {}
    });
    const merged = [];
    const seen = /* @__PURE__ */ new Set();
    for (const result of pathMatches) {
      seen.add(result.id);
      merged.push(result);
      if (merged.length >= input.limit) {
        return merged;
      }
    }
    for (const result of hybrid) {
      if (seen.has(result.id)) {
        continue;
      }
      merged.push(result);
      if (merged.length >= input.limit) {
        break;
      }
    }
    return merged;
  }
  async semanticSearch(options) {
    if (!this.embeddingClient.isConfigured() || options.query.trim().length === 0) {
      return [];
    }
    const queryVector = await this.embeddingClient.embed(options.query);
    if (!queryVector) {
      return [];
    }
    const rows = this.store.listEmbeddings(options.memoryTypes, options.includePinned);
    return rows.map((row) => ({
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: row.tags,
      score: cosineSimilarity(queryVector, row.vector),
      is_pinned: row.is_pinned,
      updated_at: row.updated_at
    })).sort((a, b) => this.sortSearchResults(a, b)).slice(0, options.semanticK ?? DEFAULT_SEMANTIC_K);
  }
  findPathMatches(targetPaths, memoryTypes, includePinned) {
    const normalizedPaths = targetPaths.map((inputPath) => normalizePathForMatch(inputPath)).filter(Boolean);
    if (normalizedPaths.length === 0) {
      return [];
    }
    const matchers = this.store.listPathMatchers();
    const matchScore = /* @__PURE__ */ new Map();
    for (const matcher of matchers) {
      const matcherFn = picomatch(matcher.path_matcher);
      const isMatch = normalizedPaths.some((targetPath) => matcherFn(targetPath));
      if (!isMatch) {
        continue;
      }
      const current = matchScore.get(matcher.memory_id) ?? Number.NEGATIVE_INFINITY;
      if (matcher.priority > current) {
        matchScore.set(matcher.memory_id, matcher.priority);
      }
    }
    const ids = [...matchScore.keys()];
    if (ids.length === 0) {
      return [];
    }
    const memories = this.store.getMemoriesByIds(ids).filter((memory) => memoryTypes ? memoryTypes.includes(memory.memory_type) : true).filter((memory) => includePinned ? true : !memory.is_pinned).map((memory) => ({
      ...memory,
      score: (matchScore.get(memory.id) ?? 0) + 1e3
    }));
    memories.sort((a, b) => this.sortSearchResults(a, b));
    return memories;
  }
  mergeHybrid(input) {
    const byId = /* @__PURE__ */ new Map();
    for (const result of [...input.lexical, ...input.semantic]) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) {
        byId.set(result.id, result);
      }
    }
    return [...byId.values()].sort((a, b) => this.sortSearchResults(a, b)).slice(0, input.limit);
  }
  sortSearchResults(a, b) {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  }
};

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
async function writeLockMetadata(lockPath, payload) {
  const uniqueSessionIds = [...new Set(payload.connected_session_ids)];
  await atomicWriteJson(lockPath, {
    connected_session_ids: uniqueSessionIds,
    host: payload.host,
    pid: payload.pid,
    port: payload.port,
    started_at: payload.started_at
  });
}
async function updateConnectedSessions(lockPath, updater) {
  const current = await readLockMetadata(lockPath);
  if (!current) {
    return null;
  }
  const nextSessions = [...new Set(updater(current.connected_session_ids))].filter(Boolean);
  const next = {
    ...current,
    connected_session_ids: nextSessions
  };
  await writeLockMetadata(lockPath, next);
  return next;
}
async function removeLockIfOwned(lockPath, ownerPid) {
  const current = await readLockMetadata(lockPath);
  if (!current) {
    return;
  }
  if (current.pid !== ownerPid) {
    return;
  }
  await removeFileIfExists(lockPath);
}
function isLoopback(host) {
  return host === ENGINE_HOST || host === "localhost" || host === "::1";
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
async function readJsonLogs(path4, limit = 200) {
  try {
    const raw = await readFile2(path4, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const picked = lines.slice(Math.max(0, lines.length - limit));
    return picked.flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return [parsed];
      } catch {
        return [];
      }
    });
  } catch (error2) {
    if (isErrno2(error2) && error2.code === "ENOENT") {
      return [];
    }
    throw error2;
  }
}
function isErrno2(error2) {
  return typeof error2 === "object" && error2 !== null && "code" in error2;
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

// src/shared/token-budget.ts
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function applyTokenBudget(results, maxTokens) {
  const selected = [];
  let used = 0;
  for (const result of results) {
    const cost = estimateTokens(`${result.content} ${result.tags.join(" ")}`);
    if (selected.length > 0 && used + cost > maxTokens) {
      break;
    }
    selected.push(result);
    used += cost;
  }
  return selected;
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

// src/storage/database.ts
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { ulid } from "ulid";
var STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with"
]);
var MemoryStore = class {
  db;
  vecEnabled;
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.vecEnabled = this.tryEnableVec();
    this.initialize();
  }
  close() {
    this.db.close();
  }
  memoryCount() {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM memories").get();
    return row.count;
  }
  listMemories(limit, offset) {
    const rows = this.db.prepare(
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
    const row = this.db.prepare(
      `
          SELECT id, memory_type, content, tags_json, is_pinned, created_at, updated_at
          FROM memories
          WHERE id = ?
        `
    ).get(id);
    if (!row) {
      return null;
    }
    return this.inflateMemory(row);
  }
  getPinnedMemories() {
    const rows = this.db.prepare(
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
      tags: this.parseTags(row.tags_json),
      score: 1,
      is_pinned: row.is_pinned === 1,
      updated_at: row.updated_at
    }));
  }
  createMemory(input) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const id = ulid();
    const tagsJson = JSON.stringify(input.tags);
    this.withTransaction(() => {
      this.db.prepare(
        `
            INSERT INTO memories (id, memory_type, content, tags_json, is_pinned, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `
      ).run(id, input.memory_type, input.content, tagsJson, input.is_pinned ? 1 : 0, now, now);
      this.syncFts(id, input.content, input.tags);
      this.replacePathMatchers(id, input.path_matchers, now);
    });
    const created = this.getMemory(id);
    if (!created) {
      throw new Error("Created memory missing after transaction");
    }
    return created;
  }
  updateMemory(id, input) {
    const current = this.getMemory(id);
    if (!current) {
      return null;
    }
    const next = {
      content: input.content ?? current.content,
      is_pinned: input.is_pinned ?? current.is_pinned,
      tags: input.tags ?? current.tags,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.withTransaction(() => {
      this.db.prepare(
        `
            UPDATE memories
            SET content = ?, tags_json = ?, is_pinned = ?, updated_at = ?
            WHERE id = ?
          `
      ).run(next.content, JSON.stringify(next.tags), next.is_pinned ? 1 : 0, next.updated_at, id);
      this.syncFts(id, next.content, next.tags);
      if (input.path_matchers) {
        this.replacePathMatchers(id, input.path_matchers, next.updated_at);
      }
    });
    return this.getMemory(id);
  }
  deleteMemory(id) {
    const result = this.withTransaction(() => {
      this.db.prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?").run(id);
      this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
      if (this.vecEnabled) {
        this.db.prepare("DELETE FROM vec_memory WHERE id = ?").run(id);
      }
      return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
    });
    return result;
  }
  lexicalSearch(input) {
    const normalizedQuery = input.query.trim();
    if (normalizedQuery.length === 0) {
      const rows2 = this.db.prepare(
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
        tags: this.parseTags(row.tags_json),
        score: 0.1,
        is_pinned: row.is_pinned === 1,
        updated_at: row.updated_at
      }));
    }
    const terms = this.extractSearchTerms(normalizedQuery);
    if (terms.length === 0) {
      return [];
    }
    const candidateLimit = Math.min(Math.max(input.limit * 3, input.limit), 200);
    const rows = this.db.prepare(
      `
          SELECT m.id, m.memory_type, m.content, m.tags_json, m.is_pinned, m.created_at, m.updated_at, bm25(memory_fts) as score
          FROM memory_fts
          JOIN memories m ON m.id = memory_fts.id
          WHERE memory_fts MATCH ?
            AND (${input.includePinned ? "1=1" : "m.is_pinned = 0"})
          ORDER BY score
          LIMIT ?
        `
    ).all(this.makeFtsQueryFromTerms(terms), candidateLimit);
    const bm25Range = this.computeBm25Range(rows);
    const loweredQuery = normalizedQuery.toLowerCase();
    return rows.filter((row) => !input.memoryTypes || input.memoryTypes.includes(row.memory_type)).map((row) => {
      const tags = this.parseTags(row.tags_json);
      const searchableText = `${row.content} ${tags.join(" ")}`.toLowerCase();
      const matchedTerms = terms.reduce((count, term) => {
        return searchableText.includes(term) ? count + 1 : count;
      }, 0);
      const coverageScore = matchedTerms / terms.length;
      const bm25Score = this.normalizeBm25(row.score, bm25Range);
      const phraseBoost = loweredQuery.length >= 3 && searchableText.includes(loweredQuery) ? 0.05 : 0;
      const score = this.clamp01(0.7 * bm25Score + 0.25 * coverageScore + phraseBoost);
      return {
        id: row.id,
        memory_type: row.memory_type,
        content: row.content,
        tags,
        score,
        is_pinned: row.is_pinned === 1,
        updated_at: row.updated_at
      };
    }).sort((a, b) => b.score - a.score || Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, input.limit);
  }
  listEmbeddings(memoryTypes, includePinned = true) {
    const rows = this.db.prepare(
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
      tags: this.parseTags(row.tags_json),
      is_pinned: row.is_pinned === 1,
      updated_at: row.updated_at,
      vector: this.parseVector(row.vector_json)
    }));
  }
  upsertEmbedding(memoryId, vector) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare(
      `
          INSERT INTO memory_embeddings (memory_id, vector_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(memory_id) DO UPDATE SET vector_json = excluded.vector_json, updated_at = excluded.updated_at
        `
    ).run(memoryId, JSON.stringify(vector), now);
    if (this.vecEnabled) {
      try {
        this.db.prepare("DELETE FROM vec_memory WHERE id = ?").run(memoryId);
        this.db.prepare(
          `
              INSERT INTO vec_memory (id, vector)
              VALUES (?, ?)
            `
        ).run(memoryId, JSON.stringify(vector));
      } catch (error2) {
        warn("Failed to sync vec_memory row", {
          error: error2 instanceof Error ? error2.message : String(error2),
          memoryId
        });
      }
    }
  }
  removeEmbedding(memoryId) {
    this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
    if (this.vecEnabled) {
      this.db.prepare("DELETE FROM vec_memory WHERE id = ?").run(memoryId);
    }
  }
  listPathMatchers() {
    return this.db.prepare(
      `
          SELECT memory_id, path_matcher, priority
          FROM memory_path_matchers
          ORDER BY priority DESC
        `
    ).all();
  }
  getMemoriesByIds(ids) {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `
          SELECT id, memory_type, content, tags_json, is_pinned, updated_at
          FROM memories
          WHERE id IN (${placeholders})
        `
    ).all(...ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    return ordered.map((row) => ({
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: this.parseTags(row.tags_json),
      score: 1,
      is_pinned: row.is_pinned === 1,
      updated_at: row.updated_at
    }));
  }
  initialize() {
    this.db.exec(`
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
        priority INTEGER NOT NULL DEFAULT 100,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mpm_path_matcher ON memory_path_matchers(path_matcher);
      CREATE INDEX IF NOT EXISTS idx_mpm_memory_id ON memory_path_matchers(memory_id);
      CREATE INDEX IF NOT EXISTS idx_mpm_priority ON memory_path_matchers(priority DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mpm_unique ON memory_path_matchers(memory_id, path_matcher);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        content,
        tags_text
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    if (this.vecEnabled) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
            id TEXT PRIMARY KEY,
            vector float[3072] distance_metric=cosine
          );
        `);
      } catch (error2) {
        warn("Failed creating vec_memory virtual table", {
          error: error2 instanceof Error ? error2.message : String(error2)
        });
      }
    }
  }
  tryEnableVec() {
    try {
      loadSqliteVec(this.db);
      return true;
    } catch (error2) {
      warn("sqlite-vec extension unavailable; using JS semantic fallback", {
        error: error2 instanceof Error ? error2.message : String(error2)
      });
      return false;
    }
  }
  withTransaction(fn) {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }
  syncFts(memoryId, content, tags) {
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(memoryId);
    this.db.prepare("INSERT INTO memory_fts (id, content, tags_text) VALUES (?, ?, ?)").run(memoryId, content, tags.join(" "));
  }
  replacePathMatchers(memoryId, pathMatchers, nowIso) {
    this.db.prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?").run(memoryId);
    const insert = this.db.prepare(
      `
        INSERT INTO memory_path_matchers (id, memory_id, path_matcher, priority, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
    );
    for (const matcher of pathMatchers) {
      insert.run(ulid(), memoryId, matcher.path_matcher, matcher.priority, nowIso);
    }
  }
  inflateMemory(row) {
    const pathMatchers = this.db.prepare(
      `
          SELECT path_matcher, priority
          FROM memory_path_matchers
          WHERE memory_id = ?
          ORDER BY priority DESC, created_at DESC
        `
    ).all(row.id);
    return {
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: this.parseTags(row.tags_json),
      is_pinned: row.is_pinned === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
      path_matchers: pathMatchers.map((matcher) => ({
        path_matcher: matcher.path_matcher,
        priority: matcher.priority
      }))
    };
  }
  parseTags(raw) {
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
  parseVector(raw) {
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
  makeFtsQueryFromTerms(terms) {
    return terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
  }
  extractSearchTerms(query) {
    const rawTerms = query.toLowerCase().split(/[^a-z0-9]+/g).map((term) => term.trim()).filter((term) => term.length >= 2).filter((term) => !STOP_WORDS.has(term));
    return [...new Set(rawTerms)];
  }
  computeBm25Range(rows) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      const value = Math.abs(row.score);
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: 0, max: 0 };
    }
    return { min, max };
  }
  normalizeBm25(rawBm25, range) {
    const value = Math.abs(rawBm25);
    if (range.max <= range.min) {
      return 1;
    }
    return this.clamp01(1 - (value - range.min) / (range.max - range.min));
  }
  clamp01(value) {
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }
};

// src/api/errors.ts
function sendError(res, status, code, message) {
  return res.status(status).json({
    error: {
      code,
      message
    }
  });
}

// src/api/app.ts
function parseIntQuery(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function parsePathParam(value) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) {
    return value[0];
  }
  return null;
}
function createEngineApp(options) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const startedAtMs = Date.now();
  const store = new MemoryStore(path2.join(options.projectRoot, ".memories", "ai_memory.db"));
  const embeddings = new EmbeddingClient();
  const retrieval = new RetrievalService(store, embeddings);
  const activeSessions = /* @__PURE__ */ new Set();
  const staticUiDir = path2.join(options.pluginRoot, "web", "dist");
  if (existsSync(staticUiDir)) {
    app.use("/ui", express.static(staticUiDir));
  }
  app.get("/health", (_req, res) => {
    res.json({ host: ENGINE_HOST, ok: true, port: options.port });
  });
  app.get("/stats", async (_req, res) => {
    return res.json({
      active_sessions: activeSessions.size,
      memory_count: store.memoryCount(),
      online: true,
      uptime_ms: Date.now() - startedAtMs
    });
  });
  app.post("/sessions/connect", async (req, res) => {
    const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
    if (!sessionId) {
      return sendError(res, 400, "INVALID_SESSION_ID", "session_id is required");
    }
    activeSessions.add(sessionId);
    await updateConnectedSessions(options.lockPath, (current) => [...current, sessionId]);
    await hookLog(options.hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "sessions/connect",
      status: "ok",
      session_id: sessionId
    });
    return res.json({ connected_session_ids: [...activeSessions] });
  });
  app.post("/sessions/disconnect", async (req, res) => {
    const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
    if (!sessionId) {
      return sendError(res, 400, "INVALID_SESSION_ID", "session_id is required");
    }
    activeSessions.delete(sessionId);
    await updateConnectedSessions(
      options.lockPath,
      (current) => current.filter((value) => value !== sessionId)
    );
    await hookLog(options.hookLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      event: "sessions/disconnect",
      status: "ok",
      session_id: sessionId
    });
    if (activeSessions.size === 0) {
      void options.onSessionDrain().catch((drainError) => {
        error("onSessionDrain failed", {
          error: drainError instanceof Error ? drainError.message : String(drainError)
        });
      });
    }
    return res.json({ connected_session_ids: [...activeSessions] });
  });
  app.get("/memories/pinned", (_req, res) => {
    const started = Date.now();
    const results = store.getPinnedMemories();
    return res.json({
      meta: {
        duration_ms: Date.now() - started,
        query: "session-start:pinned",
        returned: results.length,
        source: "engine:/memories/pinned"
      },
      results
    });
  });
  app.post("/retrieval/pretool", async (req, res) => {
    const parsed = retrievalPretoolSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_PAYLOAD", parsed.error.message);
    }
    const started = Date.now();
    const results = await retrieval.searchForPretool({
      query: parsed.data.query,
      targetPaths: parsed.data.target_paths,
      limit: DEFAULT_SEARCH_LIMIT,
      includePinned: true,
      lexicalK: 30,
      semanticK: 30
    });
    const bounded = applyTokenBudget(results, parsed.data.max_tokens);
    const durationMs = Date.now() - started;
    const markdown = formatMemoryRecallMarkdown({
      query: parsed.data.query || `paths:${parsed.data.target_paths.join(",") || "none"}`,
      results: bounded,
      durationMs,
      source: "engine:/retrieval/pretool"
    });
    return res.json({
      markdown,
      meta: {
        duration_ms: durationMs,
        query: parsed.data.query,
        returned: bounded.length,
        source: "engine:/retrieval/pretool"
      },
      results: bounded
    });
  });
  app.post("/memories/search", async (req, res) => {
    const parsed = searchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_PAYLOAD", parsed.error.message);
    }
    const started = Date.now();
    const results = await retrieval.search({
      query: parsed.data.query,
      limit: parsed.data.limit,
      includePinned: parsed.data.include_pinned,
      lexicalK: 30,
      semanticK: 30,
      ...parsed.data.memory_types ? { memoryTypes: parsed.data.memory_types } : {}
    });
    return res.json({
      meta: {
        duration_ms: Date.now() - started,
        query: parsed.data.query,
        returned: results.length,
        source: "engine:/memories/search"
      },
      results
    });
  });
  app.post("/memories/add", async (req, res) => {
    const parsed = addMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_PAYLOAD", parsed.error.message);
    }
    const memory = store.createMemory(parsed.data);
    if (embeddings.isConfigured()) {
      const vector = await embeddings.embed(memory.content);
      if (vector) {
        store.upsertEmbedding(memory.id, vector);
      } else {
        warn("Semantic embedding skipped for memory", { memoryId: memory.id });
      }
    }
    await appendOperationLog(options.operationLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      op: "memory/create",
      status: "ok",
      memory_id: memory.id,
      data: { memory_type: memory.memory_type, is_pinned: memory.is_pinned }
    });
    return res.status(201).json({ memory });
  });
  app.get("/memories", (req, res) => {
    const limit = parseIntQuery(req.query.limit, 50);
    const offset = parseIntQuery(req.query.offset, 0);
    const records = store.listMemories(limit, offset);
    return res.json({
      items: records,
      total: store.memoryCount()
    });
  });
  app.patch("/memories/:id", async (req, res) => {
    const id = parsePathParam(req.params.id);
    if (!id) {
      return sendError(res, 400, "INVALID_MEMORY_ID", "Memory id path param is required");
    }
    const parsed = updateMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_PAYLOAD", parsed.error.message);
    }
    const updated = store.updateMemory(id, parsed.data);
    if (!updated) {
      return sendError(res, 404, "NOT_FOUND", `Memory ${id} was not found`);
    }
    if (parsed.data.content && embeddings.isConfigured()) {
      const vector = await embeddings.embed(parsed.data.content);
      if (vector) {
        store.upsertEmbedding(updated.id, vector);
      }
    }
    await appendOperationLog(options.operationLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      op: "memory/update",
      status: "ok",
      memory_id: updated.id
    });
    return res.json({ memory: updated });
  });
  app.delete("/memories/:id", async (req, res) => {
    const id = parsePathParam(req.params.id);
    if (!id) {
      return sendError(res, 400, "INVALID_MEMORY_ID", "Memory id path param is required");
    }
    const deleted = store.deleteMemory(id);
    if (!deleted) {
      return sendError(res, 404, "NOT_FOUND", `Memory ${id} was not found`);
    }
    await appendOperationLog(options.operationLogPath, {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      op: "memory/delete",
      status: "ok",
      memory_id: id
    });
    return res.json({ deleted: true, id });
  });
  app.get("/logs/operations", async (req, res) => {
    const limit = parseIntQuery(req.query.limit, 200);
    const logs = await readJsonLogs(options.operationLogPath, limit);
    return res.json({ items: logs });
  });
  app.get("/logs/hooks", async (req, res) => {
    const limit = parseIntQuery(req.query.limit, 200);
    const logs = await readJsonLogs(options.hookLogPath, limit);
    return res.json({ items: logs });
  });
  if (existsSync(staticUiDir)) {
    app.get("{*path}", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/memories") || req.path.startsWith("/logs")) {
        return next();
      }
      const indexPath = path2.join(staticUiDir, "index.html");
      return res.sendFile(indexPath);
    });
  }
  app.use((err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : "Unknown error";
    return sendError(res, 500, "INTERNAL_ERROR", message);
  });
  return {
    app,
    getSessionCount: () => activeSessions.size
  };
}

// src/shared/paths.ts
import { mkdir } from "fs/promises";
import path3 from "path";
function resolveProjectRoot(explicitProjectRoot) {
  if (explicitProjectRoot && path3.isAbsolute(explicitProjectRoot)) {
    return explicitProjectRoot;
  }
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envRoot && path3.isAbsolute(envRoot)) {
    return envRoot;
  }
  return process.cwd();
}
function resolvePluginRoot() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot && path3.isAbsolute(pluginRoot)) {
    return pluginRoot;
  }
  return process.cwd();
}
function getProjectPaths(projectRoot) {
  const memoriesDir = path3.join(projectRoot, ".memories");
  return {
    projectRoot,
    memoriesDir,
    dbPath: path3.join(memoriesDir, MEMORY_DB_FILE),
    hookLogPath: path3.join(memoriesDir, HOOK_LOG_FILE),
    lockPath: path3.join(memoriesDir, ENGINE_LOCK_FILE),
    operationLogPath: path3.join(memoriesDir, OPERATION_LOG_FILE)
  };
}
async function ensureProjectDirectories(projectRoot) {
  const projectPaths = getProjectPaths(projectRoot);
  await mkdir(projectPaths.memoriesDir, { recursive: true });
  return projectPaths;
}

// src/engine/main.ts
var closeServer = promisify2((server, callback) => {
  server.close(callback);
});
async function pickPort() {
  const fromEnv = process.env.MEMORIES_ENGINE_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err) => reject(err));
    server.listen(0, ENGINE_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate engine port")));
        return;
      }
      const port = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}
async function bootstrap() {
  const projectRoot = resolveProjectRoot(process.env.PROJECT_ROOT);
  const pluginRoot = resolvePluginRoot();
  const paths = await ensureProjectDirectories(projectRoot);
  const port = await pickPort();
  let server = null;
  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    info("Engine shutting down", { reason });
    if (server) {
      await closeServer(server);
    }
    await removeLockIfOwned(paths.lockPath, process.pid);
    process.exit(0);
  }
  const runtime = createEngineApp({
    pluginRoot,
    projectRoot,
    lockPath: paths.lockPath,
    operationLogPath: paths.operationLogPath,
    hookLogPath: paths.hookLogPath,
    port,
    onSessionDrain: async () => {
      await shutdown("session-drain");
    }
  });
  server = runtime.app.listen(port, ENGINE_HOST, () => {
    void writeLockMetadata(paths.lockPath, {
      connected_session_ids: [],
      host: ENGINE_HOST,
      pid: process.pid,
      port,
      started_at: (/* @__PURE__ */ new Date()).toISOString()
    }).then(() => {
      info("Engine started", { host: ENGINE_HOST, pid: process.pid, port, projectRoot });
    }).catch((lockError) => {
      error("Failed to write engine lock file", {
        error: lockError instanceof Error ? lockError.message : String(lockError)
      });
    });
  });
  process.on("SIGINT", () => {
    void shutdown("sigint").catch((shutdownError) => {
      error("Engine failed on SIGINT shutdown", {
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
      });
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    void shutdown("sigterm").catch((shutdownError) => {
      error("Engine failed on SIGTERM shutdown", {
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
      });
      process.exit(1);
    });
  });
}
void bootstrap().catch((bootstrapError) => {
  error("Engine bootstrap failed", {
    error: bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError)
  });
  process.exit(1);
});
//# sourceMappingURL=main.js.map
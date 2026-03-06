import { createRequire } from 'node:module';
import path from 'node:path';

import { ulid } from 'ulid';

import { logWarn } from '../shared/logger.js';
import type {
  AddMemoryInput,
  MemoryRecord,
  MemoryType,
  PathMatcherInput,
  SearchResult,
  UpdateMemoryInput,
} from '../shared/types.js';

interface StatementRunResult {
  changes: number;
}

interface SqliteStatement<TRow = Record<string, unknown>> {
  all(...params: unknown[]): TRow[];
  get(...params: unknown[]): TRow | undefined;
  run(...params: unknown[]): StatementRunResult;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  loadExtension(path: string): void;
  pragma(command: string): unknown;
  prepare<TRow = Record<string, unknown>>(sql: string): SqliteStatement<TRow>;
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
}

type BetterSqlite3Constructor = new (
  filename: string,
  options?: {
    timeout?: number;
  },
) => SqliteDatabase;

interface MemoryRow {
  id: string;
  memory_type: MemoryType;
  content: string;
  tags_json: string;
  is_pinned: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface MatcherRow {
  path_matcher: string;
}

interface EmbeddingRow {
  memory_id: string;
  vector_json: string;
  updated_at: string;
}

interface LexicalRow extends MemoryRow {
  score: number;
}

interface MemoryPathMatcherRow {
  memory_id: string;
  path_matcher: string;
}

function loadBetterSqlite3(pluginRoot: string): BetterSqlite3Constructor {
  const nativeRoot = path.join(pluginRoot, 'native');
  const requireFromStorage = createRequire(import.meta.url);

  let resolvedPath: string;
  try {
    resolvedPath = requireFromStorage.resolve('better-sqlite3', { paths: [nativeRoot] });
  } catch (error) {
    throw new Error(
      `better-sqlite3 is missing from runtime native dependencies at ${nativeRoot}. ` +
        `Run engine startup to install dependencies. ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }

  const loaded = requireFromStorage(resolvedPath) as unknown;
  const constructor = (
    typeof loaded === 'object' &&
    loaded !== null &&
    'default' in loaded &&
    typeof (loaded as { default: unknown }).default === 'function'
      ? (loaded as { default: unknown }).default
      : loaded
  ) as BetterSqlite3Constructor;

  if (typeof constructor !== 'function') {
    throw new Error(`better-sqlite3 resolved at ${resolvedPath} but did not export a constructor`);
  }

  return constructor;
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function parseVector(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is number => typeof value === 'number');
  } catch {
    return [];
  }
}

function normalizeMatchers(matchers: PathMatcherInput[]): PathMatcherInput[] {
  const seen = new Set<string>();
  const normalized: PathMatcherInput[] = [];

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

function extractTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set(terms)];
}

function makeTagFtsQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '')}"`).join(' OR ');
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function normalizeBm25(value: number, range: { min: number; max: number }): number {
  const magnitude = Math.abs(value);
  if (range.max <= range.min) {
    return 1;
  }
  return clamp01(1 - (magnitude - range.min) / (range.max - range.min));
}

function computeBm25Range(rows: LexicalRow[]): { min: number; max: number } {
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

export interface MemoryStoreOptions {
  dbPath: string;
  pluginRoot: string;
  sqliteVecExtensionPath?: string | null;
  embeddingDimensions: number;
}

export class MemoryStore {
  private readonly database: SqliteDatabase;
  private readonly vecEnabled: boolean;
  private readonly embeddingDimensions: number;

  public constructor(options: MemoryStoreOptions) {
    this.embeddingDimensions = options.embeddingDimensions;
    const BetterSqlite3 = loadBetterSqlite3(options.pluginRoot);

    this.database = new BetterSqlite3(options.dbPath, {
      timeout: 5000,
    });
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('journal_mode = WAL');

    this.initializeSchema();
    this.vecEnabled = this.tryEnableVec(options.sqliteVecExtensionPath ?? null);
    this.initializeVecSchemaIfEnabled();
  }

  public close(): void {
    this.database.close();
  }

  public memoryCount(): number {
    const row = this.database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM memories').get();
    return row?.count ?? 0;
  }

  public listMemories(limit: number, offset: number): MemoryRecord[] {
    const rows = this.database
      .prepare<MemoryRow>(
        `
          SELECT id, memory_type, content, tags_json, is_pinned, created_at, updated_at
          FROM memories
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(limit, offset);
    return rows.map((row) => this.inflateMemory(row));
  }

  public getMemory(id: string): MemoryRecord | null {
    const row = this.database
      .prepare<MemoryRow>(
        `
          SELECT id, memory_type, content, tags_json, is_pinned, created_at, updated_at
          FROM memories
          WHERE id = ?
        `,
      )
      .get(id);

    return row ? this.inflateMemory(row) : null;
  }

  public getPinnedMemories(): SearchResult[] {
    const rows = this.database
      .prepare<Pick<MemoryRow, 'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'>>(
        `
          SELECT id, memory_type, content, tags_json, is_pinned, updated_at
          FROM memories
          WHERE is_pinned = 1
          ORDER BY updated_at DESC
        `,
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: parseTags(row.tags_json),
      is_pinned: row.is_pinned === 1,
      path_matchers: this.getPathMatchersByMemoryId(row.id),
      score: 1,
      source: 'hybrid',
      updated_at: row.updated_at,
    }));
  }

  public createMemory(input: AddMemoryInput, embeddingVector?: number[] | null): MemoryRecord {
    const now = new Date().toISOString();
    const memoryId = ulid();
    const normalizedTags = input.tags.map((tag) => tag.trim()).filter(Boolean);
    const normalizedMatchers = normalizeMatchers(input.path_matchers);

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `
            INSERT INTO memories (id, memory_type, content, tags_json, is_pinned, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          memoryId,
          input.memory_type,
          input.content,
          JSON.stringify(normalizedTags),
          input.is_pinned ? 1 : 0,
          now,
          now,
        );

      this.syncFts(memoryId, normalizedTags);
      this.replacePathMatchers(memoryId, normalizedMatchers, now);
      this.syncEmbedding(memoryId, embeddingVector, now);
    });
    transaction();

    const created = this.getMemory(memoryId);
    if (!created) {
      throw new Error('Memory was not found after create transaction');
    }
    return created;
  }

  public updateMemory(
    memoryId: string,
    updates: UpdateMemoryInput,
    embeddingVector?: number[] | null,
  ): MemoryRecord | null {
    const current = this.getMemory(memoryId);
    if (!current) {
      return null;
    }

    const nextContent = updates.content ?? current.content;
    const nextTags =
      updates.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [...current.tags.map((tag) => tag.trim())];
    const nextPinned = updates.is_pinned ?? current.is_pinned;
    const now = new Date().toISOString();

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `
            UPDATE memories
            SET content = ?, tags_json = ?, is_pinned = ?, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(nextContent, JSON.stringify(nextTags), nextPinned ? 1 : 0, now, memoryId);

      this.syncFts(memoryId, nextTags);
      if (updates.path_matchers) {
        this.replacePathMatchers(memoryId, normalizeMatchers(updates.path_matchers), now);
      }
      this.syncEmbedding(memoryId, embeddingVector, now);
    });
    transaction();

    return this.getMemory(memoryId);
  }

  public deleteMemory(memoryId: string): boolean {
    const transaction = this.database.transaction(() => {
      this.database.prepare('DELETE FROM memory_path_matchers WHERE memory_id = ?').run(memoryId);
      this.database.prepare('DELETE FROM memory_fts WHERE id = ?').run(memoryId);
      this.database.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
      if (this.vecEnabled) {
        this.database.prepare('DELETE FROM vec_memory WHERE id = ?').run(memoryId);
      }
      return this.database.prepare('DELETE FROM memories WHERE id = ?').run(memoryId).changes > 0;
    });
    return transaction();
  }

  public lexicalSearch(input: {
    query: string;
    limit: number;
    memoryTypes?: MemoryType[];
    includePinned: boolean;
  }): SearchResult[] {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      const rows = this.database
        .prepare<
          Pick<MemoryRow, 'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'>
        >(
          `
            SELECT id, memory_type, content, tags_json, is_pinned, updated_at
            FROM memories
            WHERE (${input.includePinned ? '1=1' : 'is_pinned = 0'})
            ORDER BY updated_at DESC
            LIMIT ?
          `,
        )
        .all(input.limit);

      return rows
        .filter((row) => !input.memoryTypes || input.memoryTypes.includes(row.memory_type))
        .map((row) => ({
          id: row.id,
          memory_type: row.memory_type,
          content: row.content,
          tags: parseTags(row.tags_json),
          is_pinned: row.is_pinned === 1,
          path_matchers: this.getPathMatchersByMemoryId(row.id),
          score: 0.1,
          source: 'hybrid' as const,
          updated_at: row.updated_at,
        }));
    }

    const terms = extractTerms(trimmedQuery);
    if (terms.length === 0) {
      return [];
    }

    const candidateLimit = Math.min(Math.max(input.limit * 3, input.limit), 200);
    const rows = this.database
      .prepare<LexicalRow>(
        `
          SELECT m.id, m.memory_type, m.content, m.tags_json, m.is_pinned, m.created_at, m.updated_at, bm25(memory_fts) AS score
          FROM memory_fts
          JOIN memories m ON m.id = memory_fts.id
          WHERE memory_fts MATCH ?
            AND (${input.includePinned ? '1=1' : 'm.is_pinned = 0'})
          ORDER BY score
          LIMIT ?
        `,
      )
      .all(makeTagFtsQuery(terms), candidateLimit);

    const bm25Range = computeBm25Range(rows);

    return rows
      .filter((row) => !input.memoryTypes || input.memoryTypes.includes(row.memory_type))
      .map((row) => {
        const tags = parseTags(row.tags_json);
        const loweredTags = tags.join(' ').toLowerCase();
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
          source: 'hybrid' as const,
          updated_at: row.updated_at,
        };
      })
      .sort((left, right) => right.score - left.score || right.updated_at.localeCompare(left.updated_at))
      .slice(0, input.limit);
  }

  public listEmbeddings(
    memoryTypes?: MemoryType[],
    includePinned = true,
  ): Array<{
    id: string;
    memory_type: MemoryType;
    content: string;
    tags: string[];
    is_pinned: boolean;
    updated_at: string;
    vector: number[];
  }> {
    const rows = this.database
      .prepare<
        EmbeddingRow & Pick<MemoryRow, 'memory_type' | 'content' | 'tags_json' | 'is_pinned'>
      >(
        `
          SELECT e.memory_id, e.vector_json, e.updated_at,
                 m.memory_type, m.content, m.tags_json, m.is_pinned
          FROM memory_embeddings e
          JOIN memories m ON m.id = e.memory_id
          WHERE (${includePinned ? '1=1' : 'm.is_pinned = 0'})
        `,
      )
      .all();

    return rows
      .filter((row) => !memoryTypes || memoryTypes.includes(row.memory_type))
      .map((row) => ({
        id: row.memory_id,
        memory_type: row.memory_type,
        content: row.content,
        tags: parseTags(row.tags_json),
        is_pinned: row.is_pinned === 1,
        updated_at: row.updated_at,
        vector: parseVector(row.vector_json),
      }));
  }

  public upsertEmbedding(memoryId: string, vector: number[]): void {
    const now = new Date().toISOString();
    this.syncEmbedding(memoryId, vector, now);
  }

  public removeEmbedding(memoryId: string): void {
    this.syncEmbedding(memoryId, null, new Date().toISOString());
  }

  public listPathMatchers(): MemoryPathMatcherRow[] {
    return this.database
      .prepare<MemoryPathMatcherRow>(
        `
          SELECT memory_id, path_matcher
          FROM memory_path_matchers
          ORDER BY created_at DESC
        `,
      )
      .all();
  }

  public getMemoriesByIds(ids: string[]): SearchResult[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.database
      .prepare<
        Pick<MemoryRow, 'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'>
      >(
        `
          SELECT id, memory_type, content, tags_json, is_pinned, updated_at
          FROM memories
          WHERE id IN (${placeholders})
        `,
      )
      .all(...ids);

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
          source: 'hybrid' as const,
          updated_at: row.updated_at,
        },
      ];
    });
  }

  private initializeSchema(): void {
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

  private initializeVecSchemaIfEnabled(): void {
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
      logWarn('Failed creating vec_memory virtual table; fallback to JSON vectors only', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private tryEnableVec(extensionPath: string | null): boolean {
    if (!extensionPath) {
      return false;
    }
    try {
      this.database.loadExtension(extensionPath);
      return true;
    } catch (error) {
      logWarn('sqlite-vec extension failed to load; continuing without vec table', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private inflateMemory(row: MemoryRow): MemoryRecord {
    return {
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: parseTags(row.tags_json),
      is_pinned: row.is_pinned === 1,
      path_matchers: this.getPathMatchersByMemoryId(row.id).map((pathMatcher) => ({
        path_matcher: pathMatcher,
      })),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private getPathMatchersByMemoryId(memoryId: string): string[] {
    const rows = this.database
      .prepare<MatcherRow>(
        `
          SELECT path_matcher
          FROM memory_path_matchers
          WHERE memory_id = ?
          ORDER BY created_at DESC
        `,
      )
      .all(memoryId);
    return rows.map((row) => row.path_matcher);
  }

  private syncFts(memoryId: string, tags: string[]): void {
    this.database.prepare('DELETE FROM memory_fts WHERE id = ?').run(memoryId);
    this.database
      .prepare('INSERT INTO memory_fts (id, tags_text) VALUES (?, ?)')
      .run(memoryId, tags.join(' '));
  }

  private replacePathMatchers(memoryId: string, pathMatchers: PathMatcherInput[], createdAt: string): void {
    this.database.prepare('DELETE FROM memory_path_matchers WHERE memory_id = ?').run(memoryId);
    if (pathMatchers.length === 0) {
      return;
    }

    const insertStatement = this.database.prepare(
      `
        INSERT INTO memory_path_matchers (id, memory_id, path_matcher, created_at)
        VALUES (?, ?, ?, ?)
      `,
    );
    for (const matcher of pathMatchers) {
      insertStatement.run(ulid(), memoryId, matcher.path_matcher, createdAt);
    }
  }

  private syncEmbedding(memoryId: string, vector: number[] | null | undefined, updatedAt: string): void {
    if (vector === undefined) {
      return;
    }

    if (vector === null) {
      this.database.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
      if (this.vecEnabled) {
        this.database.prepare('DELETE FROM vec_memory WHERE id = ?').run(memoryId);
      }
      return;
    }

    this.database
      .prepare(
        `
          INSERT INTO memory_embeddings (memory_id, vector_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(memory_id) DO UPDATE SET
            vector_json = excluded.vector_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(memoryId, JSON.stringify(vector), updatedAt);

    if (!this.vecEnabled) {
      return;
    }
    if (vector.length !== this.embeddingDimensions) {
      logWarn('Skipping vec_memory sync because embedding dimensions mismatch', {
        actual: vector.length,
        expected: this.embeddingDimensions,
        memoryId,
      });
      return;
    }

    try {
      this.database.prepare('DELETE FROM vec_memory WHERE id = ?').run(memoryId);
      this.database
        .prepare(
          `
            INSERT INTO vec_memory (id, vector)
            VALUES (?, ?)
          `,
        )
        .run(memoryId, JSON.stringify(vector));
    } catch (error) {
      logWarn('Failed syncing vec_memory row; keeping JSON embedding row', {
        error: error instanceof Error ? error.message : String(error),
        memoryId,
      });
    }
  }
}

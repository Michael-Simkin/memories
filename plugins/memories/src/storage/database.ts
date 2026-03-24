import { DatabaseSync } from 'node:sqlite';

import { ulid } from 'ulid';

import { MIN_LEXICAL_SCORE } from '../shared/constants.js';
import { logWarn } from '../shared/logger.js';
import type {
  AddMemoryInput,
  MemoryRecord,
  MemoryType,
  PathMatcherInput,
  SearchMatchSource,
  SearchResult,
  UpdateMemoryInput,
} from '../shared/types.js';

interface MemoryRow {
  id: string;
  repo_id: string;
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
  sqliteVecExtensionPath?: string | null;
  embeddingDimensions: number;
}

interface TableColumnInfo {
  name: string;
}

export class MemoryStore {
  private readonly database: DatabaseSync;
  private readonly vecEnabled: boolean;
  private readonly embeddingDimensions: number;

  public constructor(options: MemoryStoreOptions) {
    this.embeddingDimensions = options.embeddingDimensions;

    this.database = new DatabaseSync(options.dbPath, {
      allowExtension: true,
      enableForeignKeyConstraints: true,
    });
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA busy_timeout = 5000');

    this.initializeSchema();
    this.migrateRepoId();
    this.vecEnabled = this.tryEnableVec(options.sqliteVecExtensionPath ?? null);
    this.initializeVecSchemaIfEnabled();
  }

  public close(): void {
    this.database.close();
  }

  public memoryCount(repoId: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM memories WHERE repo_id = ?')
      .get(repoId) as unknown as { count: number } | undefined;
    return row?.count ?? 0;
  }

  public listMemories(repoId: string, limit: number, offset: number): MemoryRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, repo_id, memory_type, content, tags_json, is_pinned, created_at, updated_at
         FROM memories WHERE repo_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(repoId, limit, offset) as unknown as MemoryRow[];
    return rows.map((row) => this.inflateMemory(row));
  }

  public getMemory(repoId: string, id: string): MemoryRecord | null {
    const row = this.database
      .prepare(
        `
          SELECT id, repo_id, memory_type, content, tags_json, is_pinned, created_at, updated_at
          FROM memories
          WHERE id = ? AND repo_id = ?
        `,
      )
      .get(id, repoId) as unknown as MemoryRow | undefined;

    return row ? this.inflateMemory(row) : null;
  }

  public getPinnedMemories(repoId: string): SearchResult[] {
    const rows = this.database
      .prepare(
        `SELECT id, memory_type, content, tags_json, is_pinned, updated_at
         FROM memories WHERE is_pinned = 1 AND repo_id = ? ORDER BY updated_at DESC`,
      )
      .all(repoId) as unknown as Pick<
      MemoryRow,
      'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'
    >[];

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

  public createMemory(
    repoId: string,
    input: AddMemoryInput,
    embeddingVector?: number[] | null,
  ): MemoryRecord {
    const now = new Date().toISOString();
    const memoryId = ulid();
    const normalizedTags = input.tags.map((tag) => tag.trim()).filter(Boolean);
    const normalizedMatchers = normalizeMatchers(input.path_matchers);

    this.database.exec('BEGIN');
    try {
      this.database
        .prepare(
          `INSERT INTO memories (id, repo_id, memory_type, content, tags_json, is_pinned, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memoryId,
          repoId,
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
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    const created = this.getMemory(repoId, memoryId);
    if (!created) {
      throw new Error('Memory was not found after create transaction');
    }
    return created;
  }

  public updateMemory(
    repoId: string,
    memoryId: string,
    updates: UpdateMemoryInput,
    embeddingVector?: number[] | null,
  ): MemoryRecord | null {
    const current = this.getMemory(repoId, memoryId);
    if (!current) {
      return null;
    }

    const nextContent = updates.content ?? current.content;
    const nextTags = updates.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [
      ...current.tags.map((tag) => tag.trim()),
    ];
    const nextPinned = updates.is_pinned ?? current.is_pinned;
    const now = new Date().toISOString();

    this.database.exec('BEGIN');
    try {
      this.database
        .prepare(
          'UPDATE memories SET content = ?, tags_json = ?, is_pinned = ?, updated_at = ? WHERE id = ? AND repo_id = ?',
        )
        .run(nextContent, JSON.stringify(nextTags), nextPinned ? 1 : 0, now, memoryId, repoId);

      this.syncFts(memoryId, nextTags);
      if (updates.path_matchers) {
        this.replacePathMatchers(memoryId, normalizeMatchers(updates.path_matchers), now);
      }
      this.syncEmbedding(memoryId, embeddingVector, now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return this.getMemory(repoId, memoryId);
  }

  public deleteMemory(repoId: string, memoryId: string): boolean {
    this.database.exec('BEGIN');
    try {
      const result = this.database
        .prepare('DELETE FROM memories WHERE id = ? AND repo_id = ?')
        .run(memoryId, repoId);
      if (result.changes === 0) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.database.prepare('DELETE FROM memory_fts WHERE id = ?').run(memoryId);
      if (this.vecEnabled) {
        this.database.prepare('DELETE FROM vec_memory WHERE id = ?').run(memoryId);
      }
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public lexicalSearch(
    repoId: string,
    input: {
      query: string;
      limit: number;
      memoryTypes?: MemoryType[];
      includePinned: boolean;
    },
  ): SearchResult[] {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      const rows = this.database
        .prepare(
          `SELECT id, memory_type, content, tags_json, is_pinned, updated_at
           FROM memories
           WHERE repo_id = ? AND (${input.includePinned ? '1=1' : 'is_pinned = 0'})
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(repoId, input.limit) as unknown as Pick<
        MemoryRow,
        'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'
      >[];

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
          matched_by: ['lexical'] as SearchMatchSource[],
          lexical_score: 0.1,
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
      .prepare(
        `SELECT m.id, m.repo_id, m.memory_type, m.content, m.tags_json, m.is_pinned, m.created_at, m.updated_at, bm25(memory_fts) AS score
         FROM memory_fts
         JOIN memories m ON m.id = memory_fts.id
         WHERE memory_fts MATCH ?
           AND m.repo_id = ?
           AND (${input.includePinned ? '1=1' : 'm.is_pinned = 0'})
         ORDER BY score
         LIMIT ?`,
      )
      .all(makeTagFtsQuery(terms), repoId, candidateLimit) as unknown as LexicalRow[];

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
          matched_by: ['lexical'] as SearchMatchSource[],
          lexical_score: score,
          source: 'hybrid' as const,
          updated_at: row.updated_at,
        };
      })
      .filter((row) => row.score >= MIN_LEXICAL_SCORE)
      .sort(
        (left, right) =>
          right.score - left.score || right.updated_at.localeCompare(left.updated_at),
      )
      .slice(0, input.limit);
  }

  public listEmbeddings(
    repoId: string,
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
      .prepare(
        `SELECT e.memory_id, e.vector_json, e.updated_at,
                m.memory_type, m.content, m.tags_json, m.is_pinned
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
         WHERE m.repo_id = ? AND (${includePinned ? '1=1' : 'm.is_pinned = 0'})`,
      )
      .all(repoId) as unknown as (EmbeddingRow &
      Pick<MemoryRow, 'memory_type' | 'content' | 'tags_json' | 'is_pinned'>)[];

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
    this.syncEmbedding(memoryId, vector, new Date().toISOString());
  }

  public removeEmbedding(memoryId: string): void {
    this.syncEmbedding(memoryId, null, new Date().toISOString());
  }

  public listPathMatchers(repoId: string): MemoryPathMatcherRow[] {
    return this.database
      .prepare(
        `SELECT pm.memory_id, pm.path_matcher
         FROM memory_path_matchers pm
         JOIN memories m ON m.id = pm.memory_id
         WHERE m.repo_id = ?
         ORDER BY pm.created_at DESC`,
      )
      .all(repoId) as unknown as MemoryPathMatcherRow[];
  }

  public getMemoriesByIds(repoId: string, ids: string[]): SearchResult[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.database
      .prepare(
        `SELECT id, memory_type, content, tags_json, is_pinned, updated_at
         FROM memories
         WHERE id IN (${placeholders}) AND repo_id = ?`,
      )
      .all(...ids, repoId) as unknown as Pick<
      MemoryRow,
      'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'
    >[];

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

  public listRepos(): Array<{ repo_id: string; label: string }> {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT m.repo_id, COALESCE(rl.label, m.repo_id) AS label
         FROM memories m
         LEFT JOIN repo_labels rl ON rl.repo_id = m.repo_id
         ORDER BY rl.label, m.repo_id`,
      )
      .all() as unknown as { repo_id: string; label: string }[];
    return rows;
  }

  public upsertRepoLabel(repoId: string, label: string): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO repo_labels (repo_id, label, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
      )
      .run(repoId, label, now);
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL DEFAULT '',
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (memory_type IN ('guide', 'context')),
        CHECK (json_valid(tags_json)),
        CHECK (is_pinned IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS idx_memories_repo_id ON memories(repo_id);
      CREATE TABLE IF NOT EXISTS memory_path_matchers (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        path_matcher TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mpm_unique ON memory_path_matchers(memory_id, path_matcher);
      CREATE INDEX IF NOT EXISTS idx_mpm_memory_id ON memory_path_matchers(memory_id);
      CREATE INDEX IF NOT EXISTS idx_mpm_path_matcher ON memory_path_matchers(path_matcher);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, tags_text);
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_labels (
        repo_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private migrateRepoId(): void {
    const columns = this.database
      .prepare('PRAGMA table_info(memories)')
      .all() as unknown as TableColumnInfo[];
    if (!columns.some((col) => col.name === 'repo_id')) {
      this.database.exec(`ALTER TABLE memories ADD COLUMN repo_id TEXT NOT NULL DEFAULT ''`);
      this.database.exec(`CREATE INDEX IF NOT EXISTS idx_memories_repo_id ON memories(repo_id)`);
    }
  }

  private initializeVecSchemaIfEnabled(): void {
    if (!this.vecEnabled) return;
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
    if (!extensionPath) return false;
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
      .prepare(
        'SELECT path_matcher FROM memory_path_matchers WHERE memory_id = ? ORDER BY created_at DESC',
      )
      .all(memoryId) as unknown as MatcherRow[];
    return rows.map((row) => row.path_matcher);
  }

  private syncFts(memoryId: string, tags: string[]): void {
    this.database.prepare('DELETE FROM memory_fts WHERE id = ?').run(memoryId);
    this.database
      .prepare('INSERT INTO memory_fts (id, tags_text) VALUES (?, ?)')
      .run(memoryId, tags.join(' '));
  }

  private replacePathMatchers(
    memoryId: string,
    pathMatchers: PathMatcherInput[],
    createdAt: string,
  ): void {
    this.database.prepare('DELETE FROM memory_path_matchers WHERE memory_id = ?').run(memoryId);
    if (pathMatchers.length === 0) return;
    const stmt = this.database.prepare(
      'INSERT INTO memory_path_matchers (id, memory_id, path_matcher, created_at) VALUES (?, ?, ?, ?)',
    );
    for (const matcher of pathMatchers) {
      stmt.run(ulid(), memoryId, matcher.path_matcher, createdAt);
    }
  }

  private syncEmbedding(
    memoryId: string,
    vector: number[] | null | undefined,
    updatedAt: string,
  ): void {
    if (vector === undefined) return;
    if (vector === null) {
      this.database.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
      if (this.vecEnabled) {
        this.database.prepare('DELETE FROM vec_memory WHERE id = ?').run(memoryId);
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO memory_embeddings (memory_id, vector_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
      )
      .run(memoryId, JSON.stringify(vector), updatedAt);
    if (!this.vecEnabled) return;
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
        .prepare('INSERT INTO vec_memory (id, vector) VALUES (?, ?)')
        .run(memoryId, JSON.stringify(vector));
    } catch (error) {
      logWarn('Failed syncing vec_memory row; keeping JSON embedding row', {
        error: error instanceof Error ? error.message : String(error),
        memoryId,
      });
    }
  }
}

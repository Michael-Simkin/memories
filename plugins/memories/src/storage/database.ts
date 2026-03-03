import { DatabaseSync } from 'node:sqlite';

import { ulid } from 'ulid';

import { EMBEDDING_DIMENSIONS } from '../shared/constants.js';
import { warn } from '../shared/logger.js';
import type {
  AddMemoryInput,
  MemoryRecord,
  MemoryType,
  PathMatcherInput,
  SearchResult,
  UpdateMemoryInput,
} from '../shared/types.js';

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

const STOP_WORDS = new Set<string>([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly vecEnabled: boolean;

  public constructor(dbPath: string, vecExtensionPath?: string | null) {
    this.db = new DatabaseSync(dbPath, {
      allowExtension: true,
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.vecEnabled = this.tryEnableVec(vecExtensionPath ?? null);
    this.initialize();
  }

  public close(): void {
    this.db.close();
  }

  public memoryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM memories').get() as unknown as {
      count: number;
    };
    return row.count;
  }

  public listMemories(limit: number, offset: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, memory_type, content, tags_json, is_pinned, created_at, updated_at
          FROM memories
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(limit, offset) as unknown as MemoryRow[];
    return rows.map((row) => this.inflateMemory(row));
  }

  public getMemory(id: string): MemoryRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT id, memory_type, content, tags_json, is_pinned, created_at, updated_at
          FROM memories
          WHERE id = ?
        `,
      )
      .get(id) as unknown as MemoryRow | undefined;
    if (!row) {
      return null;
    }
    return this.inflateMemory(row);
  }

  public getPinnedMemories(): SearchResult[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, memory_type, content, tags_json, is_pinned, updated_at
          FROM memories
          WHERE is_pinned = 1
          ORDER BY updated_at DESC
        `,
      )
      .all() as unknown as Array<
      Pick<MemoryRow, 'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'>
    >;
    return rows.map((row) => ({
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: this.parseTags(row.tags_json),
      score: 1,
      is_pinned: row.is_pinned === 1,
      updated_at: row.updated_at,
    }));
  }

  public createMemory(input: AddMemoryInput): MemoryRecord {
    const now = new Date().toISOString();
    const id = ulid();
    const tagsJson = JSON.stringify(input.tags);

    this.withTransaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO memories (id, memory_type, content, tags_json, is_pinned, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(id, input.memory_type, input.content, tagsJson, input.is_pinned ? 1 : 0, now, now);
      this.syncFts(id, input.content, input.tags);
      this.replacePathMatchers(id, input.path_matchers, now);
    });

    const created = this.getMemory(id);
    if (!created) {
      throw new Error('Created memory missing after transaction');
    }
    return created;
  }

  public updateMemory(id: string, input: UpdateMemoryInput): MemoryRecord | null {
    const current = this.getMemory(id);
    if (!current) {
      return null;
    }
    const next = {
      content: input.content ?? current.content,
      is_pinned: input.is_pinned ?? current.is_pinned,
      tags: input.tags ?? current.tags,
      updated_at: new Date().toISOString(),
    };

    this.withTransaction(() => {
      this.db
        .prepare(
          `
            UPDATE memories
            SET content = ?, tags_json = ?, is_pinned = ?, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(next.content, JSON.stringify(next.tags), next.is_pinned ? 1 : 0, next.updated_at, id);
      this.syncFts(id, next.content, next.tags);
      if (input.path_matchers) {
        this.replacePathMatchers(id, input.path_matchers, next.updated_at);
      }
    });

    return this.getMemory(id);
  }

  public deleteMemory(id: string): boolean {
    const result = this.withTransaction(() => {
      this.db.prepare('DELETE FROM memory_path_matchers WHERE memory_id = ?').run(id);
      this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
      if (this.vecEnabled) {
        this.db.prepare('DELETE FROM vec_memory WHERE id = ?').run(id);
      }
      return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
    });
    return result;
  }

  public lexicalSearch(input: {
    query: string;
    limit: number;
    memoryTypes?: MemoryType[];
    includePinned: boolean;
  }): SearchResult[] {
    const normalizedQuery = input.query.trim();
    if (normalizedQuery.length === 0) {
      const rows = this.db
        .prepare(
          `
            SELECT id, memory_type, content, tags_json, is_pinned, updated_at
            FROM memories
            WHERE (${input.includePinned ? '1=1' : 'is_pinned = 0'})
            ORDER BY updated_at DESC
            LIMIT ?
          `,
        )
        .all(input.limit) as unknown as Array<
        Pick<MemoryRow, 'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'>
      >;

      return rows
        .filter((row) => !input.memoryTypes || input.memoryTypes.includes(row.memory_type))
        .map((row) => ({
          id: row.id,
          memory_type: row.memory_type,
          content: row.content,
          tags: this.parseTags(row.tags_json),
          score: 0.1,
          is_pinned: row.is_pinned === 1,
          updated_at: row.updated_at,
        }));
    }

    const terms = this.extractSearchTerms(normalizedQuery);
    if (terms.length === 0) {
      return [];
    }

    const candidateLimit = Math.min(Math.max(input.limit * 3, input.limit), 200);
    const rows = this.db
      .prepare(
        `
          SELECT m.id, m.memory_type, m.content, m.tags_json, m.is_pinned, m.created_at, m.updated_at, bm25(memory_fts) as score
          FROM memory_fts
          JOIN memories m ON m.id = memory_fts.id
          WHERE memory_fts MATCH ?
            AND (${input.includePinned ? '1=1' : 'm.is_pinned = 0'})
          ORDER BY score
          LIMIT ?
        `,
      )
      .all(this.makeFtsQueryFromTerms(terms), candidateLimit) as unknown as LexicalRow[];

    const bm25Range = this.computeBm25Range(rows);
    const loweredQuery = normalizedQuery.toLowerCase();

    return rows
      .filter((row) => !input.memoryTypes || input.memoryTypes.includes(row.memory_type))
      .map((row) => {
        const tags = this.parseTags(row.tags_json);
        const searchableText = `${row.content} ${tags.join(' ')}`.toLowerCase();
        const matchedTerms = terms.reduce((count, term) => {
          return searchableText.includes(term) ? count + 1 : count;
        }, 0);
        const coverageScore = matchedTerms / terms.length;
        const bm25Score = this.normalizeBm25(row.score, bm25Range);
        const phraseBoost =
          loweredQuery.length >= 3 && searchableText.includes(loweredQuery) ? 0.05 : 0;
        const score = this.clamp01(0.7 * bm25Score + 0.25 * coverageScore + phraseBoost);

        return {
          id: row.id,
          memory_type: row.memory_type,
          content: row.content,
          tags,
          score,
          is_pinned: row.is_pinned === 1,
          updated_at: row.updated_at,
        };
      })
      .sort((a, b) => b.score - a.score || Date.parse(b.updated_at) - Date.parse(a.updated_at))
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
    const rows = this.db
      .prepare(
        `
          SELECT e.memory_id, e.vector_json, e.updated_at,
                 m.memory_type, m.content, m.tags_json, m.is_pinned
          FROM memory_embeddings e
          JOIN memories m ON m.id = e.memory_id
          WHERE (${includePinned ? '1=1' : 'm.is_pinned = 0'})
        `,
      )
      .all() as unknown as Array<
      EmbeddingRow & Pick<MemoryRow, 'memory_type' | 'content' | 'tags_json' | 'is_pinned'>
    >;

    return rows
      .filter((row) => !memoryTypes || memoryTypes.includes(row.memory_type))
      .map((row) => ({
        id: row.memory_id,
        memory_type: row.memory_type,
        content: row.content,
        tags: this.parseTags(row.tags_json),
        is_pinned: row.is_pinned === 1,
        updated_at: row.updated_at,
        vector: this.parseVector(row.vector_json),
      }));
  }

  public upsertEmbedding(memoryId: string, vector: number[]): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
          INSERT INTO memory_embeddings (memory_id, vector_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(memory_id) DO UPDATE SET vector_json = excluded.vector_json, updated_at = excluded.updated_at
        `,
      )
      .run(memoryId, JSON.stringify(vector), now);

    if (this.vecEnabled) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        warn('Skipping vec_memory sync due embedding dimension mismatch', {
          actual: vector.length,
          expected: EMBEDDING_DIMENSIONS,
          memoryId,
        });
        return;
      }
      try {
        this.db.prepare('DELETE FROM vec_memory WHERE id = ?').run(memoryId);
        this.db
          .prepare(
            `
              INSERT INTO vec_memory (id, vector)
              VALUES (?, ?)
            `,
          )
          .run(memoryId, JSON.stringify(vector));
      } catch (error) {
        warn('Failed to sync vec_memory row', {
          error: error instanceof Error ? error.message : String(error),
          memoryId,
        });
      }
    }
  }

  public removeEmbedding(memoryId: string): void {
    this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
    if (this.vecEnabled) {
      this.db.prepare('DELETE FROM vec_memory WHERE id = ?').run(memoryId);
    }
  }

  public listPathMatchers(): MemoryPathMatcherRow[] {
    return this.db
      .prepare(
        `
          SELECT memory_id, path_matcher
          FROM memory_path_matchers
          ORDER BY created_at DESC
        `,
      )
      .all() as unknown as MemoryPathMatcherRow[];
  }

  public getMemoriesByIds(ids: string[]): SearchResult[] {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `
          SELECT id, memory_type, content, tags_json, is_pinned, updated_at
          FROM memories
          WHERE id IN (${placeholders})
        `,
      )
      .all(...ids) as unknown as Array<
      Pick<MemoryRow, 'id' | 'memory_type' | 'content' | 'tags_json' | 'is_pinned' | 'updated_at'>
    >;

    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as typeof rows;
    return ordered.map((row) => ({
      id: row.id,
      memory_type: row.memory_type,
      content: row.content,
      tags: this.parseTags(row.tags_json),
      score: 1,
      is_pinned: row.is_pinned === 1,
      updated_at: row.updated_at,
    }));
  }

  private initialize(): void {
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
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mpm_path_matcher ON memory_path_matchers(path_matcher);
      CREATE INDEX IF NOT EXISTS idx_mpm_memory_id ON memory_path_matchers(memory_id);
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
            vector float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
          );
        `);
      } catch (error) {
        warn('Failed creating vec_memory virtual table', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private tryEnableVec(extensionPath: string | null): boolean {
    if (!extensionPath) {
      warn('sqlite-vec extension path not provided; using JS semantic fallback');
      return false;
    }
    try {
      this.db.loadExtension(extensionPath);
      return true;
    } catch (error) {
      warn('sqlite-vec extension failed to load; using JS semantic fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private withTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private syncFts(memoryId: string, content: string, tags: string[]): void {
    this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(memoryId);
    this.db
      .prepare('INSERT INTO memory_fts (id, content, tags_text) VALUES (?, ?, ?)')
      .run(memoryId, content, tags.join(' '));
  }

  private replacePathMatchers(
    memoryId: string,
    pathMatchers: PathMatcherInput[],
    nowIso: string,
  ): void {
    this.db.prepare('DELETE FROM memory_path_matchers WHERE memory_id = ?').run(memoryId);
    const normalizedPathMatchers = this.normalizePathMatchers(pathMatchers);
    if (normalizedPathMatchers.length === 0) {
      return;
    }
    const insert = this.db.prepare(
      `
        INSERT INTO memory_path_matchers (id, memory_id, path_matcher, created_at)
        VALUES (?, ?, ?, ?)
      `,
    );
    for (const matcher of normalizedPathMatchers) {
      insert.run(ulid(), memoryId, matcher.path_matcher, nowIso);
    }
  }

  private normalizePathMatchers(pathMatchers: PathMatcherInput[]): PathMatcherInput[] {
    const seen = new Set<string>();
    const normalized: PathMatcherInput[] = [];
    for (const matcher of pathMatchers) {
      const pathMatcher = matcher.path_matcher.trim();
      if (!pathMatcher || seen.has(pathMatcher)) {
        continue;
      }
      seen.add(pathMatcher);
      normalized.push({ path_matcher: pathMatcher });
    }
    return normalized;
  }

  private inflateMemory(row: MemoryRow): MemoryRecord {
    const pathMatchers = this.db
      .prepare(
        `
          SELECT path_matcher
          FROM memory_path_matchers
          WHERE memory_id = ?
          ORDER BY created_at DESC
        `,
      )
      .all(row.id) as unknown as MatcherRow[];

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
      })),
    };
  }

  private parseTags(raw: string): string[] {
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

  private parseVector(raw: string): number[] {
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

  private makeFtsQueryFromTerms(terms: string[]): string {
    return terms.map((term) => `"${term.replaceAll('"', '')}"`).join(' OR ');
  }

  private extractSearchTerms(query: string): string[] {
    const rawTerms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .filter((term) => !STOP_WORDS.has(term));
    return [...new Set(rawTerms)];
  }

  private computeBm25Range(rows: LexicalRow[]): { min: number; max: number } {
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

  private normalizeBm25(rawBm25: number, range: { min: number; max: number }): number {
    const value = Math.abs(rawBm25);
    if (range.max <= range.min) {
      return 1;
    }
    return this.clamp01(1 - (value - range.min) / (range.max - range.min));
  }

  private clamp01(value: number): number {
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }
}

import { randomUUID } from "node:crypto";

import { SqliteService } from "../sqlite-service.js";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreateMemoryInput,
  DeleteMemoryOptions,
  ListMemoriesOptions,
  ListPinnedMemoriesOptions,
  PersistedMemoryRecord,
  PersistedMemorySearchResponse,
  PersistedPinnedMemoriesResult,
  SearchMemoriesByPathsOptions,
  SearchMemoriesBySemanticOptions,
  SearchMemoriesByTagsOptions,
  UpdateMemoryInput,
} from "../types/memory.js";
import { serializeSemanticEmbedding } from "../../shared/utils/embeddings.js";
import { normalizeNonEmptyString } from "../../shared/utils/strings.js";
import type { SpaceMetadata } from "../../shared/types/space.js";
import {
  normalizePathMatchers,
  normalizeRelatedPaths,
  scorePathMatchers,
} from "../../shared/utils/path-matchers.js";

interface MemoryRow {
  id: string;
  space_id: string;
  space_kind: PersistedMemoryRecord["space_kind"];
  space_display_name: string;
  origin_url_normalized: string | null;
  memory_type: PersistedMemoryRecord["memory_type"];
  content: string;
  tags_json: string;
  is_pinned: number;
  created_at: string;
  updated_at: string;
}

interface LexicalSearchRow extends MemoryRow {
  lexical_score: number;
}

interface SemanticSearchRow extends MemoryRow {
  semantic_score: number;
}

interface SemanticEmbeddingUpdateAction {
  embedding?: number[] | undefined;
  kind: "delete" | "keep" | "replace";
}

export class MemoryRepository {
  private static parseTagsJson(tagsJson: string): string[] {
    return JSON.parse(tagsJson) as string[];
  }

  private static toSqliteBoolean(value: boolean): number {
    if (value) {
      return 1;
    }

    return 0;
  }

  private static serializeTagsForFts(tags: string[]): string {
    return tags.join("\n");
  }

  private static escapeFtsToken(token: string): string {
    return `"${token.replaceAll('"', '""')}"`;
  }

  private static buildLexicalMatchExpression(query: string): string {
    const normalizedQuery = normalizeNonEmptyString(query);

    if (!normalizedQuery) {
      throw new Error("Search query must be a non-empty string.");
    }

    const tokens = normalizedQuery
      .split(/\s+/u)
      .map((token) => normalizeNonEmptyString(token))
      .filter((token): token is string => token !== undefined);

    if (tokens.length === 0) {
      throw new Error(
        "Search query must contain at least one searchable token."
      );
    }

    return tokens
      .map((token) => MemoryRepository.escapeFtsToken(token))
      .join(" OR ");
  }

  private static normalizeSearchLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return 10;
    }

    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error(
        "Search limit must be a positive integer no greater than 100."
      );
    }

    return limit;
  }

  private static hydrateMemoryRow(row: Record<string, unknown>): MemoryRow {
    return {
      id: row["id"] as string,
      space_id: row["space_id"] as string,
      space_kind: row["space_kind"] as PersistedMemoryRecord["space_kind"],
      space_display_name: row["space_display_name"] as string,
      origin_url_normalized: row["origin_url_normalized"] as string | null,
      memory_type: row["memory_type"] as PersistedMemoryRecord["memory_type"],
      content: row["content"] as string,
      tags_json: row["tags_json"] as string,
      is_pinned: row["is_pinned"] as number,
      created_at: row["created_at"] as string,
      updated_at: row["updated_at"] as string,
    };
  }

  private static hydrateSpaceMetadataRow(
    row: Record<string, unknown>
  ): SpaceMetadata {
    return {
      space_id: row["space_id"] as string,
      space_kind: row["space_kind"] as SpaceMetadata["space_kind"],
      space_display_name: row["space_display_name"] as string,
      origin_url_normalized: row["origin_url_normalized"] as string | null,
    };
  }

  private static hydrateLexicalSearchRow(
    row: Record<string, unknown>
  ): LexicalSearchRow {
    return {
      ...MemoryRepository.hydrateMemoryRow(row),
      lexical_score: row["lexical_score"] as number,
    };
  }

  private static hydrateSemanticSearchRow(
    row: Record<string, unknown>
  ): SemanticSearchRow {
    return {
      ...MemoryRepository.hydrateMemoryRow(row),
      semantic_score: row["semantic_score"] as number,
    };
  }

  private static normalizeContent(content: string): string {
    const normalizedContent = normalizeNonEmptyString(content);

    if (!normalizedContent) {
      throw new Error("Memory content must be a non-empty string.");
    }

    return normalizedContent;
  }

  private static normalizeTags(tags: string[] | undefined): string[] {
    return Array.from(
      new Set(
        (tags ?? [])
          .map((tag) => normalizeNonEmptyString(tag))
          .filter((tag): tag is string => tag !== undefined)
      )
    );
  }

  private static mapMemoryRow(
    row: MemoryRow,
    pathMatchers: string[]
  ): PersistedMemoryRecord {
    return {
      id: row.id,
      space_id: row.space_id,
      space_kind: row.space_kind,
      space_display_name: row.space_display_name,
      origin_url_normalized: row.origin_url_normalized,
      memory_type: row.memory_type,
      content: row.content,
      tags: MemoryRepository.parseTagsJson(row.tags_json),
      is_pinned: row.is_pinned === 1,
      path_matchers: pathMatchers,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private static mapLexicalSearchRow(
    row: LexicalSearchRow,
    pathMatchers: string[]
  ): PersistedMemorySearchResponse["results"][number] {
    return {
      ...MemoryRepository.mapMemoryRow(row, pathMatchers),
      score: row.lexical_score,
      source: "lexical",
      matched_by: ["lexical"],
      path_score: null,
      lexical_score: row.lexical_score,
      semantic_score: null,
    };
  }

  private static mapPathSearchResult(
    memory: PersistedMemoryRecord,
    pathScore: number
  ): PersistedMemorySearchResponse["results"][number] {
    return {
      ...memory,
      score: pathScore,
      source: "path",
      matched_by: ["path"],
      path_score: pathScore,
      lexical_score: null,
      semantic_score: null,
    };
  }

  private static mapSemanticSearchRow(
    row: SemanticSearchRow,
    pathMatchers: string[]
  ): PersistedMemorySearchResponse["results"][number] {
    return {
      ...MemoryRepository.mapMemoryRow(row, pathMatchers),
      score: row.semantic_score,
      source: "semantic",
      matched_by: ["semantic"],
      path_score: null,
      lexical_score: null,
      semantic_score: row.semantic_score,
    };
  }

  private static resolveUpdatedContent(
    existingContent: string,
    nextContent: string | undefined
  ): string {
    if (nextContent === undefined) {
      return existingContent;
    }

    return MemoryRepository.normalizeContent(nextContent);
  }

  private static resolveUpdatedMemoryType(
    existingMemoryType: PersistedMemoryRecord["memory_type"],
    nextMemoryType: PersistedMemoryRecord["memory_type"] | undefined,
  ): PersistedMemoryRecord["memory_type"] {
    if (nextMemoryType === undefined) {
      return existingMemoryType;
    }

    return nextMemoryType;
  }

  private static resolveUpdatedTags(
    existingTagsJson: string,
    nextTags: string[] | undefined
  ): string[] {
    if (nextTags === undefined) {
      return MemoryRepository.parseTagsJson(existingTagsJson);
    }

    return MemoryRepository.normalizeTags(nextTags);
  }

  private static resolveUpdatedIsPinned(
    existingIsPinned: number,
    nextIsPinned: boolean | undefined
  ): number {
    if (nextIsPinned === undefined) {
      return existingIsPinned;
    }

    return MemoryRepository.toSqliteBoolean(nextIsPinned);
  }

  private static resolveSemanticEmbeddingUpdateAction(
    existingContent: string,
    nextContent: string,
    input: UpdateMemoryInput
  ): SemanticEmbeddingUpdateAction {
    if (Object.hasOwn(input, "semanticEmbedding")) {
      if (input.semanticEmbedding === null) {
        return {
          kind: "delete",
        };
      }

      return {
        kind: "replace",
        embedding: input.semanticEmbedding,
      };
    }

    if (nextContent !== existingContent) {
      return {
        kind: "delete",
      };
    }

    return {
      kind: "keep",
    };
  }

  private static readMemoryRow(
    database: DatabaseSync,
    memoryId: string
  ): MemoryRow | null {
    const row = database
      .prepare(
        `SELECT
          memories.id,
          memories.space_id,
          memory_spaces.space_kind,
          memory_spaces.display_name AS space_display_name,
          memory_spaces.origin_url_normalized,
          memories.memory_type,
          memories.content,
          memories.tags_json,
          memories.is_pinned,
          memories.created_at,
          memories.updated_at
        FROM memories
        INNER JOIN memory_spaces ON memory_spaces.id = memories.space_id
        WHERE memories.id = ?`
      )
      .get(memoryId);

    return row
      ? MemoryRepository.hydrateMemoryRow(row as Record<string, unknown>)
      : null;
  }

  private static readPathMatchers(
    database: DatabaseSync,
    memoryId: string
  ): string[] {
    return database
      .prepare(
        `SELECT path_matcher
        FROM memory_path_matchers
        WHERE memory_id = ?
        ORDER BY created_at, path_matcher`
      )
      .all(memoryId)
      .map((row) => (row as { path_matcher: string }).path_matcher);
  }

  private static readSpaceMetadata(
    database: DatabaseSync,
    spaceId: string
  ): SpaceMetadata | null {
    const row = database
      .prepare(
        `SELECT
          id AS space_id,
          space_kind,
          display_name AS space_display_name,
          origin_url_normalized
        FROM memory_spaces
        WHERE id = ?`
      )
      .get(spaceId);

    if (!row) {
      return null;
    }

    return MemoryRepository.hydrateSpaceMetadataRow(
      row as Record<string, unknown>
    );
  }

  private static requireMemory(
    database: DatabaseSync,
    memoryId: string
  ): MemoryRow {
    const row = MemoryRepository.readMemoryRow(database, memoryId);

    if (!row) {
      throw new Error(`Unable to find memory "${memoryId}".`);
    }

    return row;
  }

  private static requireSpaceMetadata(
    database: DatabaseSync,
    spaceId: string
  ): SpaceMetadata {
    const spaceMetadata = MemoryRepository.readSpaceMetadata(database, spaceId);

    if (!spaceMetadata) {
      throw new Error(`Unable to find memory space "${spaceId}".`);
    }

    return spaceMetadata;
  }

  private static readMemoryRecord(
    database: DatabaseSync,
    memoryId: string
  ): PersistedMemoryRecord {
    const row = MemoryRepository.requireMemory(database, memoryId);
    const pathMatchers = MemoryRepository.readPathMatchers(database, memoryId);

    return MemoryRepository.mapMemoryRow(row, pathMatchers);
  }

  private static replacePathMatchers(
    database: DatabaseSync,
    memoryId: string,
    pathMatchers: string[],
    createdAt: string
  ): void {
    database
      .prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?")
      .run(memoryId);

    const insertPathMatcherStatement = database.prepare(
      `INSERT INTO memory_path_matchers (
        id,
        memory_id,
        path_matcher,
        created_at
      ) VALUES (?, ?, ?, ?)`
    );

    for (const pathMatcher of pathMatchers) {
      insertPathMatcherStatement.run(
        randomUUID(),
        memoryId,
        pathMatcher,
        createdAt
      );
    }
  }

  private static replaceMemoryFtsRow(
    database: DatabaseSync,
    memoryId: string,
    tags: string[]
  ): void {
    database.prepare("DELETE FROM memory_fts WHERE id = ?").run(memoryId);

    if (tags.length === 0) {
      return;
    }

    database
      .prepare("INSERT INTO memory_fts (id, tags_text) VALUES (?, ?)")
      .run(memoryId, MemoryRepository.serializeTagsForFts(tags));
  }

  private static replaceMemoryVectorRow(
    database: DatabaseSync,
    memoryId: string,
    semanticEmbedding: number[] | null | undefined
  ): void {
    database.prepare("DELETE FROM vec_memory WHERE memory_id = ?").run(memoryId);

    if (!semanticEmbedding) {
      return;
    }

    database
      .prepare("INSERT INTO vec_memory (memory_id, embedding) VALUES (?, ?)")
      .run(memoryId, serializeSemanticEmbedding(semanticEmbedding));
  }

  static createMemory(
    database: DatabaseSync,
    input: CreateMemoryInput
  ): PersistedMemoryRecord {
    return SqliteService.transaction(database, () => {
      const memoryId = input.id ?? randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const updatedAt = input.updatedAt ?? createdAt;
      const content = MemoryRepository.normalizeContent(input.content);
      const tags = MemoryRepository.normalizeTags(input.tags);
      const pathMatchers = normalizePathMatchers(input.pathMatchers);

      database
        .prepare(
          `INSERT INTO memories (
            id,
            space_id,
            memory_type,
            content,
            tags_json,
            is_pinned,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          memoryId,
          input.spaceId,
          input.memoryType,
          content,
          JSON.stringify(tags),
          MemoryRepository.toSqliteBoolean(input.isPinned ?? false),
          createdAt,
          updatedAt
        );

      MemoryRepository.replaceMemoryFtsRow(database, memoryId, tags);
      MemoryRepository.replacePathMatchers(
        database,
        memoryId,
        pathMatchers,
        createdAt
      );
      MemoryRepository.replaceMemoryVectorRow(
        database,
        memoryId,
        input.semanticEmbedding ?? undefined
      );

      return MemoryRepository.readMemoryRecord(database, memoryId);
    });
  }

  static getMemoryById(
    database: DatabaseSync,
    memoryId: string
  ): PersistedMemoryRecord | null {
    const row = MemoryRepository.readMemoryRow(database, memoryId);

    if (!row) {
      return null;
    }

    return MemoryRepository.mapMemoryRow(
      row,
      MemoryRepository.readPathMatchers(database, memoryId)
    );
  }

  static listMemories(
    database: DatabaseSync,
    options: ListMemoriesOptions
  ): PersistedMemoryRecord[] {
    const normalizedSpaceId = normalizeNonEmptyString(options.spaceId);
    let limit: number | undefined;

    if (options.limit !== undefined) {
      limit = MemoryRepository.normalizeSearchLimit(options.limit);
    }
    let query = `
      SELECT
        memories.id,
        memories.space_id,
        memory_spaces.space_kind,
        memory_spaces.display_name AS space_display_name,
        memory_spaces.origin_url_normalized,
        memories.memory_type,
        memories.content,
        memories.tags_json,
        memories.is_pinned,
        memories.created_at,
        memories.updated_at
      FROM memories
      INNER JOIN memory_spaces ON memory_spaces.id = memories.space_id
    `;
    const parameters: string[] = [];

    if (normalizedSpaceId) {
      query += " WHERE memories.space_id = ?";
      parameters.push(normalizedSpaceId);
    }

    query += " ORDER BY memories.updated_at DESC, memories.id ASC";

    if (limit !== undefined) {
      query += ` LIMIT ${String(limit)}`;
    }

    const rows = database.prepare(query).all(...parameters) as Record<
      string,
      unknown
    >[];

    return rows.map((row) =>
      MemoryRepository.mapMemoryRow(
        MemoryRepository.hydrateMemoryRow(row),
        MemoryRepository.readPathMatchers(database, row["id"] as string)
      )
    );
  }

  static listPinnedMemories(
    database: DatabaseSync,
    options: ListPinnedMemoriesOptions
  ): PersistedPinnedMemoriesResult {
    const space = MemoryRepository.requireSpaceMetadata(
      database,
      options.spaceId
    );
    const rows = database
      .prepare(
        `SELECT
          memories.id,
          memories.space_id,
          memory_spaces.space_kind,
          memory_spaces.display_name AS space_display_name,
          memory_spaces.origin_url_normalized,
          memories.memory_type,
          memories.content,
          memories.tags_json,
          memories.is_pinned,
          memories.created_at,
          memories.updated_at
        FROM memories
        INNER JOIN memory_spaces ON memory_spaces.id = memories.space_id
        WHERE memories.space_id = ? AND memories.is_pinned = 1
        ORDER BY memories.updated_at DESC, memories.id ASC`
      )
      .all(options.spaceId) as Record<string, unknown>[];

    return {
      space,
      memories: rows.map((row) =>
        MemoryRepository.mapMemoryRow(
          MemoryRepository.hydrateMemoryRow(row),
          MemoryRepository.readPathMatchers(database, row["id"] as string)
        )
      ),
    };
  }

  static searchMemoriesByTags(
    database: DatabaseSync,
    options: SearchMemoriesByTagsOptions
  ): PersistedMemorySearchResponse {
    const space = MemoryRepository.requireSpaceMetadata(
      database,
      options.spaceId
    );
    return {
      space,
      results: MemoryRepository.searchMemoriesByTagsInternal(database, options),
    };
  }

  static searchAllMemoriesByTags(
    database: DatabaseSync,
    options: {
      query: string;
      limit?: number | undefined;
    }
  ): PersistedMemorySearchResponse["results"] {
    return MemoryRepository.searchMemoriesByTagsInternal(database, options);
  }

  static searchMemoriesBySemantic(
    database: DatabaseSync,
    options: SearchMemoriesBySemanticOptions
  ): PersistedMemorySearchResponse {
    const space = MemoryRepository.requireSpaceMetadata(
      database,
      options.spaceId
    );
    return {
      space,
      results: MemoryRepository.searchMemoriesBySemanticInternal(database, options),
    };
  }

  static searchAllMemoriesBySemantic(
    database: DatabaseSync,
    options: {
      queryEmbedding: number[];
      limit?: number | undefined;
    }
  ): PersistedMemorySearchResponse["results"] {
    return MemoryRepository.searchMemoriesBySemanticInternal(database, options);
  }

  static searchMemoriesByPaths(
    database: DatabaseSync,
    options: SearchMemoriesByPathsOptions
  ): PersistedMemorySearchResponse {
    const space = MemoryRepository.requireSpaceMetadata(
      database,
      options.spaceId
    );
    const relatedPaths = normalizeRelatedPaths(options.relatedPaths);
    const limit = MemoryRepository.normalizeSearchLimit(options.limit);

    if (relatedPaths.length === 0) {
      return {
        space,
        results: [],
      };
    }

    const rankedMatches = MemoryRepository.listMemories(database, {
      spaceId: options.spaceId,
    })
      .map((memory) => ({
        memory,
        pathScore: scorePathMatchers(memory.path_matchers, relatedPaths),
      }))
      .filter(
        (
          candidate
        ): candidate is {
          memory: PersistedMemoryRecord;
          pathScore: number;
        } => candidate.pathScore !== null
      )
      .sort((leftCandidate, rightCandidate) => {
        if (leftCandidate.pathScore !== rightCandidate.pathScore) {
          return rightCandidate.pathScore - leftCandidate.pathScore;
        }

        if (
          leftCandidate.memory.is_pinned !== rightCandidate.memory.is_pinned
        ) {
          return leftCandidate.memory.is_pinned ? -1 : 1;
        }

        if (
          leftCandidate.memory.updated_at !== rightCandidate.memory.updated_at
        ) {
          return leftCandidate.memory.updated_at <
            rightCandidate.memory.updated_at
            ? 1
            : -1;
        }

        return leftCandidate.memory.id.localeCompare(rightCandidate.memory.id);
      })
      .slice(0, limit);

    return {
      space,
      results: rankedMatches.map((candidate) =>
        MemoryRepository.mapPathSearchResult(
          candidate.memory,
          candidate.pathScore
        )
      ),
    };
  }

  private static searchMemoriesByTagsInternal(
    database: DatabaseSync,
    options: {
      query: string;
      spaceId?: string | undefined;
      limit?: number | undefined;
    }
  ): PersistedMemorySearchResponse["results"] {
    const normalizedSpaceId = normalizeNonEmptyString(options.spaceId);
    const matchExpression = MemoryRepository.buildLexicalMatchExpression(
      options.query
    );
    const limit = MemoryRepository.normalizeSearchLimit(options.limit);
    const parameters = normalizedSpaceId
      ? [normalizedSpaceId, matchExpression]
      : [matchExpression];
    let query = `SELECT
        memories.id,
        memories.space_id,
        memory_spaces.space_kind,
        memory_spaces.display_name AS space_display_name,
        memory_spaces.origin_url_normalized,
        memories.memory_type,
        memories.content,
        memories.tags_json,
        memories.is_pinned,
        memories.created_at,
        memories.updated_at,
        CAST(-bm25(memory_fts) AS REAL) AS lexical_score
      FROM memory_fts
      INNER JOIN memories ON memories.id = memory_fts.id
      INNER JOIN memory_spaces ON memory_spaces.id = memories.space_id
      WHERE `;

    if (normalizedSpaceId) {
      query += "memories.space_id = ? AND ";
    }

    query += `memory_fts MATCH ?
      ORDER BY lexical_score DESC, memories.is_pinned DESC, memories.updated_at DESC, memories.id ASC
      LIMIT ${String(limit)}`;

    const rows = database.prepare(query).all(...parameters) as Record<
      string,
      unknown
    >[];

    return rows.map((row) =>
      MemoryRepository.mapLexicalSearchRow(
        MemoryRepository.hydrateLexicalSearchRow(row),
        MemoryRepository.readPathMatchers(database, row["id"] as string)
      )
    );
  }

  private static searchMemoriesBySemanticInternal(
    database: DatabaseSync,
    options: {
      queryEmbedding: number[];
      spaceId?: string | undefined;
      limit?: number | undefined;
    }
  ): PersistedMemorySearchResponse["results"] {
    const normalizedSpaceId = normalizeNonEmptyString(options.spaceId);
    const limit = MemoryRepository.normalizeSearchLimit(options.limit);
    const serializedQueryEmbedding = serializeSemanticEmbedding(
      options.queryEmbedding
    );
    const parameters = normalizedSpaceId
      ? [normalizedSpaceId, serializedQueryEmbedding]
      : [serializedQueryEmbedding];
    let query = `SELECT
        memories.id,
        memories.space_id,
        memory_spaces.space_kind,
        memory_spaces.display_name AS space_display_name,
        memory_spaces.origin_url_normalized,
        memories.memory_type,
        memories.content,
        memories.tags_json,
        memories.is_pinned,
        memories.created_at,
        memories.updated_at,
        CAST(1.0 - distance AS REAL) AS semantic_score
      FROM vec_memory
      INNER JOIN memories ON memories.id = vec_memory.memory_id
      INNER JOIN memory_spaces ON memory_spaces.id = memories.space_id
      WHERE `;

    if (normalizedSpaceId) {
      query += "memories.space_id = ? AND ";
    }

    query += `vec_memory.embedding MATCH ?
      AND k = ${String(limit)}
      ORDER BY distance ASC, memories.is_pinned DESC, memories.updated_at DESC, memories.id ASC`;

    const rows = database.prepare(query).all(...parameters) as Record<
      string,
      unknown
    >[];

    return rows.map((row) =>
      MemoryRepository.mapSemanticSearchRow(
        MemoryRepository.hydrateSemanticSearchRow(row),
        MemoryRepository.readPathMatchers(database, row["id"] as string)
      )
    );
  }

  static updateMemory(
    database: DatabaseSync,
    input: UpdateMemoryInput
  ): PersistedMemoryRecord {
    return SqliteService.transaction(database, () => {
      const existingMemory = MemoryRepository.requireMemory(
        database,
        input.memoryId
      );
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      const nextMemoryType = MemoryRepository.resolveUpdatedMemoryType(
        existingMemory.memory_type,
        input.memoryType
      );
      const nextContent = MemoryRepository.resolveUpdatedContent(
        existingMemory.content,
        input.content
      );
      const nextTags = MemoryRepository.resolveUpdatedTags(
        existingMemory.tags_json,
        input.tags
      );
      const nextIsPinned = MemoryRepository.resolveUpdatedIsPinned(
        existingMemory.is_pinned,
        input.isPinned
      );
      const semanticEmbeddingUpdateAction =
        MemoryRepository.resolveSemanticEmbeddingUpdateAction(
          existingMemory.content,
          nextContent,
          input
        );

      database
        .prepare(
          `UPDATE memories
          SET memory_type = ?, content = ?, tags_json = ?, is_pinned = ?, updated_at = ?
          WHERE id = ?`
        )
        .run(
          nextMemoryType,
          nextContent,
          JSON.stringify(nextTags),
          nextIsPinned,
          updatedAt,
          input.memoryId
        );

      MemoryRepository.replaceMemoryFtsRow(database, input.memoryId, nextTags);

      if (input.pathMatchers !== undefined) {
        MemoryRepository.replacePathMatchers(
          database,
          input.memoryId,
          normalizePathMatchers(input.pathMatchers),
          updatedAt
        );
      }

      if (semanticEmbeddingUpdateAction.kind !== "keep") {
        MemoryRepository.replaceMemoryVectorRow(
          database,
          input.memoryId,
          semanticEmbeddingUpdateAction.kind === "replace"
            ? semanticEmbeddingUpdateAction.embedding
            : null
        );
      }

      return MemoryRepository.readMemoryRecord(database, input.memoryId);
    });
  }

  static deleteMemory(
    database: DatabaseSync,
    options: DeleteMemoryOptions
  ): void {
    SqliteService.transaction(database, () => {
      MemoryRepository.requireMemory(database, options.memoryId);
      database
        .prepare("DELETE FROM memory_fts WHERE id = ?")
        .run(options.memoryId);
      database
        .prepare("DELETE FROM vec_memory WHERE memory_id = ?")
        .run(options.memoryId);
      database
        .prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?")
        .run(options.memoryId);
      database
        .prepare("DELETE FROM memories WHERE id = ?")
        .run(options.memoryId);
    });
  }
}

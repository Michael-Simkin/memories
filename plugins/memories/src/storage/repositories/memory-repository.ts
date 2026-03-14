import { randomUUID } from "node:crypto";

import { SqliteService } from "../sqlite-service.js";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreateMemoryInput,
  DeleteMemoryOptions,
  ListMemoriesOptions,
  PersistedMemoryRecord,
  UpdateMemoryInput,
} from "../types/memory.js";
import { normalizeNonEmptyString } from "../../shared/utils/strings.js";

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
          .filter((tag): tag is string => tag !== undefined),
      ),
    );
  }

  private static normalizePathMatchers(pathMatchers: string[] | undefined): string[] {
    const normalizedPathMatchers = Array.from(
      new Set(
        (pathMatchers ?? [])
          .map((pathMatcher) => normalizeNonEmptyString(pathMatcher))
          .filter((pathMatcher): pathMatcher is string => pathMatcher !== undefined),
      ),
    );

    for (const pathMatcher of normalizedPathMatchers) {
      if (pathMatcher.startsWith("/")) {
        throw new Error("Path matchers must be relative to the owning memory space root.");
      }
    }

    return normalizedPathMatchers;
  }

  private static mapMemoryRow(
    row: MemoryRow,
    pathMatchers: string[],
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

  private static resolveUpdatedContent(
    existingContent: string,
    nextContent: string | undefined,
  ): string {
    if (nextContent === undefined) {
      return existingContent;
    }

    return MemoryRepository.normalizeContent(nextContent);
  }

  private static resolveUpdatedTags(
    existingTagsJson: string,
    nextTags: string[] | undefined,
  ): string[] {
    if (nextTags === undefined) {
      return MemoryRepository.parseTagsJson(existingTagsJson);
    }

    return MemoryRepository.normalizeTags(nextTags);
  }

  private static resolveUpdatedIsPinned(
    existingIsPinned: number,
    nextIsPinned: boolean | undefined,
  ): number {
    if (nextIsPinned === undefined) {
      return existingIsPinned;
    }

    return MemoryRepository.toSqliteBoolean(nextIsPinned);
  }

  private static readMemoryRow(database: DatabaseSync, memoryId: string): MemoryRow | null {
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
        WHERE memories.id = ?`,
      )
      .get(memoryId);

    return row ? MemoryRepository.hydrateMemoryRow(row as Record<string, unknown>) : null;
  }

  private static readPathMatchers(database: DatabaseSync, memoryId: string): string[] {
    return database
      .prepare(
        `SELECT path_matcher
        FROM memory_path_matchers
        WHERE memory_id = ?
        ORDER BY created_at, path_matcher`,
      )
      .all(memoryId)
      .map((row) => (row as { path_matcher: string }).path_matcher);
  }

  private static requireMemory(database: DatabaseSync, memoryId: string): MemoryRow {
    const row = MemoryRepository.readMemoryRow(database, memoryId);

    if (!row) {
      throw new Error(`Unable to find memory "${memoryId}".`);
    }

    return row;
  }

  private static readMemoryRecord(
    database: DatabaseSync,
    memoryId: string,
  ): PersistedMemoryRecord {
    const row = MemoryRepository.requireMemory(database, memoryId);
    const pathMatchers = MemoryRepository.readPathMatchers(database, memoryId);

    return MemoryRepository.mapMemoryRow(row, pathMatchers);
  }

  private static replacePathMatchers(
    database: DatabaseSync,
    memoryId: string,
    pathMatchers: string[],
    createdAt: string,
  ): void {
    database.prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?").run(memoryId);

    const insertPathMatcherStatement = database.prepare(
      `INSERT INTO memory_path_matchers (
        id,
        memory_id,
        path_matcher,
        created_at
      ) VALUES (?, ?, ?, ?)`,
    );

    for (const pathMatcher of pathMatchers) {
      insertPathMatcherStatement.run(randomUUID(), memoryId, pathMatcher, createdAt);
    }
  }

  static createMemory(
    database: DatabaseSync,
    input: CreateMemoryInput,
  ): PersistedMemoryRecord {
    return SqliteService.transaction(database, () => {
      const memoryId = input.id ?? randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const updatedAt = input.updatedAt ?? createdAt;
      const content = MemoryRepository.normalizeContent(input.content);
      const tags = MemoryRepository.normalizeTags(input.tags);
      const pathMatchers = MemoryRepository.normalizePathMatchers(input.pathMatchers);

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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memoryId,
          input.spaceId,
          input.memoryType,
          content,
          JSON.stringify(tags),
          MemoryRepository.toSqliteBoolean(input.isPinned ?? false),
          createdAt,
          updatedAt,
        );

      MemoryRepository.replacePathMatchers(
        database,
        memoryId,
        pathMatchers,
        createdAt,
      );

      return MemoryRepository.readMemoryRecord(database, memoryId);
    });
  }

  static getMemoryById(
    database: DatabaseSync,
    memoryId: string,
  ): PersistedMemoryRecord | null {
    const row = MemoryRepository.readMemoryRow(database, memoryId);

    if (!row) {
      return null;
    }

    return MemoryRepository.mapMemoryRow(
      row,
      MemoryRepository.readPathMatchers(database, memoryId),
    );
  }

  static listMemories(
    database: DatabaseSync,
    options: ListMemoriesOptions,
  ): PersistedMemoryRecord[] {
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
        WHERE memories.space_id = ?
        ORDER BY memories.updated_at DESC, memories.id ASC`,
      )
      .all(options.spaceId) as Record<string, unknown>[];

    return rows.map((row) =>
      MemoryRepository.mapMemoryRow(
        MemoryRepository.hydrateMemoryRow(row),
        MemoryRepository.readPathMatchers(database, row["id"] as string),
      ),
    );
  }

  static updateMemory(
    database: DatabaseSync,
    input: UpdateMemoryInput,
  ): PersistedMemoryRecord {
    return SqliteService.transaction(database, () => {
      const existingMemory = MemoryRepository.requireMemory(database, input.memoryId);
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      const nextContent = MemoryRepository.resolveUpdatedContent(
        existingMemory.content,
        input.content,
      );
      const nextTags = MemoryRepository.resolveUpdatedTags(
        existingMemory.tags_json,
        input.tags,
      );
      const nextIsPinned = MemoryRepository.resolveUpdatedIsPinned(
        existingMemory.is_pinned,
        input.isPinned,
      );

      database
        .prepare(
          `UPDATE memories
          SET content = ?, tags_json = ?, is_pinned = ?, updated_at = ?
          WHERE id = ?`,
        )
        .run(
          nextContent,
          JSON.stringify(nextTags),
          nextIsPinned,
          updatedAt,
          input.memoryId,
        );

      if (input.pathMatchers !== undefined) {
        MemoryRepository.replacePathMatchers(
          database,
          input.memoryId,
          MemoryRepository.normalizePathMatchers(input.pathMatchers),
          updatedAt,
        );
      }

      return MemoryRepository.readMemoryRecord(database, input.memoryId);
    });
  }

  static deleteMemory(database: DatabaseSync, options: DeleteMemoryOptions): void {
    SqliteService.transaction(database, () => {
      MemoryRepository.requireMemory(database, options.memoryId);
      database.prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?").run(
        options.memoryId,
      );
      database.prepare("DELETE FROM memories WHERE id = ?").run(options.memoryId);
    });
  }
}

import { randomUUID } from "node:crypto";
import { SqliteService } from "../sqlite-service.js";
import { serializeSemanticEmbedding } from "../../shared/utils/embeddings.js";
import { normalizeNonEmptyString } from "../../shared/utils/strings.js";
import {
  normalizePathMatchers,
  normalizeRelatedPaths,
  scorePathMatchers
} from "../../shared/utils/path-matchers.js";
class MemoryRepository {
  static parseTagsJson(tagsJson) {
    return JSON.parse(tagsJson);
  }
  static toSqliteBoolean(value) {
    if (value) {
      return 1;
    }
    return 0;
  }
  static serializeTagsForFts(tags) {
    return tags.join("\n");
  }
  static escapeFtsToken(token) {
    return `"${token.replaceAll('"', '""')}"`;
  }
  static buildLexicalMatchExpression(query) {
    const normalizedQuery = normalizeNonEmptyString(query);
    if (!normalizedQuery) {
      throw new Error("Search query must be a non-empty string.");
    }
    const tokens = normalizedQuery.split(/\s+/u).map((token) => normalizeNonEmptyString(token)).filter((token) => token !== void 0);
    if (tokens.length === 0) {
      throw new Error(
        "Search query must contain at least one searchable token."
      );
    }
    return tokens.map((token) => MemoryRepository.escapeFtsToken(token)).join(" OR ");
  }
  static normalizeSearchLimit(limit) {
    if (limit === void 0) {
      return 10;
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error(
        "Search limit must be a positive integer no greater than 100."
      );
    }
    return limit;
  }
  static hydrateMemoryRow(row) {
    return {
      id: row["id"],
      space_id: row["space_id"],
      space_kind: row["space_kind"],
      space_display_name: row["space_display_name"],
      origin_url_normalized: row["origin_url_normalized"],
      memory_type: row["memory_type"],
      content: row["content"],
      tags_json: row["tags_json"],
      is_pinned: row["is_pinned"],
      created_at: row["created_at"],
      updated_at: row["updated_at"]
    };
  }
  static hydrateSpaceMetadataRow(row) {
    return {
      space_id: row["space_id"],
      space_kind: row["space_kind"],
      space_display_name: row["space_display_name"],
      origin_url_normalized: row["origin_url_normalized"]
    };
  }
  static hydrateLexicalSearchRow(row) {
    return {
      ...MemoryRepository.hydrateMemoryRow(row),
      lexical_score: row["lexical_score"]
    };
  }
  static hydrateSemanticSearchRow(row) {
    return {
      ...MemoryRepository.hydrateMemoryRow(row),
      semantic_score: row["semantic_score"]
    };
  }
  static normalizeContent(content) {
    const normalizedContent = normalizeNonEmptyString(content);
    if (!normalizedContent) {
      throw new Error("Memory content must be a non-empty string.");
    }
    return normalizedContent;
  }
  static normalizeTags(tags) {
    return Array.from(
      new Set(
        (tags ?? []).map((tag) => normalizeNonEmptyString(tag)).filter((tag) => tag !== void 0)
      )
    );
  }
  static mapMemoryRow(row, pathMatchers) {
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
      updated_at: row.updated_at
    };
  }
  static mapLexicalSearchRow(row, pathMatchers) {
    return {
      ...MemoryRepository.mapMemoryRow(row, pathMatchers),
      score: row.lexical_score,
      source: "lexical",
      matched_by: ["lexical"],
      path_score: null,
      lexical_score: row.lexical_score,
      semantic_score: null
    };
  }
  static mapPathSearchResult(memory, pathScore) {
    return {
      ...memory,
      score: pathScore,
      source: "path",
      matched_by: ["path"],
      path_score: pathScore,
      lexical_score: null,
      semantic_score: null
    };
  }
  static mapSemanticSearchRow(row, pathMatchers) {
    return {
      ...MemoryRepository.mapMemoryRow(row, pathMatchers),
      score: row.semantic_score,
      source: "semantic",
      matched_by: ["semantic"],
      path_score: null,
      lexical_score: null,
      semantic_score: row.semantic_score
    };
  }
  static resolveUpdatedContent(existingContent, nextContent) {
    if (nextContent === void 0) {
      return existingContent;
    }
    return MemoryRepository.normalizeContent(nextContent);
  }
  static resolveUpdatedTags(existingTagsJson, nextTags) {
    if (nextTags === void 0) {
      return MemoryRepository.parseTagsJson(existingTagsJson);
    }
    return MemoryRepository.normalizeTags(nextTags);
  }
  static resolveUpdatedIsPinned(existingIsPinned, nextIsPinned) {
    if (nextIsPinned === void 0) {
      return existingIsPinned;
    }
    return MemoryRepository.toSqliteBoolean(nextIsPinned);
  }
  static resolveSemanticEmbeddingUpdateAction(existingContent, nextContent, input) {
    if (Object.hasOwn(input, "semanticEmbedding")) {
      if (input.semanticEmbedding === null) {
        return {
          kind: "delete"
        };
      }
      return {
        kind: "replace",
        embedding: input.semanticEmbedding
      };
    }
    if (nextContent !== existingContent) {
      return {
        kind: "delete"
      };
    }
    return {
      kind: "keep"
    };
  }
  static readMemoryRow(database, memoryId) {
    const row = database.prepare(
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
    ).get(memoryId);
    return row ? MemoryRepository.hydrateMemoryRow(row) : null;
  }
  static readPathMatchers(database, memoryId) {
    return database.prepare(
      `SELECT path_matcher
        FROM memory_path_matchers
        WHERE memory_id = ?
        ORDER BY created_at, path_matcher`
    ).all(memoryId).map((row) => row.path_matcher);
  }
  static readSpaceMetadata(database, spaceId) {
    const row = database.prepare(
      `SELECT
          id AS space_id,
          space_kind,
          display_name AS space_display_name,
          origin_url_normalized
        FROM memory_spaces
        WHERE id = ?`
    ).get(spaceId);
    if (!row) {
      return null;
    }
    return MemoryRepository.hydrateSpaceMetadataRow(
      row
    );
  }
  static requireMemory(database, memoryId) {
    const row = MemoryRepository.readMemoryRow(database, memoryId);
    if (!row) {
      throw new Error(`Unable to find memory "${memoryId}".`);
    }
    return row;
  }
  static requireSpaceMetadata(database, spaceId) {
    const spaceMetadata = MemoryRepository.readSpaceMetadata(database, spaceId);
    if (!spaceMetadata) {
      throw new Error(`Unable to find memory space "${spaceId}".`);
    }
    return spaceMetadata;
  }
  static readMemoryRecord(database, memoryId) {
    const row = MemoryRepository.requireMemory(database, memoryId);
    const pathMatchers = MemoryRepository.readPathMatchers(database, memoryId);
    return MemoryRepository.mapMemoryRow(row, pathMatchers);
  }
  static replacePathMatchers(database, memoryId, pathMatchers, createdAt) {
    database.prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?").run(memoryId);
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
  static replaceMemoryFtsRow(database, memoryId, tags) {
    database.prepare("DELETE FROM memory_fts WHERE id = ?").run(memoryId);
    if (tags.length === 0) {
      return;
    }
    database.prepare("INSERT INTO memory_fts (id, tags_text) VALUES (?, ?)").run(memoryId, MemoryRepository.serializeTagsForFts(tags));
  }
  static replaceMemoryVectorRow(database, memoryId, semanticEmbedding) {
    database.prepare("DELETE FROM vec_memory WHERE memory_id = ?").run(memoryId);
    if (!semanticEmbedding) {
      return;
    }
    database.prepare("INSERT INTO vec_memory (memory_id, embedding) VALUES (?, ?)").run(memoryId, serializeSemanticEmbedding(semanticEmbedding));
  }
  static createMemory(database, input) {
    return SqliteService.transaction(database, () => {
      const memoryId = input.id ?? randomUUID();
      const createdAt = input.createdAt ?? (/* @__PURE__ */ new Date()).toISOString();
      const updatedAt = input.updatedAt ?? createdAt;
      const content = MemoryRepository.normalizeContent(input.content);
      const tags = MemoryRepository.normalizeTags(input.tags);
      const pathMatchers = normalizePathMatchers(input.pathMatchers);
      database.prepare(
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
      ).run(
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
        input.semanticEmbedding ?? void 0
      );
      return MemoryRepository.readMemoryRecord(database, memoryId);
    });
  }
  static getMemoryById(database, memoryId) {
    const row = MemoryRepository.readMemoryRow(database, memoryId);
    if (!row) {
      return null;
    }
    return MemoryRepository.mapMemoryRow(
      row,
      MemoryRepository.readPathMatchers(database, memoryId)
    );
  }
  static listMemories(database, options) {
    const normalizedSpaceId = normalizeNonEmptyString(options.spaceId);
    let limit;
    if (options.limit !== void 0) {
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
    const parameters = [];
    if (normalizedSpaceId) {
      query += " WHERE memories.space_id = ?";
      parameters.push(normalizedSpaceId);
    }
    query += " ORDER BY memories.updated_at DESC, memories.id ASC";
    if (limit !== void 0) {
      query += ` LIMIT ${String(limit)}`;
    }
    const rows = database.prepare(query).all(...parameters);
    return rows.map(
      (row) => MemoryRepository.mapMemoryRow(
        MemoryRepository.hydrateMemoryRow(row),
        MemoryRepository.readPathMatchers(database, row["id"])
      )
    );
  }
  static listPinnedMemories(database, options) {
    const space = MemoryRepository.requireSpaceMetadata(
      database,
      options.spaceId
    );
    const rows = database.prepare(
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
    ).all(options.spaceId);
    return {
      space,
      memories: rows.map(
        (row) => MemoryRepository.mapMemoryRow(
          MemoryRepository.hydrateMemoryRow(row),
          MemoryRepository.readPathMatchers(database, row["id"])
        )
      )
    };
  }
  static searchMemoriesByTags(database, options) {
    const space = MemoryRepository.requireSpaceMetadata(
      database,
      options.spaceId
    );
    const matchExpression = MemoryRepository.buildLexicalMatchExpression(
      options.query
    );
    const limit = MemoryRepository.normalizeSearchLimit(options.limit);
    const rows = database.prepare(
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
          memories.updated_at,
          CAST(-bm25(memory_fts) AS REAL) AS lexical_score
        FROM memory_fts
        INNER JOIN memories ON memories.id = memory_fts.id
        INNER JOIN memory_spaces ON memory_spaces.id = memories.space_id
        WHERE memories.space_id = ? AND memory_fts MATCH ?
        ORDER BY lexical_score DESC, memories.is_pinned DESC, memories.updated_at DESC, memories.id ASC
        LIMIT ${String(limit)}`
    ).all(options.spaceId, matchExpression);
    return {
      space,
      results: rows.map(
        (row) => MemoryRepository.mapLexicalSearchRow(
          MemoryRepository.hydrateLexicalSearchRow(row),
          MemoryRepository.readPathMatchers(database, row["id"])
        )
      )
    };
  }
  static searchMemoriesBySemantic(database, options) {
    const space = MemoryRepository.requireSpaceMetadata(
      database,
      options.spaceId
    );
    const limit = MemoryRepository.normalizeSearchLimit(options.limit);
    const rows = database.prepare(
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
          memories.updated_at,
          CAST(1.0 - distance AS REAL) AS semantic_score
        FROM vec_memory
        INNER JOIN memories ON memories.id = vec_memory.memory_id
        INNER JOIN memory_spaces ON memory_spaces.id = memories.space_id
        WHERE memories.space_id = ?
          AND vec_memory.embedding MATCH ?
          AND k = ${String(limit)}
        ORDER BY distance ASC, memories.is_pinned DESC, memories.updated_at DESC, memories.id ASC`
    ).all(
      options.spaceId,
      serializeSemanticEmbedding(options.queryEmbedding)
    );
    return {
      space,
      results: rows.map(
        (row) => MemoryRepository.mapSemanticSearchRow(
          MemoryRepository.hydrateSemanticSearchRow(row),
          MemoryRepository.readPathMatchers(database, row["id"])
        )
      )
    };
  }
  static searchMemoriesByPaths(database, options) {
    const space = MemoryRepository.requireSpaceMetadata(
      database,
      options.spaceId
    );
    const relatedPaths = normalizeRelatedPaths(options.relatedPaths);
    const limit = MemoryRepository.normalizeSearchLimit(options.limit);
    if (relatedPaths.length === 0) {
      return {
        space,
        results: []
      };
    }
    const rankedMatches = MemoryRepository.listMemories(database, {
      spaceId: options.spaceId
    }).map((memory) => ({
      memory,
      pathScore: scorePathMatchers(memory.path_matchers, relatedPaths)
    })).filter(
      (candidate) => candidate.pathScore !== null
    ).sort((leftCandidate, rightCandidate) => {
      if (leftCandidate.pathScore !== rightCandidate.pathScore) {
        return rightCandidate.pathScore - leftCandidate.pathScore;
      }
      if (leftCandidate.memory.is_pinned !== rightCandidate.memory.is_pinned) {
        return leftCandidate.memory.is_pinned ? -1 : 1;
      }
      if (leftCandidate.memory.updated_at !== rightCandidate.memory.updated_at) {
        return leftCandidate.memory.updated_at < rightCandidate.memory.updated_at ? 1 : -1;
      }
      return leftCandidate.memory.id.localeCompare(rightCandidate.memory.id);
    }).slice(0, limit);
    return {
      space,
      results: rankedMatches.map(
        (candidate) => MemoryRepository.mapPathSearchResult(
          candidate.memory,
          candidate.pathScore
        )
      )
    };
  }
  static updateMemory(database, input) {
    return SqliteService.transaction(database, () => {
      const existingMemory = MemoryRepository.requireMemory(
        database,
        input.memoryId
      );
      const updatedAt = input.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
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
      const semanticEmbeddingUpdateAction = MemoryRepository.resolveSemanticEmbeddingUpdateAction(
        existingMemory.content,
        nextContent,
        input
      );
      database.prepare(
        `UPDATE memories
          SET content = ?, tags_json = ?, is_pinned = ?, updated_at = ?
          WHERE id = ?`
      ).run(
        nextContent,
        JSON.stringify(nextTags),
        nextIsPinned,
        updatedAt,
        input.memoryId
      );
      MemoryRepository.replaceMemoryFtsRow(database, input.memoryId, nextTags);
      if (input.pathMatchers !== void 0) {
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
          semanticEmbeddingUpdateAction.kind === "replace" ? semanticEmbeddingUpdateAction.embedding : null
        );
      }
      return MemoryRepository.readMemoryRecord(database, input.memoryId);
    });
  }
  static deleteMemory(database, options) {
    SqliteService.transaction(database, () => {
      MemoryRepository.requireMemory(database, options.memoryId);
      database.prepare("DELETE FROM memory_fts WHERE id = ?").run(options.memoryId);
      database.prepare("DELETE FROM vec_memory WHERE memory_id = ?").run(options.memoryId);
      database.prepare("DELETE FROM memory_path_matchers WHERE memory_id = ?").run(options.memoryId);
      database.prepare("DELETE FROM memories WHERE id = ?").run(options.memoryId);
    });
  }
}
export {
  MemoryRepository
};

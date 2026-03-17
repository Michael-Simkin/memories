import type { DatabaseSync } from "node:sqlite";

import { MEMORY_RETRIEVAL_RRF_K } from "../../shared/constants/embeddings.js";
import { normalizeNonEmptyString } from "../../shared/utils/strings.js";
import { MemoryRepository } from "./memory-repository.js";
import type {
  PersistedMemorySearchResponse,
  SearchAllMemoriesOptions,
  SearchMemoriesOptions,
} from "../types/memory.js";

export class MemoryRetrievalRepository {
  private static cloneSearchResult(
    result: PersistedMemorySearchResponse["results"][number],
  ): PersistedMemorySearchResponse["results"][number] {
    return {
      ...result,
      matched_by: [...result.matched_by],
    };
  }

  private static appendMatchedBy(
    result: PersistedMemorySearchResponse["results"][number],
    source: PersistedMemorySearchResponse["results"][number]["matched_by"][number],
  ): void {
    if (!result.matched_by.includes(source)) {
      result.matched_by.push(source);
    }
  }

  private static mergeHybridBranchResults(
    lexicalResults: PersistedMemorySearchResponse["results"],
    semanticResults: PersistedMemorySearchResponse["results"],
  ): PersistedMemorySearchResponse["results"] {
    if (lexicalResults.length === 0) {
      return semanticResults.map((result) =>
        MemoryRetrievalRepository.cloneSearchResult(result),
      );
    }

    if (semanticResults.length === 0) {
      return lexicalResults.map((result) =>
        MemoryRetrievalRepository.cloneSearchResult(result),
      );
    }

    const mergedResults: PersistedMemorySearchResponse["results"] = [];
    const resultsById = new Map(
      mergedResults.map((result) => [result.id, result] as const),
    );

    const applyHybridBranch = (
      branchResults: PersistedMemorySearchResponse["results"],
      branchSource: "lexical" | "semantic",
    ): void => {
      for (const [index, branchResult] of branchResults.entries()) {
        const existingResult = resultsById.get(branchResult.id);
        const reciprocalRankScore = 1 / (MEMORY_RETRIEVAL_RRF_K + index + 1);

        if (!existingResult) {
          const appendedResult = MemoryRetrievalRepository.cloneSearchResult(
            branchResult,
          );

          appendedResult.score = reciprocalRankScore;
          mergedResults.push(appendedResult);
          resultsById.set(appendedResult.id, appendedResult);
          continue;
        }

        existingResult.score += reciprocalRankScore;
        MemoryRetrievalRepository.appendMatchedBy(existingResult, branchSource);

        if (branchSource === "lexical") {
          existingResult.lexical_score = branchResult.lexical_score;
        }

        if (branchSource === "semantic") {
          existingResult.semantic_score = branchResult.semantic_score;
        }

        if (existingResult.matched_by.length > 1) {
          existingResult.source = "hybrid";
        }
      }
    };

    applyHybridBranch(lexicalResults, "lexical");
    applyHybridBranch(semanticResults, "semantic");

    mergedResults.sort((leftResult, rightResult) => {
      if (leftResult.score !== rightResult.score) {
        return rightResult.score - leftResult.score;
      }

      if (leftResult.is_pinned !== rightResult.is_pinned) {
        return leftResult.is_pinned ? -1 : 1;
      }

      if (leftResult.updated_at !== rightResult.updated_at) {
        return leftResult.updated_at < rightResult.updated_at ? 1 : -1;
      }

      return leftResult.id.localeCompare(rightResult.id);
    });

    return mergedResults;
  }

  private static mergePathBranchResults(
    pathResults: PersistedMemorySearchResponse["results"],
    hybridResults: PersistedMemorySearchResponse["results"],
  ): PersistedMemorySearchResponse["results"] {
    const mergedResults = pathResults.map((result) =>
      MemoryRetrievalRepository.cloneSearchResult(result),
    );
    const resultsById = new Map(
      mergedResults.map((result) => [result.id, result] as const),
    );

    for (const hybridResult of hybridResults) {
      const existingResult = resultsById.get(hybridResult.id);

      if (!existingResult) {
        const appendedResult =
          MemoryRetrievalRepository.cloneSearchResult(hybridResult);

        mergedResults.push(appendedResult);
        resultsById.set(appendedResult.id, appendedResult);
        continue;
      }

      for (const matchedBySource of hybridResult.matched_by) {
        MemoryRetrievalRepository.appendMatchedBy(existingResult, matchedBySource);
      }

      if (hybridResult.lexical_score !== null) {
        existingResult.lexical_score = hybridResult.lexical_score;
      }

      if (hybridResult.semantic_score !== null) {
        existingResult.semantic_score = hybridResult.semantic_score;
      }
    }

    return mergedResults;
  }

  static searchMemories(
    database: DatabaseSync,
    options: SearchMemoriesOptions,
  ): PersistedMemorySearchResponse {
    const normalizedQuery = normalizeNonEmptyString(options.query);
    const hasQueryEmbedding = options.queryEmbedding !== undefined;
    const hasRelatedPaths = (options.relatedPaths ?? []).length > 0;

    if (!normalizedQuery && !hasQueryEmbedding && !hasRelatedPaths) {
      throw new Error(
        "Memory retrieval requires a non-empty query, query embedding, related paths, or any combination of them.",
      );
    }

    let pathResponse: PersistedMemorySearchResponse | null = null;
    let lexicalResponse: PersistedMemorySearchResponse | null = null;
    let semanticResponse: PersistedMemorySearchResponse | null = null;

    if (hasRelatedPaths) {
      pathResponse = MemoryRepository.searchMemoriesByPaths(database, {
        relatedPaths: options.relatedPaths ?? [],
        spaceId: options.spaceId,
        limit: options.limit,
      });
    }

    if (normalizedQuery) {
      lexicalResponse = MemoryRepository.searchMemoriesByTags(database, {
        query: normalizedQuery,
        spaceId: options.spaceId,
        limit: options.limit,
      });
    }

    if (options.queryEmbedding) {
      semanticResponse = MemoryRepository.searchMemoriesBySemantic(database, {
        queryEmbedding: options.queryEmbedding,
        spaceId: options.spaceId,
        limit: options.limit,
      });
    }

    const space =
      pathResponse?.space ?? lexicalResponse?.space ?? semanticResponse?.space;

    if (!space) {
      throw new Error(`Unable to find memory space "${options.spaceId}".`);
    }

    const hybridResults = MemoryRetrievalRepository.mergeHybridBranchResults(
      lexicalResponse?.results ?? [],
      semanticResponse?.results ?? [],
    );
    const mergedResults = MemoryRetrievalRepository.mergePathBranchResults(
      pathResponse?.results ?? [],
      hybridResults,
    );
    const limit = options.limit ?? 10;

    return {
      space,
      results: mergedResults.slice(0, limit),
    };
  }

  static searchAllMemories(
    database: DatabaseSync,
    options: SearchAllMemoriesOptions,
  ): PersistedMemorySearchResponse["results"] {
    const normalizedQuery = normalizeNonEmptyString(options.query);
    const hasQueryEmbedding = options.queryEmbedding !== undefined;

    if (!normalizedQuery && !hasQueryEmbedding) {
      throw new Error(
        "All-space memory retrieval requires a non-empty query, query embedding, or both.",
      );
    }

    const lexicalResults = normalizedQuery
      ? MemoryRepository.searchAllMemoriesByTags(database, {
          query: normalizedQuery,
          limit: options.limit,
        })
      : [];
    const semanticResults = options.queryEmbedding
      ? MemoryRepository.searchAllMemoriesBySemantic(database, {
          queryEmbedding: options.queryEmbedding,
          limit: options.limit,
        })
      : [];
    const limit = options.limit ?? 10;

    return MemoryRetrievalRepository.mergeHybridBranchResults(
      lexicalResults,
      semanticResults,
    ).slice(0, limit);
  }
}

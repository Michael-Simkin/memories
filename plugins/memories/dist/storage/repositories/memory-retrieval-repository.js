import { normalizeNonEmptyString } from "../../shared/utils/strings.js";
import { MemoryRepository } from "./memory-repository.js";
class MemoryRetrievalRepository {
  static mergeBranchResults(pathResults, lexicalResults) {
    const mergedResults = pathResults.map((result) => ({
      ...result,
      matched_by: [...result.matched_by]
    }));
    const resultsById = new Map(
      mergedResults.map((result) => [result.id, result])
    );
    for (const lexicalResult of lexicalResults) {
      const existingResult = resultsById.get(lexicalResult.id);
      if (!existingResult) {
        const appendedResult = {
          ...lexicalResult,
          matched_by: [...lexicalResult.matched_by]
        };
        mergedResults.push(appendedResult);
        resultsById.set(appendedResult.id, appendedResult);
        continue;
      }
      if (!existingResult.matched_by.includes("lexical")) {
        existingResult.matched_by.push("lexical");
      }
      existingResult.lexical_score = lexicalResult.lexical_score;
    }
    return mergedResults;
  }
  static searchMemories(database, options) {
    const normalizedQuery = normalizeNonEmptyString(options.query);
    const hasRelatedPaths = (options.relatedPaths ?? []).length > 0;
    if (!normalizedQuery && !hasRelatedPaths) {
      throw new Error(
        "Memory retrieval requires a non-empty query, related paths, or both."
      );
    }
    let pathResponse = null;
    let lexicalResponse = null;
    if (hasRelatedPaths) {
      pathResponse = MemoryRepository.searchMemoriesByPaths(database, {
        relatedPaths: options.relatedPaths ?? [],
        spaceId: options.spaceId,
        limit: options.limit
      });
    }
    if (normalizedQuery) {
      lexicalResponse = MemoryRepository.searchMemoriesByTags(database, {
        query: normalizedQuery,
        spaceId: options.spaceId,
        limit: options.limit
      });
    }
    const space = pathResponse?.space ?? lexicalResponse?.space;
    if (!space) {
      throw new Error(`Unable to find memory space "${options.spaceId}".`);
    }
    const mergedResults = MemoryRetrievalRepository.mergeBranchResults(
      pathResponse?.results ?? [],
      lexicalResponse?.results ?? []
    );
    const limit = options.limit ?? 10;
    return {
      space,
      results: mergedResults.slice(0, limit)
    };
  }
}
export {
  MemoryRetrievalRepository
};

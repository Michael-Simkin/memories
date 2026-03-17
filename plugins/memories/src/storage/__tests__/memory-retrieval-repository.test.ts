import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
import { MemoryRepository } from "../repositories/memory-repository.js";
import { MemoryRetrievalRepository } from "../repositories/memory-retrieval-repository.js";
import { SpaceRegistryRepository } from "../repositories/space-registry-repository.js";

function createResolution(
  resolvedWorkingPath: string,
  git: GitInspection,
): ActiveMemorySpaceResolution {
  return {
    workingContext: {
      source: "cwd",
      selectedWorkingPath: resolvedWorkingPath,
      resolvedWorkingPath,
    },
    git,
    space: MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath,
      git,
    }),
  };
}

function touchSpace(
  database: ReturnType<typeof DatabaseBootstrapRepository.bootstrapDatabase>["database"],
  resolvedWorkingPath: string,
  observedAt: string,
) {
  return SpaceRegistryRepository.touchResolvedMemorySpace(database, {
    resolution: createResolution(resolvedWorkingPath, {
      insideWorkTree: false,
    }),
    observedAt,
  });
}

describe("MemoryRetrievalRepository", () => {
  it("merges path and lexical branches while keeping path hits first", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      const primarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-a",
        "2026-03-14T11:00:00.000Z",
      );
      const secondarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-b",
        "2026-03-14T11:01:00.000Z",
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "path-and-lexical",
        spaceId: primarySpace.space.id,
        memoryType: "rule",
        content: "This memory should match both branches.",
        tags: ["release"],
        pathMatchers: ["src/features/feature.ts"],
        updatedAt: "2026-03-14T11:10:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "path-only",
        spaceId: primarySpace.space.id,
        memoryType: "rule",
        content: "This memory should match only the path branch.",
        pathMatchers: ["src/features"],
        updatedAt: "2026-03-14T11:09:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "lexical-only",
        spaceId: primarySpace.space.id,
        memoryType: "fact",
        content: "This memory should match only the lexical branch.",
        tags: ["release"],
        updatedAt: "2026-03-14T11:08:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "wrong-space",
        spaceId: secondarySpace.space.id,
        memoryType: "fact",
        content: "This memory belongs to another space.",
        tags: ["release"],
        pathMatchers: ["src/features/feature.ts"],
      });

      const searchResult = MemoryRetrievalRepository.searchMemories(
        bootstrapResult.database,
        {
          spaceId: primarySpace.space.id,
          query: "release",
          relatedPaths: ["src/features/feature.ts:18"],
        },
      );
      const firstResult = searchResult.results[0];
      const secondResult = searchResult.results[1];
      const thirdResult = searchResult.results[2];

      assert.deepEqual(
        searchResult.results.map((result) => result.id),
        ["path-and-lexical", "path-only", "lexical-only"],
      );
      assert.ok(firstResult);
      assert.equal(firstResult.source, "path");
      assert.deepEqual(firstResult.matched_by, ["path", "lexical"]);
      assert.equal(typeof firstResult.path_score, "number");
      assert.equal(typeof firstResult.lexical_score, "number");

      assert.ok(secondResult);
      assert.equal(secondResult.source, "path");
      assert.deepEqual(secondResult.matched_by, ["path"]);
      assert.equal(typeof secondResult.path_score, "number");
      assert.equal(secondResult.lexical_score, null);

      assert.ok(thirdResult);
      assert.equal(thirdResult.source, "lexical");
      assert.deepEqual(thirdResult.matched_by, ["lexical"]);
      assert.equal(thirdResult.path_score, null);
      assert.equal(typeof thirdResult.lexical_score, "number");
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("requires at least one query or related path input", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      const primarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-a",
        "2026-03-14T11:30:00.000Z",
      );

      assert.throws(
        () =>
          MemoryRetrievalRepository.searchMemories(bootstrapResult.database, {
            spaceId: primarySpace.space.id,
            query: "   ",
            relatedPaths: [],
          }),
        /requires a non-empty query, related paths, or both/u,
      );
    } finally {
      bootstrapResult.database.close();
    }
  });
});

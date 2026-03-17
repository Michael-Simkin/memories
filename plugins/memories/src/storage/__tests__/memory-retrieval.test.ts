import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
import { MemoryRepository } from "../repositories/memory-repository.js";
import { SpaceRegistryRepository } from "../repositories/space-registry-repository.js";
import { MEMORY_SEMANTIC_DIMENSIONS } from "../../shared/constants/embeddings.js";

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

function createUnitVector(index: number): number[] {
  const embedding = Array.from({ length: MEMORY_SEMANTIC_DIMENSIONS }, () => 0);
  embedding[index] = 1;

  return embedding;
}

describe("MemoryRepository retrieval", () => {
  it("lists pinned memories only for the requested space", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      const primarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-a",
        "2026-03-14T08:00:00.000Z",
      );
      const secondarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-b",
        "2026-03-14T08:01:00.000Z",
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "primary-pinned",
        spaceId: primarySpace.space.id,
        memoryType: "rule",
        content: "Use explicit SQL transactions.",
        tags: ["storage"],
        isPinned: true,
        pathMatchers: ["plugins/memories/src/storage/**"],
        createdAt: "2026-03-14T08:10:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "primary-unpinned",
        spaceId: primarySpace.space.id,
        memoryType: "fact",
        content: "This should not appear in pinned retrieval.",
        tags: ["noise"],
        isPinned: false,
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "secondary-pinned",
        spaceId: secondarySpace.space.id,
        memoryType: "decision",
        content: "This belongs to another space.",
        tags: ["storage"],
        isPinned: true,
      });

      const pinnedResult = MemoryRepository.listPinnedMemories(
        bootstrapResult.database,
        {
          spaceId: primarySpace.space.id,
        },
      );

      assert.deepEqual(pinnedResult.space, {
        space_id: primarySpace.space.id,
        space_kind: "directory",
        space_display_name: primarySpace.space.displayName,
        origin_url_normalized: null,
      });
      assert.deepEqual(
        pinnedResult.memories.map((memory) => memory.id),
        ["primary-pinned"],
      );
      assert.deepEqual(pinnedResult.memories[0]?.path_matchers, [
        "plugins/memories/src/storage/**",
      ]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("searches tags only and stays scoped to the requested space", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      const primarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-a",
        "2026-03-14T09:00:00.000Z",
      );
      const secondarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-b",
        "2026-03-14T09:01:00.000Z",
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "lexical-hit",
        spaceId: primarySpace.space.id,
        memoryType: "fact",
        content: "Review the Friday deploy checklist.",
        tags: ["release", "deploy"],
        isPinned: true,
        createdAt: "2026-03-14T09:05:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "content-only",
        spaceId: primarySpace.space.id,
        memoryType: "fact",
        content: "Friday is mentioned here, but not in tags.",
        tags: ["notes"],
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "wrong-space",
        spaceId: secondarySpace.space.id,
        memoryType: "fact",
        content: "Release tag exists, but not in the active space.",
        tags: ["release"],
      });

      const lexicalResult = MemoryRepository.searchMemoriesByTags(
        bootstrapResult.database,
        {
          spaceId: primarySpace.space.id,
          query: "release",
        },
      );
      const contentOnlyResult = MemoryRepository.searchMemoriesByTags(
        bootstrapResult.database,
        {
          spaceId: primarySpace.space.id,
          query: "friday",
        },
      );

      assert.deepEqual(lexicalResult.space, {
        space_id: primarySpace.space.id,
        space_kind: "directory",
        space_display_name: primarySpace.space.displayName,
        origin_url_normalized: null,
      });
      assert.deepEqual(
        lexicalResult.results.map((result) => result.id),
        ["lexical-hit"],
      );
      const firstResult = lexicalResult.results[0];

      assert.ok(firstResult);
      assert.equal(firstResult.source, "lexical");
      assert.deepEqual(firstResult.matched_by, ["lexical"]);
      assert.equal(firstResult.path_score, null);
      assert.equal(firstResult.semantic_score, null);
      assert.equal(typeof firstResult.lexical_score, "number");
      assert.deepEqual(contentOnlyResult.results, []);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("searches path matchers and ranks exact file above dir and glob matches", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      const primarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-a",
        "2026-03-14T10:00:00.000Z",
      );
      const secondarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-b",
        "2026-03-14T10:01:00.000Z",
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "exact-file",
        spaceId: primarySpace.space.id,
        memoryType: "rule",
        content: "Exact file match should win.",
        pathMatchers: ["src/features/feature.ts"],
        updatedAt: "2026-03-14T10:10:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "exact-dir",
        spaceId: primarySpace.space.id,
        memoryType: "rule",
        content: "Exact directory match should come next.",
        pathMatchers: ["src/features"],
        updatedAt: "2026-03-14T10:11:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "single-glob",
        spaceId: primarySpace.space.id,
        memoryType: "rule",
        content: "Single-glob match should follow the directory.",
        pathMatchers: ["src/features/*.ts"],
        updatedAt: "2026-03-14T10:12:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "deep-glob",
        spaceId: primarySpace.space.id,
        memoryType: "rule",
        content: "Deep-glob match should rank last despite being pinned.",
        isPinned: true,
        pathMatchers: ["src/**/*.ts"],
        updatedAt: "2026-03-14T10:13:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "wrong-space-path",
        spaceId: secondarySpace.space.id,
        memoryType: "rule",
        content: "This path match belongs to another space.",
        pathMatchers: ["src/features/feature.ts"],
      });

      const pathResult = MemoryRepository.searchMemoriesByPaths(
        bootstrapResult.database,
        {
          spaceId: primarySpace.space.id,
          relatedPaths: ["./src/features/feature.ts:44"],
        },
      );
      const firstResult = pathResult.results[0];

      assert.deepEqual(
        pathResult.results.map((result) => result.id),
        ["exact-file", "exact-dir", "single-glob", "deep-glob"],
      );
      assert.ok(firstResult);
      assert.equal(firstResult.source, "path");
      assert.deepEqual(firstResult.matched_by, ["path"]);
      assert.equal(firstResult.lexical_score, null);
      assert.equal(firstResult.semantic_score, null);
      assert.equal(typeof firstResult.path_score, "number");
      assert.ok((pathResult.results[0]?.path_score ?? 0) > (pathResult.results[1]?.path_score ?? 0));
      assert.ok((pathResult.results[1]?.path_score ?? 0) > (pathResult.results[2]?.path_score ?? 0));
      assert.ok((pathResult.results[2]?.path_score ?? 0) > (pathResult.results[3]?.path_score ?? 0));
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("searches semantic embeddings only inside the requested space", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      const primarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-a",
        "2026-03-14T10:30:00.000Z",
      );
      const secondarySpace = touchSpace(
        bootstrapResult.database,
        "/workspace/project-b",
        "2026-03-14T10:31:00.000Z",
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "semantic-nearest",
        spaceId: primarySpace.space.id,
        memoryType: "fact",
        content: "Nearest semantic match.",
        semanticEmbedding: createUnitVector(0),
        updatedAt: "2026-03-14T10:40:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "semantic-next",
        spaceId: primarySpace.space.id,
        memoryType: "fact",
        content: "Second semantic match.",
        semanticEmbedding: createUnitVector(1),
        updatedAt: "2026-03-14T10:39:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "wrong-space-semantic",
        spaceId: secondarySpace.space.id,
        memoryType: "fact",
        content: "Semantic match in another space.",
        semanticEmbedding: createUnitVector(0),
      });

      const semanticResult = MemoryRepository.searchMemoriesBySemantic(
        bootstrapResult.database,
        {
          spaceId: primarySpace.space.id,
          queryEmbedding: createUnitVector(0),
        },
      );
      const firstResult = semanticResult.results[0];

      assert.deepEqual(
        semanticResult.results.map((result) => result.id),
        ["semantic-nearest", "semantic-next"],
      );
      assert.ok(firstResult);
      assert.equal(firstResult.source, "semantic");
      assert.deepEqual(firstResult.matched_by, ["semantic"]);
      assert.equal(firstResult.path_score, null);
      assert.equal(firstResult.lexical_score, null);
      assert.equal(typeof firstResult.semantic_score, "number");
      assert.ok((semanticResult.results[0]?.semantic_score ?? 0) > (semanticResult.results[1]?.semantic_score ?? 0));
    } finally {
      bootstrapResult.database.close();
    }
  });
});

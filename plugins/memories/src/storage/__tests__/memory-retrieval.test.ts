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
});

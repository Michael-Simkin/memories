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

function createSpace(databasePath = ":memory:") {
  const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
    databasePath,
  });
  const observedAt = "2026-03-14T03:00:00.000Z";
  const touchResult = SpaceRegistryRepository.touchResolvedMemorySpace(
    bootstrapResult.database,
    {
      resolution: createResolution("/workspace/project", {
        insideWorkTree: false,
      }),
      observedAt,
    },
  );

  return {
    bootstrapResult,
    observedAt,
    touchResult,
  };
}

describe("MemoryRepository", () => {
  it("creates a memory and returns space metadata plus normalized matchers", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      const memory = MemoryRepository.createMemory(bootstrapResult.database, {
        id: "memory-1",
        spaceId: touchResult.space.id,
        memoryType: "fact",
        content: "  Remember the release checklist.  ",
        tags: ["release", " checklist ", "release"],
        isPinned: true,
        pathMatchers: ["src/**", " docs/**/*.md ", "src/**"],
        createdAt: "2026-03-14T03:15:00.000Z",
      });
      const listedMemories = MemoryRepository.listMemories(bootstrapResult.database, {
        spaceId: touchResult.space.id,
      });

      assert.deepEqual(memory, {
        id: "memory-1",
        space_id: touchResult.space.id,
        space_kind: touchResult.space.spaceKind,
        space_display_name: touchResult.space.displayName,
        origin_url_normalized: touchResult.space.originUrlNormalized,
        memory_type: "fact",
        content: "Remember the release checklist.",
        tags: ["release", "checklist"],
        is_pinned: true,
        path_matchers: ["docs/**/*.md", "src/**"],
        created_at: "2026-03-14T03:15:00.000Z",
        updated_at: "2026-03-14T03:15:00.000Z",
      });
      assert.deepEqual(listedMemories, [memory]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("updates an existing memory and replaces its path matchers", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "memory-2",
        spaceId: touchResult.space.id,
        memoryType: "rule",
        content: "Prefer explicit transactions.",
        tags: ["sqlite"],
        pathMatchers: ["src/storage/**", "src/shared/**"],
        createdAt: "2026-03-14T04:00:00.000Z",
      });

      const updatedMemory = MemoryRepository.updateMemory(bootstrapResult.database, {
        memoryId: "memory-2",
        content: "Prefer explicit transactions for multi-table writes.",
        tags: ["sqlite", "transactions", "transactions"],
        isPinned: true,
        pathMatchers: ["src/storage/repositories/**"],
        updatedAt: "2026-03-14T04:30:00.000Z",
      });
      const storedPathMatchers = bootstrapResult.database
        .prepare(
          "select path_matcher from memory_path_matchers where memory_id = ? order by path_matcher;",
        )
        .all("memory-2")
        .map((row) => (row as { path_matcher: string }).path_matcher);

      assert.equal(updatedMemory.space_id, touchResult.space.id);
      assert.equal(updatedMemory.created_at, "2026-03-14T04:00:00.000Z");
      assert.equal(updatedMemory.updated_at, "2026-03-14T04:30:00.000Z");
      assert.equal(
        updatedMemory.content,
        "Prefer explicit transactions for multi-table writes.",
      );
      assert.deepEqual(updatedMemory.tags, ["sqlite", "transactions"]);
      assert.equal(updatedMemory.is_pinned, true);
      assert.deepEqual(updatedMemory.path_matchers, ["src/storage/repositories/**"]);
      assert.deepEqual(storedPathMatchers, ["src/storage/repositories/**"]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("deletes a memory and its path matchers", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "memory-3",
        spaceId: touchResult.space.id,
        memoryType: "decision",
        content: "Use one global engine.",
        pathMatchers: ["plugins/memories/**"],
      });

      MemoryRepository.deleteMemory(bootstrapResult.database, {
        memoryId: "memory-3",
      });

      const counts = bootstrapResult.database
        .prepare(
          "select (select count(*) from memories) as memory_count, (select count(*) from memory_path_matchers) as matcher_count;",
        )
        .get() as { matcher_count: number; memory_count: number };

      assert.equal(MemoryRepository.getMemoryById(bootstrapResult.database, "memory-3"), null);
      assert.deepEqual(
        {
          memory_count: counts.memory_count,
          matcher_count: counts.matcher_count,
        },
        {
          memory_count: 0,
          matcher_count: 0,
        },
      );
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("rejects absolute path matchers and rolls back the write", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      assert.throws(
        () =>
          MemoryRepository.createMemory(bootstrapResult.database, {
            id: "memory-4",
            spaceId: touchResult.space.id,
            memoryType: "episode",
            content: "This write should fail.",
            pathMatchers: ["/tmp/file.ts"],
          }),
        /Path matchers must be relative/,
      );

      const counts = bootstrapResult.database
        .prepare(
          "select (select count(*) from memories) as memory_count, (select count(*) from memory_path_matchers) as matcher_count;",
        )
        .get() as { matcher_count: number; memory_count: number };

      assert.deepEqual(
        {
          memory_count: counts.memory_count,
          matcher_count: counts.matcher_count,
        },
        {
          memory_count: 0,
          matcher_count: 0,
        },
      );
    } finally {
      bootstrapResult.database.close();
    }
  });
});

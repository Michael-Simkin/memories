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

function createUnitVector(index: number): number[] {
  const embedding = Array.from({ length: MEMORY_SEMANTIC_DIMENSIONS }, () => 0);
  embedding[index] = 1;

  return embedding;
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
      const rawFtsRow = bootstrapResult.database
        .prepare("select id, tags_text from memory_fts where id = ?;")
        .get("memory-1") as { id: string; tags_text: string } | undefined;
      const ftsRow = rawFtsRow
        ? {
            id: rawFtsRow.id,
            tags_text: rawFtsRow.tags_text,
          }
        : undefined;

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
      assert.deepEqual(ftsRow, {
        id: "memory-1",
        tags_text: "release\nchecklist",
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
        memoryType: "decision",
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
      const ftsMatches = bootstrapResult.database
        .prepare("select id from memory_fts where memory_fts match ? order by id;")
        .all("transactions")
        .map((row) => (row as { id: string }).id);

      assert.equal(updatedMemory.space_id, touchResult.space.id);
      assert.equal(updatedMemory.created_at, "2026-03-14T04:00:00.000Z");
      assert.equal(updatedMemory.updated_at, "2026-03-14T04:30:00.000Z");
      assert.equal(updatedMemory.memory_type, "decision");
      assert.equal(
        updatedMemory.content,
        "Prefer explicit transactions for multi-table writes.",
      );
      assert.deepEqual(updatedMemory.tags, ["sqlite", "transactions"]);
      assert.equal(updatedMemory.is_pinned, true);
      assert.deepEqual(updatedMemory.path_matchers, ["src/storage/repositories/**"]);
      assert.deepEqual(storedPathMatchers, ["src/storage/repositories/**"]);
      assert.deepEqual(ftsMatches, ["memory-2"]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("lists memories across all spaces when no space filter is provided", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      const firstTouch = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: createResolution("/workspace/project-a", {
            insideWorkTree: false,
          }),
          observedAt: "2026-03-14T04:45:00.000Z",
        },
      );
      const secondTouch = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: createResolution("/workspace/project-b", {
            insideWorkTree: false,
          }),
          observedAt: "2026-03-14T04:46:00.000Z",
        },
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "memory-all-spaces-b",
        spaceId: secondTouch.space.id,
        memoryType: "fact",
        content: "Second space memory.",
        updatedAt: "2026-03-14T04:50:00.000Z",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "memory-all-spaces-a",
        spaceId: firstTouch.space.id,
        memoryType: "fact",
        content: "First space memory.",
        updatedAt: "2026-03-14T04:49:00.000Z",
      });

      const listedMemories = MemoryRepository.listMemories(bootstrapResult.database, {});

      assert.deepEqual(
        listedMemories.map((memory) => memory.id),
        ["memory-all-spaces-b", "memory-all-spaces-a"],
      );
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("normalizes noisy path matchers before storing them", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      const memory = MemoryRepository.createMemory(bootstrapResult.database, {
        id: "memory-path-noise",
        spaceId: touchResult.space.id,
        memoryType: "fact",
        content: "Normalize path matcher noise before storage.",
        pathMatchers: ["./src/feature.ts:18", "src/feature.ts#L20-L30"],
      });

      assert.deepEqual(memory.path_matchers, ["src/feature.ts"]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("indexes tags in memory_fts but does not index main memory content", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "memory-fts-1",
        spaceId: touchResult.space.id,
        memoryType: "fact",
        content: "Ship the deployment checklist before Friday.",
        tags: ["release", "deploy"],
      });

      const tagMatches = bootstrapResult.database
        .prepare("select id from memory_fts where memory_fts match ? order by id;")
        .all("release")
        .map((row) => (row as { id: string }).id);
      const contentMatches = bootstrapResult.database
        .prepare("select id from memory_fts where memory_fts match ? order by id;")
        .all("friday")
        .map((row) => (row as { id: string }).id);

      assert.deepEqual(tagMatches, ["memory-fts-1"]);
      assert.deepEqual(contentMatches, []);
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
        tags: ["architecture"],
        pathMatchers: ["plugins/memories/**"],
      });

      MemoryRepository.deleteMemory(bootstrapResult.database, {
        memoryId: "memory-3",
      });

      const counts = bootstrapResult.database
        .prepare(
          "select (select count(*) from memories) as memory_count, (select count(*) from memory_path_matchers) as matcher_count, (select count(*) from memory_fts) as fts_count;",
        )
        .get() as { fts_count: number; matcher_count: number; memory_count: number };

      assert.equal(MemoryRepository.getMemoryById(bootstrapResult.database, "memory-3"), null);
      assert.deepEqual(
        {
          fts_count: counts.fts_count,
          memory_count: counts.memory_count,
          matcher_count: counts.matcher_count,
        },
        {
          fts_count: 0,
          memory_count: 0,
          matcher_count: 0,
        },
      );
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("syncs vec_memory on create, update, and delete", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "memory-semantic",
        spaceId: touchResult.space.id,
        memoryType: "fact",
        content: "Semantic storage should stay in sync.",
        semanticEmbedding: createUnitVector(0),
      });

      const createdNearestRows = bootstrapResult.database
        .prepare(`
          SELECT memory_id, distance
          FROM vec_memory
          WHERE embedding MATCH ? AND k = 1
          ORDER BY distance ASC;
        `)
        .all(JSON.stringify(createUnitVector(0)))
        .map((row) => ({
          memory_id: (row as { memory_id: string }).memory_id,
          distance: (row as { distance: number }).distance,
        }));

      MemoryRepository.updateMemory(bootstrapResult.database, {
        memoryId: "memory-semantic",
        content: "Semantic storage should update with a replacement embedding.",
        semanticEmbedding: createUnitVector(1),
      });

      const updatedNearestRows = bootstrapResult.database
        .prepare(`
          SELECT memory_id, distance
          FROM vec_memory
          WHERE embedding MATCH ? AND k = 1
          ORDER BY distance ASC;
        `)
        .all(JSON.stringify(createUnitVector(1)))
        .map((row) => ({
          memory_id: (row as { memory_id: string }).memory_id,
          distance: (row as { distance: number }).distance,
        }));

      MemoryRepository.updateMemory(bootstrapResult.database, {
        memoryId: "memory-semantic",
        content: "Semantic storage should clear stale vectors when content changes.",
      });

      const vecRowCountAfterClear = bootstrapResult.database
        .prepare("select count(*) as count from vec_memory;")
        .get() as { count: number };

      MemoryRepository.updateMemory(bootstrapResult.database, {
        memoryId: "memory-semantic",
        semanticEmbedding: createUnitVector(2),
      });
      MemoryRepository.deleteMemory(bootstrapResult.database, {
        memoryId: "memory-semantic",
      });

      const vecRowCountAfterDelete = bootstrapResult.database
        .prepare("select count(*) as count from vec_memory;")
        .get() as { count: number };

      assert.deepEqual(createdNearestRows, [
        { memory_id: "memory-semantic", distance: 0 },
      ]);
      assert.deepEqual(updatedNearestRows, [
        { memory_id: "memory-semantic", distance: 0 },
      ]);
      assert.equal(vecRowCountAfterClear.count, 0);
      assert.equal(vecRowCountAfterDelete.count, 0);
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
          "select (select count(*) from memories) as memory_count, (select count(*) from memory_path_matchers) as matcher_count, (select count(*) from memory_fts) as fts_count;",
        )
        .get() as { fts_count: number; matcher_count: number; memory_count: number };

      assert.deepEqual(
        {
          fts_count: counts.fts_count,
          memory_count: counts.memory_count,
          matcher_count: counts.matcher_count,
        },
        {
          fts_count: 0,
          memory_count: 0,
          matcher_count: 0,
        },
      );
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("rejects broad catch-all path matchers and rolls back the write", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      assert.throws(
        () =>
          MemoryRepository.createMemory(bootstrapResult.database, {
            id: "memory-5",
            spaceId: touchResult.space.id,
            memoryType: "episode",
            content: "This write should also fail.",
            pathMatchers: ["**/*"],
          }),
        /too broad/u,
      );

      const counts = bootstrapResult.database
        .prepare(
          "select (select count(*) from memories) as memory_count, (select count(*) from memory_path_matchers) as matcher_count, (select count(*) from memory_fts) as fts_count;",
        )
        .get() as { fts_count: number; matcher_count: number; memory_count: number };

      assert.deepEqual(
        {
          fts_count: counts.fts_count,
          memory_count: counts.memory_count,
          matcher_count: counts.matcher_count,
        },
        {
          fts_count: 0,
          memory_count: 0,
          matcher_count: 0,
        },
      );
    } finally {
      bootstrapResult.database.close();
    }
  });
});

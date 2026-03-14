import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
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

describe("SpaceRegistryRepository", () => {
  it("inserts a directory-scoped space and its observed root on first touch", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });
    const observedAt = "2026-03-14T01:00:00.000Z";
    const resolution = createResolution("/workspace/project", {
      insideWorkTree: false,
    });

    try {
      const touchResult = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution,
          observedAt,
        },
      );
      const counts = bootstrapResult.database
        .prepare(
          "select (select count(*) from memory_spaces) as space_count, (select count(*) from space_roots) as root_count;",
        )
        .get() as { space_count: number; root_count: number };
      const normalizedCounts = {
        space_count: counts.space_count,
        root_count: counts.root_count,
      };

      assert.equal(touchResult.space.spaceKey, resolution.space.spaceKey);
      assert.equal(touchResult.space.spaceKind, "directory");
      assert.equal(touchResult.space.lastSeenRootPath, "/workspace/project");
      assert.equal(touchResult.space.createdAt, observedAt);
      assert.equal(touchResult.space.updatedAt, observedAt);
      assert.equal(touchResult.space.lastSeenAt, observedAt);
      assert.equal(touchResult.root.spaceId, touchResult.space.id);
      assert.equal(touchResult.root.rootPath, "/workspace/project");
      assert.equal(touchResult.root.rootKind, "directory_root");
      assert.equal(touchResult.root.firstSeenAt, observedAt);
      assert.equal(touchResult.root.lastSeenAt, observedAt);
      assert.deepEqual(normalizedCounts, {
        space_count: 1,
        root_count: 1,
      });
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("updates last-seen metadata without duplicating rows when the same root is touched again", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });
    const firstObservedAt = "2026-03-14T01:00:00.000Z";
    const secondObservedAt = "2026-03-14T02:30:00.000Z";
    const resolution = createResolution("/workspace/project", {
      insideWorkTree: false,
    });

    try {
      const firstTouch = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution,
          observedAt: firstObservedAt,
        },
      );
      const secondTouch = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution,
          observedAt: secondObservedAt,
        },
      );
      const counts = bootstrapResult.database
        .prepare(
          "select (select count(*) from memory_spaces) as space_count, (select count(*) from space_roots) as root_count;",
        )
        .get() as { space_count: number; root_count: number };
      const normalizedCounts = {
        space_count: counts.space_count,
        root_count: counts.root_count,
      };

      assert.equal(secondTouch.space.id, firstTouch.space.id);
      assert.equal(secondTouch.space.createdAt, firstObservedAt);
      assert.equal(secondTouch.space.updatedAt, secondObservedAt);
      assert.equal(secondTouch.space.lastSeenAt, secondObservedAt);
      assert.equal(secondTouch.root.id, firstTouch.root.id);
      assert.equal(secondTouch.root.firstSeenAt, firstObservedAt);
      assert.equal(secondTouch.root.lastSeenAt, secondObservedAt);
      assert.deepEqual(normalizedCounts, {
        space_count: 1,
        root_count: 1,
      });
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("reuses one remote-scoped space across multiple roots with the same normalized origin", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });
    const firstResolution = createResolution("/workspace/clone-one/packages/app", {
      insideWorkTree: true,
      gitTopLevelPath: "/workspace/clone-one",
      originUrl: "git@github.com:Owner/Repo.git",
    });
    const secondResolution = createResolution("/workspace/clone-two/packages/app", {
      insideWorkTree: true,
      gitTopLevelPath: "/workspace/clone-two",
      originUrl: "https://github.com/Owner/Repo",
    });

    try {
      const firstTouch = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: firstResolution,
          observedAt: "2026-03-14T01:00:00.000Z",
        },
      );
      const secondTouch = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: secondResolution,
          observedAt: "2026-03-14T03:00:00.000Z",
        },
      );
      const persistedRoots = bootstrapResult.database
        .prepare(
          "select root_path from space_roots where space_id = ? order by root_path;",
        )
        .all(firstTouch.space.id)
        .map((row) => (row as { root_path: string }).root_path);

      assert.equal(firstTouch.space.spaceKind, "remote_repo");
      assert.equal(secondTouch.space.id, firstTouch.space.id);
      assert.equal(secondTouch.space.spaceKey, firstTouch.space.spaceKey);
      assert.equal(secondTouch.space.lastSeenRootPath, "/workspace/clone-two");
      assert.equal(
        secondTouch.space.originUrlNormalized,
        "github.com/Owner/Repo",
      );
      assert.deepEqual(persistedRoots, [
        "/workspace/clone-one",
        "/workspace/clone-two",
      ]);
    } finally {
      bootstrapResult.database.close();
    }
  });
});

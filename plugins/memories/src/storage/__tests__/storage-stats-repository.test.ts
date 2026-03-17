import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
import { LearningJobRepository } from "../repositories/learning-job-repository.js";
import { MemoryRepository } from "../repositories/memory-repository.js";
import { SpaceRegistryRepository } from "../repositories/space-registry-repository.js";
import { StorageStatsRepository } from "../repositories/storage-stats-repository.js";

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

describe("StorageStatsRepository", () => {
  it("returns aggregate memory, space, and queue counts", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      const firstSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: createResolution("/workspace/project-a", {
            insideWorkTree: false,
          }),
          observedAt: "2026-03-14T08:00:00.000Z",
        },
      );
      const secondSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: createResolution("/workspace/project-b", {
            insideWorkTree: false,
          }),
          observedAt: "2026-03-14T08:01:00.000Z",
        },
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "stats-memory-a",
        spaceId: firstSpace.space.id,
        memoryType: "fact",
        content: "First memory.",
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "stats-memory-b",
        spaceId: secondSpace.space.id,
        memoryType: "rule",
        content: "Second memory.",
      });
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "stats-job-pending",
        spaceId: firstSpace.space.id,
        rootPath: "/workspace/project-a",
        transcriptPath: "/tmp/project-a.jsonl",
      });
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "stats-job-running",
        spaceId: secondSpace.space.id,
        rootPath: "/workspace/project-b",
        transcriptPath: "/tmp/project-b.jsonl",
        state: "running",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-03-14T08:30:00.000Z",
      });

      assert.deepEqual(StorageStatsRepository.getStats(bootstrapResult.database), {
        totalSpaces: 2,
        totalMemories: 2,
        queuedJobs: 1,
        runningJobs: 1,
      });
    } finally {
      bootstrapResult.database.close();
    }
  });
});

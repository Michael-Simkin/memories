import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
import { LearningJobRepository } from "../repositories/learning-job-repository.js";
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
  const observedAt = "2026-03-14T06:00:00.000Z";
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
    touchResult,
  };
}

describe("LearningJobRepository", () => {
  it("enqueues jobs and lists them in queue order", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      const firstJob = LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-1",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-1.md",
        lastAssistantMessage: "  summarize it  ",
        enqueuedAt: "2026-03-14T06:10:00.000Z",
      });
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-2",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-2.md",
        state: "leased",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-03-14T06:20:00.000Z",
        enqueuedAt: "2026-03-14T06:11:00.000Z",
      });
      const queuedJobs = LearningJobRepository.listLearningJobs(
        bootstrapResult.database,
        {
          spaceId: touchResult.space.id,
        },
      );
      const leasedJobs = LearningJobRepository.listLearningJobs(
        bootstrapResult.database,
        {
          state: "leased",
        },
      );

      assert.deepEqual(firstJob, {
        id: "job-1",
        space_id: touchResult.space.id,
        root_path: "/workspace/project",
        transcript_path: "/tmp/transcript-1.md",
        last_assistant_message: "summarize it",
        session_id: null,
        state: "pending",
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: 0,
        error_text: null,
        enqueued_at: "2026-03-14T06:10:00.000Z",
        started_at: null,
        finished_at: null,
        updated_at: "2026-03-14T06:10:00.000Z",
      });
      assert.deepEqual(
        queuedJobs.map((job) => job.id),
        ["job-1", "job-2"],
      );
      assert.deepEqual(
        leasedJobs.map((job) => job.id),
        ["job-2"],
      );
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("updates leasing state and can clear nullable fields again", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-lease",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-lease.md",
      });

      const leasedJob = LearningJobRepository.updateLearningJob(
        bootstrapResult.database,
        {
          jobId: "job-lease",
          state: "leased",
          leaseOwner: "worker-7",
          leaseExpiresAt: "2026-03-14T06:30:00.000Z",
          attemptCount: 1,
          updatedAt: "2026-03-14T06:15:00.000Z",
        },
      );
      const clearedJob = LearningJobRepository.updateLearningJob(
        bootstrapResult.database,
        {
          jobId: "job-lease",
          state: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          errorText: "  model timeout  ",
          finishedAt: "2026-03-14T06:31:00.000Z",
          updatedAt: "2026-03-14T06:31:00.000Z",
        },
      );

      assert.equal(leasedJob.state, "leased");
      assert.equal(leasedJob.lease_owner, "worker-7");
      assert.equal(leasedJob.lease_expires_at, "2026-03-14T06:30:00.000Z");
      assert.equal(leasedJob.attempt_count, 1);

      assert.equal(clearedJob.state, "failed");
      assert.equal(clearedJob.lease_owner, null);
      assert.equal(clearedJob.lease_expires_at, null);
      assert.equal(clearedJob.error_text, "model timeout");
      assert.equal(clearedJob.finished_at, "2026-03-14T06:31:00.000Z");
      assert.equal(clearedJob.updated_at, "2026-03-14T06:31:00.000Z");
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("rejects invalid attempt counts without mutating the stored job", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-invalid",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-invalid.md",
      });

      assert.throws(
        () =>
          LearningJobRepository.updateLearningJob(bootstrapResult.database, {
            jobId: "job-invalid",
            attemptCount: -1,
          }),
        /attemptCount must be a non-negative integer/u,
      );

      const storedJob = LearningJobRepository.getLearningJobById(
        bootstrapResult.database,
        "job-invalid",
      );

      assert.ok(storedJob);
      assert.equal(storedJob.attempt_count, 0);
      assert.equal(storedJob.state, "pending");
    } finally {
      bootstrapResult.database.close();
    }
  });
});

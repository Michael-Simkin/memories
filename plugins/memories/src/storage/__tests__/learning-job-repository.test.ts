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
        space_kind: "directory",
        space_display_name: "/workspace/project",
        origin_url_normalized: null,
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
      assert.equal(queuedJobs[0]?.space_display_name, "/workspace/project");
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

  it("reuses active jobs for the same enqueue key and allows re-enqueue after completion", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      const firstJob = LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-dedupe-first",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-dedupe.md",
        enqueueKey: "enqueue-key-1",
        enqueuedAt: "2026-03-14T06:32:00.000Z",
      });
      const duplicateJob = LearningJobRepository.enqueueLearningJob(
        bootstrapResult.database,
        {
          id: "job-dedupe-second",
          spaceId: touchResult.space.id,
          rootPath: "/workspace/project",
          transcriptPath: "/tmp/transcript-dedupe.md",
          enqueueKey: "enqueue-key-1",
          enqueuedAt: "2026-03-14T06:33:00.000Z",
        },
      );
      const leasedJob = LearningJobRepository.leaseNextLearningJob(
        bootstrapResult.database,
        {
          leaseOwner: "worker-dedupe",
          leaseDurationMs: 60_000,
          leasedAt: "2026-03-14T06:34:00.000Z",
        },
      );

      assert.ok(leasedJob);

      const startedJob = LearningJobRepository.startLearningJob(
        bootstrapResult.database,
        {
          jobId: leasedJob.id,
          leaseOwner: "worker-dedupe",
          startedAt: "2026-03-14T06:34:05.000Z",
        },
      );

      assert.ok(startedJob);

      const completedJob = LearningJobRepository.completeLearningJob(
        bootstrapResult.database,
        {
          jobId: leasedJob.id,
          leaseOwner: "worker-dedupe",
          finishedAt: "2026-03-14T06:35:00.000Z",
        },
      );

      assert.ok(completedJob);

      const requeuedJob = LearningJobRepository.enqueueLearningJob(
        bootstrapResult.database,
        {
          id: "job-dedupe-third",
          spaceId: touchResult.space.id,
          rootPath: "/workspace/project",
          transcriptPath: "/tmp/transcript-dedupe.md",
          enqueueKey: "enqueue-key-1",
          enqueuedAt: "2026-03-14T06:36:00.000Z",
        },
      );
      const queuedJobs = LearningJobRepository.listLearningJobs(
        bootstrapResult.database,
        {
          spaceId: touchResult.space.id,
        },
      );

      assert.equal(firstJob.id, "job-dedupe-first");
      assert.equal(duplicateJob.id, "job-dedupe-first");
      assert.equal(requeuedJob.id, "job-dedupe-third");
      assert.deepEqual(
        queuedJobs.map((job) => job.id),
        ["job-dedupe-first", "job-dedupe-third"],
      );
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

  it("leases the oldest pending job and increments the attempt count", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-lease-first",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-lease-first.md",
        enqueuedAt: "2026-03-14T06:40:00.000Z",
      });
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-lease-second",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-lease-second.md",
        enqueuedAt: "2026-03-14T06:41:00.000Z",
      });

      const leasedJob = LearningJobRepository.leaseNextLearningJob(
        bootstrapResult.database,
        {
          leaseOwner: "worker-lease-1",
          leaseDurationMs: 60_000,
          leasedAt: "2026-03-14T06:45:00.000Z",
        },
      );

      assert.ok(leasedJob);
      assert.equal(leasedJob.id, "job-lease-first");
      assert.equal(leasedJob.state, "leased");
      assert.equal(leasedJob.lease_owner, "worker-lease-1");
      assert.equal(leasedJob.lease_expires_at, "2026-03-14T06:46:00.000Z");
      assert.equal(leasedJob.attempt_count, 1);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("does not lease a new job while another live lease exists", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-live-lease",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-live-lease.md",
        state: "leased",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-03-14T06:55:00.000Z",
        attemptCount: 1,
        enqueuedAt: "2026-03-14T06:50:00.000Z",
      });
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-pending-lease",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-pending-lease.md",
        enqueuedAt: "2026-03-14T06:51:00.000Z",
      });

      const leasedJob = LearningJobRepository.leaseNextLearningJob(
        bootstrapResult.database,
        {
          leaseOwner: "worker-2",
          leaseDurationMs: 60_000,
          leasedAt: "2026-03-14T06:54:00.000Z",
        },
      );

      assert.equal(leasedJob, null);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("reclaims stale leased jobs when their lease has expired", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-stale-lease",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-stale-lease.md",
        state: "leased",
        leaseOwner: "worker-old",
        leaseExpiresAt: "2026-03-14T06:59:00.000Z",
        attemptCount: 1,
        enqueuedAt: "2026-03-14T06:55:00.000Z",
      });

      const leasedJob = LearningJobRepository.leaseNextLearningJob(
        bootstrapResult.database,
        {
          leaseOwner: "worker-new",
          leaseDurationMs: 120_000,
          leasedAt: "2026-03-14T07:00:00.000Z",
        },
      );

      assert.ok(leasedJob);
      assert.equal(leasedJob.id, "job-stale-lease");
      assert.equal(leasedJob.lease_owner, "worker-new");
      assert.equal(leasedJob.lease_expires_at, "2026-03-14T07:02:00.000Z");
      assert.equal(leasedJob.attempt_count, 2);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("starts, heartbeats, and finalizes a leased job for the active lease owner", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "job-active-transition",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/transcript-active-transition.md",
      });

      const leasedJob = LearningJobRepository.leaseNextLearningJob(
        bootstrapResult.database,
        {
          leaseOwner: "worker-active",
          leaseDurationMs: 60_000,
          leasedAt: "2026-03-14T07:10:00.000Z",
        },
      );

      assert.ok(leasedJob);

      const startedJob = LearningJobRepository.startLearningJob(
        bootstrapResult.database,
        {
          jobId: "job-active-transition",
          leaseOwner: "worker-active",
          startedAt: "2026-03-14T07:10:05.000Z",
        },
      );
      const heartbeatedJob = LearningJobRepository.heartbeatLearningJob(
        bootstrapResult.database,
        {
          jobId: "job-active-transition",
          leaseOwner: "worker-active",
          leaseDurationMs: 120_000,
          heartbeatedAt: "2026-03-14T07:11:00.000Z",
        },
      );
      const failedOwnerStart = LearningJobRepository.startLearningJob(
        bootstrapResult.database,
        {
          jobId: "job-active-transition",
          leaseOwner: "worker-other",
          startedAt: "2026-03-14T07:11:05.000Z",
        },
      );
      const skippedJob = LearningJobRepository.skipLearningJob(
        bootstrapResult.database,
        {
          jobId: "job-active-transition",
          leaseOwner: "worker-active",
          finishedAt: "2026-03-14T07:12:00.000Z",
          errorText: "transcript missing",
        },
      );

      assert.ok(startedJob);
      assert.equal(startedJob.state, "running");
      assert.equal(startedJob.started_at, "2026-03-14T07:10:05.000Z");

      assert.ok(heartbeatedJob);
      assert.equal(heartbeatedJob.lease_expires_at, "2026-03-14T07:13:00.000Z");

      assert.equal(failedOwnerStart, null);

      assert.ok(skippedJob);
      assert.equal(skippedJob.state, "skipped");
      assert.equal(skippedJob.lease_owner, null);
      assert.equal(skippedJob.lease_expires_at, null);
      assert.equal(skippedJob.error_text, "transcript missing");
      assert.equal(skippedJob.finished_at, "2026-03-14T07:12:00.000Z");
    } finally {
      bootstrapResult.database.close();
    }
  });
});

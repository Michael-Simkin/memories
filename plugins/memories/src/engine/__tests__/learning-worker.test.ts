import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { EventRepository } from "../../storage/repositories/event-repository.js";
import { DatabaseBootstrapRepository } from "../../storage/repositories/database-bootstrap-repository.js";
import { LearningJobRepository } from "../../storage/repositories/learning-job-repository.js";
import { MemoryRepository } from "../../storage/repositories/memory-repository.js";
import { SpaceRegistryRepository } from "../../storage/repositories/space-registry-repository.js";
import { startLearningWorker } from "../learning-worker.js";

const TEST_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

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

async function waitForJobState(
  database: Parameters<typeof LearningJobRepository.getLearningJobById>[0],
  jobId: string,
  expectedState: string,
): Promise<NonNullable<ReturnType<typeof LearningJobRepository.getLearningJobById>>> {
  const deadline = Date.now() + 4_000;

  while (Date.now() < deadline) {
    const job = LearningJobRepository.getLearningJobById(database, jobId);

    if (job?.state === expectedState) {
      return job;
    }

    await sleep(25);
  }

  throw new Error(`Timed out waiting for learning job "${jobId}" to reach ${expectedState}.`);
}

describe("startLearningWorker", () => {
  it("processes queued jobs and writes high-confidence memories", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory("claude-memory-worker-home-");
    const workspacePath = await createTempDirectory("claude-memory-worker-workspace-");
    const transcriptPath = path.join(workspacePath, "transcript.jsonl");
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });
    let learningWorker: ReturnType<typeof startLearningWorker> | null = null;

    testContext.after(async () => {
      await learningWorker?.close();
      bootstrapResult.database.close();
      await removePath(workspacePath);
      await removePath(claudeMemoryHome);
    });

    await writeFile(
      transcriptPath,
      [
        '{"event":"assistant","text":"Remember that the engine-owned worker should stay enabled."}',
        '{"event":"tool","path":"src/engine/learning-worker.ts"}',
      ].join("\n"),
      "utf8",
    );

    const touchedSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
      bootstrapResult.database,
      {
        resolution: createResolution(workspacePath, {
          insideWorkTree: false,
        }),
      },
    );
    LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
      id: "worker-job-success",
      spaceId: touchedSpace.space.id,
      rootPath: workspacePath,
      transcriptPath,
    });

    learningWorker = startLearningWorker({
      database: bootstrapResult.database,
      embedText: () => Promise.resolve(undefined),
      heartbeatIntervalMs: 40,
      leaseDurationMs: 200,
      pollIntervalMs: 20,
      runLearningModel: () =>
        Promise.resolve({
          summary: "Persist the engine-owned worker guidance.",
          actions: [
            {
              type: "create",
              confidence: "high",
              reason: "The transcript states a durable implementation constraint.",
              memory_type: "rule",
              content: "Keep learning execution engine-owned and durable.",
              tags: ["worker", "queue"],
              is_pinned: false,
              path_matchers: ["src/engine/learning-worker.ts"],
            },
          ],
        }),
    });

    const completedJob = await waitForJobState(
      bootstrapResult.database,
      "worker-job-success",
      "completed",
    );
    const memories = MemoryRepository.listMemories(bootstrapResult.database, {
      spaceId: touchedSpace.space.id,
    });
    const events = EventRepository.listEvents(bootstrapResult.database, {
      kind: "learning_job",
      limit: 20,
    });

    assert.equal(completedJob.error_text, null);
    assert.equal(memories.length, 1);
    const learnedMemory = memories[0];

    assert.ok(learnedMemory);
    assert.equal(
      learnedMemory.content,
      "Keep learning execution engine-owned and durable.",
    );
    assert.deepEqual(learnedMemory.path_matchers, ["src/engine/learning-worker.ts"]);
    assert.ok(events.some((event) => event.event === "job-leased"));
    assert.ok(events.some((event) => event.event === "job-running"));
    assert.ok(events.some((event) => event.event === "job-action-applied"));
    assert.ok(events.some((event) => event.event === "job-completed"));
  });

  it("marks missing transcripts as skipped without calling the model", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-worker-missing-home-",
    );
    const workspacePath = await createTempDirectory(
      "claude-memory-worker-missing-workspace-",
    );
    const transcriptPath = path.join(workspacePath, "missing.jsonl");
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });
    let learningWorker: ReturnType<typeof startLearningWorker> | null = null;

    testContext.after(async () => {
      await learningWorker?.close();
      bootstrapResult.database.close();
      await removePath(workspacePath);
      await removePath(claudeMemoryHome);
    });

    const touchedSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
      bootstrapResult.database,
      {
        resolution: createResolution(workspacePath, {
          insideWorkTree: false,
        }),
      },
    );
    LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
      id: "worker-job-missing",
      spaceId: touchedSpace.space.id,
      rootPath: workspacePath,
      transcriptPath,
    });

    let modelCallCount = 0;
    learningWorker = startLearningWorker({
      database: bootstrapResult.database,
      heartbeatIntervalMs: 40,
      leaseDurationMs: 200,
      pollIntervalMs: 20,
      runLearningModel: () => {
        modelCallCount += 1;

        return Promise.resolve({
          summary: "Should never run for a missing transcript.",
          actions: [],
        });
      },
    });

    const skippedJob = await waitForJobState(
      bootstrapResult.database,
      "worker-job-missing",
      "skipped",
    );
    const events = EventRepository.listEvents(bootstrapResult.database, {
      kind: "learning_job",
      limit: 20,
    });

    assert.equal(modelCallCount, 0);
    assert.ok(skippedJob.error_text?.includes("ENOENT") ?? false);
    assert.ok(events.some((event) => event.event === "job-skipped"));
  });

  it("serializes execution and reclaims stale running leases", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-worker-recovery-home-",
    );
    const workspacePath = await createTempDirectory(
      "claude-memory-worker-recovery-workspace-",
    );
    const firstTranscriptPath = path.join(workspacePath, "first.jsonl");
    const secondTranscriptPath = path.join(workspacePath, "second.jsonl");
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });
    let learningWorker: ReturnType<typeof startLearningWorker> | null = null;

    testContext.after(async () => {
      await learningWorker?.close();
      bootstrapResult.database.close();
      await removePath(workspacePath);
      await removePath(claudeMemoryHome);
    });

    await writeFile(
      firstTranscriptPath,
      '{"event":"assistant","text":"Recover the stale queue lease first."}\n',
      "utf8",
    );
    await writeFile(
      secondTranscriptPath,
      '{"event":"assistant","text":"Run the next queued job after the first one."}\n',
      "utf8",
    );

    const touchedSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
      bootstrapResult.database,
      {
        resolution: createResolution(workspacePath, {
          insideWorkTree: false,
        }),
      },
    );
    LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
      id: "worker-job-stale",
      spaceId: touchedSpace.space.id,
      rootPath: workspacePath,
      transcriptPath: firstTranscriptPath,
      state: "running",
      leaseOwner: "engine:old",
      leaseExpiresAt: "2026-03-14T01:00:00.000Z",
      attemptCount: 1,
      enqueuedAt: "2026-03-14T00:59:00.000Z",
    });
    LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
      id: "worker-job-next",
      spaceId: touchedSpace.space.id,
      rootPath: workspacePath,
      transcriptPath: secondTranscriptPath,
      enqueuedAt: "2026-03-14T01:01:00.000Z",
    });

    let activeRuns = 0;
    let maxConcurrentRuns = 0;
    learningWorker = startLearningWorker({
      database: bootstrapResult.database,
      heartbeatIntervalMs: 40,
      leaseDurationMs: 200,
      pollIntervalMs: 20,
      runLearningModel: async () => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        await sleep(60);
        activeRuns -= 1;

        return {
          summary: "No durable memory changes needed.",
          actions: [],
        };
      },
    });

    const reclaimedJob = await waitForJobState(
      bootstrapResult.database,
      "worker-job-stale",
      "completed",
    );
    const nextJob = await waitForJobState(
      bootstrapResult.database,
      "worker-job-next",
      "completed",
    );

    assert.equal(maxConcurrentRuns, 1);
    assert.equal(reclaimedJob.attempt_count, 2);
    assert.equal(nextJob.attempt_count, 1);
  });
});

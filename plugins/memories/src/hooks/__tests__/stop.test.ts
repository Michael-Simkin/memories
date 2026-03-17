import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDirectory,
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { DatabaseBootstrapRepository } from "../../storage/repositories/database-bootstrap-repository.js";
import { LearningJobRepository } from "../../storage/repositories/learning-job-repository.js";
import { handleStopHook } from "../stop.js";
import type { StopHookInput } from "../types/stop.js";

function createStopHookInput(
  workspacePath: string,
  transcriptPath: string,
  overrides: Partial<StopHookInput> = {},
): StopHookInput {
  return {
    hook_event_name: "Stop",
    cwd: workspacePath,
    session_id: "session-1",
    transcript_path: transcriptPath,
    stop_hook_active: false,
    last_assistant_message: "  capture the durable memory  ",
    ...overrides,
  };
}

describe("handleStopHook", () => {
  it("enqueues one learning job for the active space when the transcript exists", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-stop-hook-home-",
    );
    const workspacePath = await createTempDirectory(
      "claude-memory-stop-hook-workspace-",
    );
    const transcriptPath = path.join(workspacePath, "transcript.jsonl");

    await writeFile(transcriptPath, '{"event":"assistant"}\n', "utf8");

    testContext.after(async () => {
      await removePath(claudeMemoryHome);
      await removePath(workspacePath);
    });

    const hookResult = await handleStopHook(
      createStopHookInput(workspacePath, transcriptPath),
      {
        claudeMemoryHome,
      },
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
    });

    try {
      const queuedJobs = LearningJobRepository.listLearningJobs(
        bootstrapResult.database,
      );
      const queuedJob = queuedJobs[0];

      assert.equal(queuedJobs.length, 1);
      assert.ok(queuedJob);
      assert.deepEqual(hookResult, {
        enqueued: true,
        jobId: queuedJob.id,
      });
      assert.equal(queuedJob.transcript_path, transcriptPath);
      assert.equal(queuedJob.last_assistant_message, "capture the durable memory");
      assert.equal(queuedJob.session_id, "session-1");
      assert.equal(queuedJob.state, "pending");
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("skips enqueue when stop_hook_active is already true", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-stop-hook-active-home-",
    );
    const workspacePath = await createTempDirectory(
      "claude-memory-stop-hook-active-workspace-",
    );
    const transcriptPath = path.join(workspacePath, "transcript.jsonl");

    await writeFile(transcriptPath, '{"event":"assistant"}\n', "utf8");

    testContext.after(async () => {
      await removePath(claudeMemoryHome);
      await removePath(workspacePath);
    });

    const hookResult = await handleStopHook(
      createStopHookInput(workspacePath, transcriptPath, {
        stop_hook_active: true,
      }),
      {
        claudeMemoryHome,
      },
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
    });

    try {
      const queuedJobs = LearningJobRepository.listLearningJobs(
        bootstrapResult.database,
      );

      assert.deepEqual(hookResult, {
        enqueued: false,
        skipReason: "stop-hook-active",
      });
      assert.equal(queuedJobs.length, 0);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("skips enqueue when the transcript path does not exist", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-stop-hook-missing-home-",
    );
    const workspacePath = await createTempDirectory(
      "claude-memory-stop-hook-missing-workspace-",
    );
    const transcriptDirectoryPath = path.join(workspacePath, "transcripts");
    const transcriptPath = path.join(transcriptDirectoryPath, "missing.jsonl");

    await createDirectory(transcriptDirectoryPath);

    testContext.after(async () => {
      await removePath(claudeMemoryHome);
      await removePath(workspacePath);
    });

    const hookResult = await handleStopHook(
      createStopHookInput(workspacePath, transcriptPath),
      {
        claudeMemoryHome,
      },
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
    });

    try {
      const queuedJobs = LearningJobRepository.listLearningJobs(
        bootstrapResult.database,
      );

      assert.deepEqual(hookResult, {
        enqueued: false,
        skipReason: "missing-transcript",
      });
      assert.equal(queuedJobs.length, 0);
    } finally {
      bootstrapResult.database.close();
    }
  });
});

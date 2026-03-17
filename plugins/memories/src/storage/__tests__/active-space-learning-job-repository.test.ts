import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDirectory,
  createTempDirectory,
  initializeGitRepository,
  removePath,
  runGitCommand,
} from "../../shared/__tests__/helpers.js";
import { ActiveSpaceLearningJobRepository } from "../repositories/active-space-learning-job-repository.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
import { LearningJobRepository } from "../repositories/learning-job-repository.js";

describe("ActiveSpaceLearningJobRepository", () => {
  it("enqueues a learning job for a directory-scoped context", async (testContext) => {
    const workspacePath = await createTempDirectory(
      "claude-memory-active-job-directory-",
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    testContext.after(async () => {
      bootstrapResult.database.close();
      await removePath(workspacePath);
    });

    const queuedJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
      bootstrapResult.database,
      {
        context: {
          cwd: workspacePath,
        },
        id: "learning-job-1",
        transcriptPath: "/tmp/transcript-1.md",
        lastAssistantMessage: "  extract durable memories  ",
        enqueuedAt: "2026-03-14T13:00:00.000Z",
      },
    );
    const persistedJob = LearningJobRepository.getLearningJobById(
      bootstrapResult.database,
      "learning-job-1",
    );
    const canonicalWorkspacePath = await realpath(workspacePath);

    assert.equal(queuedJob.root_path, canonicalWorkspacePath);
    assert.equal(queuedJob.transcript_path, "/tmp/transcript-1.md");
    assert.equal(queuedJob.last_assistant_message, "extract durable memories");
    assert.equal(queuedJob.state, "pending");
    assert.ok(persistedJob);
    assert.equal(persistedJob.id, "learning-job-1");
    assert.equal(persistedJob.space_id, queuedJob.space_id);
  });

  it("shares one remote-scoped space across separate clones but stores each job root path", async (testContext) => {
    const firstRepositoryPath = await createTempDirectory(
      "claude-memory-active-job-remote-a-",
    );
    const secondRepositoryPath = await createTempDirectory(
      "claude-memory-active-job-remote-b-",
    );
    const secondNestedPath = path.join(secondRepositoryPath, "packages", "app");
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    testContext.after(async () => {
      bootstrapResult.database.close();
      await removePath(firstRepositoryPath);
      await removePath(secondRepositoryPath);
    });

    await initializeGitRepository(firstRepositoryPath);
    await initializeGitRepository(secondRepositoryPath);
    await createDirectory(secondNestedPath);
    await runGitCommand(firstRepositoryPath, [
      "remote",
      "add",
      "origin",
      "https://github.com/Owner/Repo.git",
    ]);
    await runGitCommand(secondRepositoryPath, [
      "remote",
      "add",
      "origin",
      "git@github.com:Owner/Repo.git",
    ]);
    const canonicalFirstRepositoryPath = await realpath(firstRepositoryPath);
    const canonicalSecondRepositoryPath = await realpath(secondRepositoryPath);

    const firstJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
      bootstrapResult.database,
      {
        context: {
          cwd: firstRepositoryPath,
        },
        id: "learning-job-remote-1",
        transcriptPath: "/tmp/remote-1.md",
        enqueuedAt: "2026-03-14T13:10:00.000Z",
      },
    );
    const secondJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
      bootstrapResult.database,
      {
        context: {
          cwd: secondNestedPath,
        },
        id: "learning-job-remote-2",
        transcriptPath: "/tmp/remote-2.md",
        enqueuedAt: "2026-03-14T13:11:00.000Z",
      },
    );
    const queuedJobs = LearningJobRepository.listLearningJobs(
      bootstrapResult.database,
      {
        spaceId: firstJob.space_id,
      },
    );
    const counts = bootstrapResult.database
      .prepare(
        "select (select count(*) from memory_spaces) as space_count, (select count(*) from space_roots) as root_count;",
      )
      .get() as { root_count: number; space_count: number };

    assert.equal(firstJob.space_id, secondJob.space_id);
    assert.equal(firstJob.root_path, canonicalFirstRepositoryPath);
    assert.equal(secondJob.root_path, canonicalSecondRepositoryPath);
    assert.deepEqual(
      queuedJobs.map((job) => job.id),
      ["learning-job-remote-1", "learning-job-remote-2"],
    );
    assert.deepEqual(
      {
        space_count: counts.space_count,
        root_count: counts.root_count,
      },
      {
        space_count: 1,
        root_count: 2,
      },
    );
  });

  it("can enqueue against an explicit persisted space id", async (testContext) => {
    const workspacePath = await createTempDirectory(
      "claude-memory-active-job-space-id-",
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    testContext.after(async () => {
      bootstrapResult.database.close();
      await removePath(workspacePath);
    });

    const firstJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
      bootstrapResult.database,
      {
        context: {
          cwd: workspacePath,
        },
        id: "learning-job-space-seed",
        transcriptPath: "/tmp/seed.md",
      },
    );
    const secondJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
      bootstrapResult.database,
      {
        spaceId: firstJob.space_id,
        id: "learning-job-space-explicit",
        transcriptPath: "/tmp/explicit.md",
      },
    );

    assert.equal(secondJob.space_id, firstJob.space_id);
    assert.equal(secondJob.root_path, firstJob.root_path);
  });

  it("reuses the active job when the same transcript snapshot is enqueued twice", async (testContext) => {
    const workspacePath = await createTempDirectory(
      "claude-memory-active-job-dedupe-",
    );
    const transcriptPath = path.join(workspacePath, "transcript.jsonl");
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    testContext.after(async () => {
      bootstrapResult.database.close();
      await removePath(workspacePath);
    });

    await writeFile(transcriptPath, '{"event":"assistant","text":"Remember this"}\n');

    const firstJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
      bootstrapResult.database,
      {
        context: {
          cwd: workspacePath,
        },
        id: "learning-job-dedupe-1",
        transcriptPath,
      },
    );
    const secondJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
      bootstrapResult.database,
      {
        context: {
          cwd: workspacePath,
        },
        id: "learning-job-dedupe-2",
        transcriptPath,
      },
    );
    const queuedJobs = LearningJobRepository.listLearningJobs(
      bootstrapResult.database,
      {
        spaceId: firstJob.space_id,
      },
    );

    assert.equal(firstJob.id, "learning-job-dedupe-1");
    assert.equal(secondJob.id, "learning-job-dedupe-1");
    assert.deepEqual(
      queuedJobs.map((job) => job.id),
      ["learning-job-dedupe-1"],
    );
  });

  it("requires either an explicit space id or a resolvable context", async () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      await assert.rejects(
        () =>
          ActiveSpaceLearningJobRepository.enqueueLearningJob(
            bootstrapResult.database,
            {
              transcriptPath: "/tmp/missing-space.md",
            },
          ),
        /requires either an explicit spaceId or a resolvable context/u,
      );
    } finally {
      bootstrapResult.database.close();
    }
  });
});

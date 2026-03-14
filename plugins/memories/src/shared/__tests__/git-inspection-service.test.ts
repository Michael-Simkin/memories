import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDirectory,
  createTempDirectory,
  initializeGitRepository,
  removePath,
  runGitCommand,
} from "./helpers.js";
import { GitInspectionService } from "../services/git-inspection-service.js";

describe("GitInspectionService", () => {
  it("returns outside-Git metadata for directories without a repository", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-git-outside-");

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    const gitInspection = await GitInspectionService.inspectGitContext(tempDirectory);

    assert.deepEqual(gitInspection, {
      insideWorkTree: false,
    });
  });

  it("returns the git top-level path and origin when a usable origin exists", async (testContext) => {
    const repositoryPath = await createTempDirectory("claude-memory-git-origin-");
    const nestedDirectory = path.join(repositoryPath, "packages", "app");

    testContext.after(async () => {
      await removePath(repositoryPath);
    });

    await initializeGitRepository(repositoryPath);
    await createDirectory(nestedDirectory);
    await runGitCommand(repositoryPath, [
      "remote",
      "add",
      "origin",
      "git@github.com:Owner/Repo.git",
    ]);
    const canonicalRepositoryPath = await realpath(repositoryPath);

    const gitInspection = await GitInspectionService.inspectGitContext(nestedDirectory);

    assert.deepEqual(gitInspection, {
      insideWorkTree: true,
      gitTopLevelPath: canonicalRepositoryPath,
      originUrl: "git@github.com:Owner/Repo.git",
    });
  });

  it("returns null origin metadata when the repository has no origin remote", async (testContext) => {
    const repositoryPath = await createTempDirectory("claude-memory-git-no-origin-");
    const nestedDirectory = path.join(repositoryPath, "packages", "app");

    testContext.after(async () => {
      await removePath(repositoryPath);
    });

    await initializeGitRepository(repositoryPath);
    await createDirectory(nestedDirectory);
    const canonicalRepositoryPath = await realpath(repositoryPath);

    const gitInspection = await GitInspectionService.inspectGitContext(nestedDirectory);

    assert.deepEqual(gitInspection, {
      insideWorkTree: true,
      gitTopLevelPath: canonicalRepositoryPath,
      originUrl: null,
    });
  });
});

import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDirectory,
  createDirectorySymlink,
  createTempDirectory,
  initializeGitRepository,
  removePath,
  runGitCommand,
} from "./helpers.js";
import { ActiveMemorySpaceService } from "../services/active-memory-space-service.js";

describe("ActiveMemorySpaceService", () => {
  it("resolves a remote_repo space inside Git when origin is usable", async (testContext) => {
    const repositoryPath = await createTempDirectory("claude-memory-active-space-remote-");
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
      "https://github.com/Owner/Repo.git",
    ]);
    const canonicalNestedDirectory = await realpath(nestedDirectory);
    const canonicalRepositoryPath = await realpath(repositoryPath);

    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace({
      cwd: nestedDirectory,
      processCwd: "/unused/process-cwd",
    });

    assert.equal(resolution.workingContext.source, "cwd");
    assert.equal(resolution.workingContext.resolvedWorkingPath, canonicalNestedDirectory);
    assert.deepEqual(resolution.git, {
      insideWorkTree: true,
      gitTopLevelPath: canonicalRepositoryPath,
      originUrl: "https://github.com/Owner/Repo.git",
    });
    assert.equal(resolution.space.spaceKind, "remote_repo");
    assert.equal(resolution.space.rootPath, canonicalRepositoryPath);
    assert.equal(resolution.space.originUrlNormalized, "github.com/Owner/Repo");
  });

  it("falls back to a directory space rooted at the git top-level when origin is absent", async (testContext) => {
    const repositoryPath = await createTempDirectory(
      "claude-memory-active-space-directory-git-",
    );
    const nestedDirectory = path.join(repositoryPath, "packages", "app");

    testContext.after(async () => {
      await removePath(repositoryPath);
    });

    await initializeGitRepository(repositoryPath);
    await createDirectory(nestedDirectory);
    const canonicalRepositoryPath = await realpath(repositoryPath);

    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace({
      cwd: nestedDirectory,
      processCwd: "/unused/process-cwd",
    });

    assert.equal(resolution.space.spaceKind, "directory");
    assert.equal(resolution.space.rootPath, canonicalRepositoryPath);
    assert.equal(resolution.space.originUrl, null);
    assert.equal(resolution.space.originUrlNormalized, null);
  });

  it("resolves a directory space from the canonical realpath outside Git", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-active-space-symlink-");
    const actualDirectory = path.join(tempDirectory, "actual");
    const symlinkDirectory = path.join(tempDirectory, "linked");

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    await createDirectory(actualDirectory);
    await createDirectorySymlink(actualDirectory, symlinkDirectory);
    const canonicalActualDirectory = await realpath(actualDirectory);

    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace({
      projectRoot: symlinkDirectory,
      processCwd: "/unused/process-cwd",
    });

    assert.deepEqual(resolution.workingContext, {
      source: "project_root",
      selectedWorkingPath: symlinkDirectory,
      resolvedWorkingPath: canonicalActualDirectory,
    });
    assert.deepEqual(resolution.git, {
      insideWorkTree: false,
    });
    assert.equal(resolution.space.spaceKind, "directory");
    assert.equal(resolution.space.rootPath, canonicalActualDirectory);
  });
});

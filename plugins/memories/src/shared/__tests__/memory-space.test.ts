import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemorySpaceService } from "../services/memory-space-service.js";

describe("selectWorkingPath", () => {
  it("prefers project_root over all other working path inputs", () => {
    const selection = MemorySpaceService.selectWorkingPath({
      projectRoot: "/workspace/project-root",
      cwd: "/workspace/cwd",
      claudeProjectDir: "/workspace/claude-project-dir",
      processCwd: "/workspace/process-cwd",
    });

    assert.deepEqual(selection, {
      source: "project_root",
      workingPath: "/workspace/project-root",
    });
  });

  it("uses CLAUDE_PROJECT_DIR when project_root and cwd are absent", () => {
    const selection = MemorySpaceService.selectWorkingPath({
      claudeProjectDir: "/workspace/claude-project-dir",
      processCwd: "/workspace/process-cwd",
    });

    assert.deepEqual(selection, {
      source: "claude_project_dir",
      workingPath: "/workspace/claude-project-dir",
    });
  });

  it("falls back to process.cwd when higher-priority inputs are absent", () => {
    const selection = MemorySpaceService.selectWorkingPath({
      processCwd: "/workspace/process-cwd",
    });

    assert.deepEqual(selection, {
      source: "process_cwd",
      workingPath: "/workspace/process-cwd",
    });
  });
});

describe("resolveMemorySpace", () => {
  it("creates a directory-scoped space outside Git", () => {
    const space = MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath: "/workspace/scratch",
      git: {
        insideWorkTree: false,
      },
    });

    assert.equal(space.spaceKind, "directory");
    assert.equal(space.displayName, "/workspace/scratch");
    assert.equal(space.rootPath, "/workspace/scratch");
    assert.equal(space.rootKind, "directory_root");
    assert.equal(space.originUrl, null);
    assert.equal(space.originUrlNormalized, null);
  });

  it("creates a remote-scoped space from a usable origin and the git top-level path", () => {
    const space = MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath: "/workspace/repo/packages/app",
      git: {
        insideWorkTree: true,
        gitTopLevelPath: "/workspace/repo",
        originUrl: "git@github.com:Owner/Repo.git",
      },
    });

    assert.equal(space.spaceKind, "remote_repo");
    assert.equal(space.displayName, "github.com/Owner/Repo");
    assert.equal(space.rootPath, "/workspace/repo");
    assert.equal(space.rootKind, "git_worktree");
    assert.equal(space.originUrl, "git@github.com:Owner/Repo.git");
    assert.equal(space.originUrlNormalized, "github.com/Owner/Repo");
  });

  it("shares the same remote space key across SSH and HTTPS forms", () => {
    const sshSpace = MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath: "/workspace/repo-one",
      git: {
        insideWorkTree: true,
        gitTopLevelPath: "/workspace/repo-one",
        originUrl: "git@github.com:Owner/Repo.git",
      },
    });
    const httpsSpace = MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath: "/workspace/repo-two",
      git: {
        insideWorkTree: true,
        gitTopLevelPath: "/workspace/repo-two",
        originUrl: "https://github.com/Owner/Repo",
      },
    });

    assert.equal(sshSpace.spaceKey, httpsSpace.spaceKey);
  });

  it("falls back to a directory-scoped space when origin is absent or unusable", () => {
    const space = MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath: "/workspace/repo/packages/app",
      git: {
        insideWorkTree: true,
        gitTopLevelPath: "/workspace/repo",
        originUrl: "file:///tmp/repo",
      },
    });

    assert.equal(space.spaceKind, "directory");
    assert.equal(space.rootPath, "/workspace/repo");
    assert.equal(space.rootKind, "directory_root");
    assert.equal(space.originUrl, null);
    assert.equal(space.originUrlNormalized, null);
  });

  it("requires gitTopLevelPath when the working path is inside Git", () => {
    assert.throws(() =>
      MemorySpaceService.resolveMemorySpace({
        resolvedWorkingPath: "/workspace/repo",
        git: {
          insideWorkTree: true,
          originUrl: "git@github.com:Owner/Repo.git",
        },
      }),
    );
  });
});

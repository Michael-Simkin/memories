import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StoragePathsService } from "../services/storage-paths-service.js";

describe("resolveMemoryStorageRoot", () => {
  it("defaults to ~/.claude/memories when no override is set", () => {
    const rootPath = StoragePathsService.resolveMemoryStorageRoot({
      currentWorkingDirectory: "/workspace/project",
      userHomeDirectory: "/Users/tester",
    });

    assert.equal(rootPath, "/Users/tester/.claude/memories");
  });

  it("resolves a relative CLAUDE_MEMORY_HOME override from the current working directory", () => {
    const rootPath = StoragePathsService.resolveMemoryStorageRoot({
      claudeMemoryHome: "./tmp/memories",
      currentWorkingDirectory: "/workspace/project",
      userHomeDirectory: "/Users/tester",
    });

    assert.equal(rootPath, "/workspace/project/tmp/memories");
  });

  it("treats a blank CLAUDE_MEMORY_HOME override as unset", () => {
    const rootPath = StoragePathsService.resolveMemoryStorageRoot({
      claudeMemoryHome: "   ",
      currentWorkingDirectory: "/workspace/project",
      userHomeDirectory: "/Users/tester",
    });

    assert.equal(rootPath, "/Users/tester/.claude/memories");
  });
});

describe("resolveMemoryStoragePaths", () => {
  it("derives the expected global file paths from the storage root", () => {
    const paths = StoragePathsService.resolveMemoryStoragePaths({
      claudeMemoryHome: "/tmp/claude-memory-home",
      currentWorkingDirectory: "/workspace/project",
    });

    assert.deepEqual(paths, {
      rootPath: "/tmp/claude-memory-home",
      databasePath: "/tmp/claude-memory-home/memory.db",
      engineLockPath: "/tmp/claude-memory-home/engine.lock.json",
      engineStartupLockPath: "/tmp/claude-memory-home/engine.startup.lock.json",
      engineStderrLogPath: "/tmp/claude-memory-home/engine.stderr.log",
      tmpDirectoryPath: "/tmp/claude-memory-home/tmp",
    });
  });
});

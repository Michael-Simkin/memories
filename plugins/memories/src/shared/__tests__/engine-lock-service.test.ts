import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createTempDirectory, removePath } from "./helpers.js";
import { EngineLockService } from "../services/engine-lock-service.js";
import { StoragePathsService } from "../services/storage-paths-service.js";

describe("EngineLockService", () => {
  it("writes and reads the global engine lock with the resolved storage root", async (testContext) => {
    const storageRoot = await createTempDirectory("claude-memory-engine-lock-");

    testContext.after(async () => {
      await removePath(storageRoot);
    });

    const writtenLock = await EngineLockService.writeEngineLock(
      {
        host: "127.0.0.1",
        port: 43123,
        pid: 40123,
        started_at: "2026-03-14T16:00:00.000Z",
        last_activity_at: "2026-03-14T16:05:00.000Z",
        version: "0.0.0",
      },
      {
        claudeMemoryHome: storageRoot,
      },
    );
    const readLock = await EngineLockService.readEngineLock({
      claudeMemoryHome: storageRoot,
    });

    assert.deepEqual(writtenLock, {
      host: "127.0.0.1",
      port: 43123,
      pid: 40123,
      started_at: "2026-03-14T16:00:00.000Z",
      last_activity_at: "2026-03-14T16:05:00.000Z",
      storage_root: storageRoot,
      version: "0.0.0",
    });
    assert.deepEqual(readLock, writtenLock);
  });

  it("writes and reads the global engine startup lock with the resolved storage root", async (testContext) => {
    const storageRoot = await createTempDirectory("claude-memory-engine-startup-");

    testContext.after(async () => {
      await removePath(storageRoot);
    });

    const writtenLock = await EngineLockService.writeEngineStartupLock(
      {
        pid: 50123,
        acquired_at: "2026-03-14T16:10:00.000Z",
        version: "0.0.0",
      },
      {
        claudeMemoryHome: storageRoot,
      },
    );
    const readLock = await EngineLockService.readEngineStartupLock({
      claudeMemoryHome: storageRoot,
    });

    assert.deepEqual(writtenLock, {
      pid: 50123,
      acquired_at: "2026-03-14T16:10:00.000Z",
      storage_root: storageRoot,
      version: "0.0.0",
    });
    assert.deepEqual(readLock, writtenLock);
  });

  it("returns null when the engine lock files do not exist yet", async (testContext) => {
    const storageRoot = await createTempDirectory("claude-memory-engine-empty-");

    testContext.after(async () => {
      await removePath(storageRoot);
    });

    const engineLock = await EngineLockService.readEngineLock({
      claudeMemoryHome: storageRoot,
    });
    const startupLock = await EngineLockService.readEngineStartupLock({
      claudeMemoryHome: storageRoot,
    });

    assert.equal(engineLock, null);
    assert.equal(startupLock, null);
  });

  it("clears the engine lock only when the expected pid owns it", async (testContext) => {
    const storageRoot = await createTempDirectory("claude-memory-engine-clear-");

    testContext.after(async () => {
      await removePath(storageRoot);
    });

    await EngineLockService.writeEngineLock(
      {
        host: "127.0.0.1",
        port: 43124,
        pid: 40124,
        started_at: "2026-03-14T16:20:00.000Z",
        last_activity_at: "2026-03-14T16:21:00.000Z",
        version: "0.0.0",
      },
      {
        claudeMemoryHome: storageRoot,
      },
    );

    const rejectedRemoval = await EngineLockService.clearEngineLockIfOwned(99999, {
      claudeMemoryHome: storageRoot,
    });
    const acceptedRemoval = await EngineLockService.clearEngineLockIfOwned(40124, {
      claudeMemoryHome: storageRoot,
    });
    const remainingLock = await EngineLockService.readEngineLock({
      claudeMemoryHome: storageRoot,
    });

    assert.equal(rejectedRemoval, false);
    assert.equal(acceptedRemoval, true);
    assert.equal(remainingLock, null);
  });

  it("clears the engine startup lock only when the expected pid owns it", async (testContext) => {
    const storageRoot = await createTempDirectory(
      "claude-memory-engine-startup-clear-",
    );

    testContext.after(async () => {
      await removePath(storageRoot);
    });

    await EngineLockService.writeEngineStartupLock(
      {
        pid: 50124,
        acquired_at: "2026-03-14T16:30:00.000Z",
        version: "0.0.0",
      },
      {
        claudeMemoryHome: storageRoot,
      },
    );

    const rejectedRemoval = await EngineLockService.clearEngineStartupLockIfOwned(
      99999,
      {
        claudeMemoryHome: storageRoot,
      },
    );
    const acceptedRemoval = await EngineLockService.clearEngineStartupLockIfOwned(
      50124,
      {
        claudeMemoryHome: storageRoot,
      },
    );
    const remainingLock = await EngineLockService.readEngineStartupLock({
      claudeMemoryHome: storageRoot,
    });

    assert.equal(rejectedRemoval, false);
    assert.equal(acceptedRemoval, true);
    assert.equal(remainingLock, null);
  });

  it("throws an actionable error when the engine lock contents are invalid", async (testContext) => {
    const storageRoot = await createTempDirectory("claude-memory-engine-invalid-");
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths({
      claudeMemoryHome: storageRoot,
    });

    testContext.after(async () => {
      await removePath(storageRoot);
    });

    await writeFile(
      storagePaths.engineLockPath,
      JSON.stringify({
        host: "127.0.0.1",
        port: 99999,
      }),
      "utf8",
    );

    await assert.rejects(
      () =>
        EngineLockService.readEngineLock({
          claudeMemoryHome: storageRoot,
        }),
      /Invalid engine lock/u,
    );
  });
});

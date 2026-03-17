import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { EngineLockService } from "../../shared/services/engine-lock-service.js";
import { ensureEngine } from "../ensure-engine.js";
import { getEngineHealth } from "../engine-client.js";

const TEST_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const SOURCE_ENGINE_ENTRYPOINT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../main.ts",
);
const ENGINE_NODE_ARGUMENTS = ["--import", "tsx"];

async function stopEngine(
  claudeMemoryHome: string,
  expectedPid: number,
): Promise<void> {
  try {
    process.kill(expectedPid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const persistedLock = await EngineLockService.readEngineLockIfProcessAlive({
      claudeMemoryHome,
    });

    if (!persistedLock || persistedLock.pid !== expectedPid) {
      return;
    }

    await sleep(50);
  }

  throw new Error(`Timed out stopping Claude Memory engine pid "${String(expectedPid)}".`);
}

describe("ensureEngine", () => {
  it("starts and reuses one compatible global engine", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-ensure-engine-",
    );

    testContext.after(async () => {
      const persistedLock = await EngineLockService.readEngineLockIfProcessAlive({
        claudeMemoryHome,
      });

      if (persistedLock) {
        await stopEngine(claudeMemoryHome, persistedLock.pid);
      }

      await removePath(claudeMemoryHome);
    });

    const firstEngine = await ensureEngine({
      bootTimeoutMs: 10_000,
      claudeMemoryHome,
      engineEntrypoint: SOURCE_ENGINE_ENTRYPOINT,
      engineNodeArguments: ENGINE_NODE_ARGUMENTS,
      pluginRoot: TEST_PLUGIN_ROOT,
    });
    const secondEngine = await ensureEngine({
      bootTimeoutMs: 10_000,
      claudeMemoryHome,
      engineEntrypoint: SOURCE_ENGINE_ENTRYPOINT,
      engineNodeArguments: ENGINE_NODE_ARGUMENTS,
      pluginRoot: TEST_PLUGIN_ROOT,
    });
    const health = await getEngineHealth(firstEngine.connection, 1_000);

    assert.equal(firstEngine.baseUrl, secondEngine.baseUrl);
    assert.equal(firstEngine.lock.pid, secondEngine.lock.pid);
    assert.equal(typeof health.engine_version, "string");
  });

  it("waits for an existing startup lock to clear before starting the engine", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-ensure-engine-wait-",
    );

    testContext.after(async () => {
      const persistedLock = await EngineLockService.readEngineLockIfProcessAlive({
        claudeMemoryHome,
      });

      if (persistedLock) {
        await stopEngine(claudeMemoryHome, persistedLock.pid);
      }

      await removePath(claudeMemoryHome);
    });

    const acquiredLock = await EngineLockService.acquireEngineStartupLock(
      {
        pid: process.pid,
        acquired_at: "2026-03-14T18:00:00.000Z",
        version: "0.0.0",
      },
      {
        claudeMemoryHome,
      },
    );

    assert.ok(acquiredLock);

    setTimeout(() => {
      void EngineLockService.clearEngineStartupLockIfOwned(process.pid, {
        claudeMemoryHome,
      });
    }, 200);

    const ensuredEngine = await ensureEngine({
      bootTimeoutMs: 10_000,
      claudeMemoryHome,
      engineEntrypoint: SOURCE_ENGINE_ENTRYPOINT,
      engineNodeArguments: ENGINE_NODE_ARGUMENTS,
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    assert.ok(ensuredEngine.lock.pid > 0);
  });
});

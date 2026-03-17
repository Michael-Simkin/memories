import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { EngineLockService } from "../../shared/services/engine-lock-service.js";

export const TEST_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const SOURCE_ENGINE_ENTRYPOINT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../engine/main.ts",
);
export const ENGINE_NODE_ARGUMENTS = ["--import", "tsx"];

export async function stopRunningEngine(
  claudeMemoryHome: string,
): Promise<void> {
  const persistedLock = await EngineLockService.readEngineLockIfProcessAlive({
    claudeMemoryHome,
  });

  if (!persistedLock) {
    return;
  }

  try {
    process.kill(persistedLock.pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activeLock = await EngineLockService.readEngineLockIfProcessAlive({
      claudeMemoryHome,
    });

    if (!activeLock || activeLock.pid !== persistedLock.pid) {
      return;
    }

    await sleep(50);
  }

  throw new Error(
    `Timed out stopping Claude Memory engine pid "${String(persistedLock.pid)}".`,
  );
}

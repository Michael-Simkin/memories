import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { CLAUDE_MEMORY_VERSION } from "../shared/constants/version.js";
import { PluginPathsService } from "../shared/services/plugin-paths-service.js";
import { EngineHealthService } from "../shared/services/engine-health-service.js";
import { EngineLockService } from "../shared/services/engine-lock-service.js";
import { RuntimeSupportService } from "../shared/services/runtime-support-service.js";
import { StoragePathsService } from "../shared/services/storage-paths-service.js";
import type { EngineLock } from "../shared/types/engine.js";
import type { PluginPathResolutionInput } from "../shared/types/plugin-paths.js";
import type { ResolveStoragePathsOptions } from "../shared/types/storage.js";
import { DatabaseBootstrapRepository } from "../storage/repositories/database-bootstrap-repository.js";
import { resolveEngineBootTimeoutMs } from "./config.js";
import {
  getEngineHealth,
  resolveEngineConnection,
  type EngineConnection,
} from "./engine-client.js";

const ENGINE_HEALTH_TIMEOUT_MS = 1_000;
const ENGINE_REPLACE_TIMEOUT_MS = 5_000;
const STARTUP_POLL_INTERVAL_MS = 100;

export interface EnsureEngineOptions
  extends ResolveStoragePathsOptions,
    PluginPathResolutionInput {
  bootTimeoutMs?: number | undefined;
  engineEntrypoint?: string | undefined;
  engineNodeArguments?: string[] | undefined;
  nodeBinaryPath?: string | undefined;
}

export interface EnsuredEngine {
  baseUrl: string;
  connection: EngineConnection;
  health: Awaited<ReturnType<typeof getEngineHealth>>;
  lock: EngineLock;
}

function isDeadlineExpired(deadlineAtMs: number): boolean {
  return Date.now() >= deadlineAtMs;
}

function resolveEngineEntrypoint(options: EnsureEngineOptions): string {
  if (options.engineEntrypoint) {
    return options.engineEntrypoint;
  }

  const pluginRoot = PluginPathsService.resolvePluginRoot({
    pluginRoot: options.pluginRoot,
  });

  return path.join(pluginRoot, "dist", "engine", "main.js");
}

async function readCompatibleEngine(
  options: EnsureEngineOptions,
): Promise<EnsuredEngine | null> {
  const engineLock = await EngineLockService.readEngineLockIfProcessAlive(options);

  if (!engineLock) {
    return null;
  }

  try {
    const connection = resolveEngineConnection(engineLock);
    const health = await getEngineHealth(connection, ENGINE_HEALTH_TIMEOUT_MS);
    const compatibilityResult = EngineHealthService.evaluateCompatibility(
      health,
      DatabaseBootstrapRepository.getLatestSchemaVersion(),
    );

    if (!compatibilityResult.isCompatible) {
      return null;
    }

    return {
      baseUrl: connection.baseUrl,
      connection,
      health,
      lock: engineLock,
    };
  } catch {
    return null;
  }
}

async function waitForCompatibleEngine(
  options: EnsureEngineOptions,
  deadlineAtMs: number,
  childProcess: ChildProcess | null = null,
): Promise<EnsuredEngine> {
  while (!isDeadlineExpired(deadlineAtMs)) {
    const compatibleEngine = await readCompatibleEngine(options);

    if (compatibleEngine) {
      return compatibleEngine;
    }

    if (childProcess && childProcess.exitCode !== null) {
      throw new Error(
        `Claude Memory engine exited before becoming healthy with code ${String(childProcess.exitCode)}.`,
      );
    }

    await sleep(STARTUP_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for the Claude Memory engine to become healthy.");
}

async function waitForCompatibleEngineOrStartupUnlock(
  options: EnsureEngineOptions,
  deadlineAtMs: number,
): Promise<EnsuredEngine | null> {
  while (!isDeadlineExpired(deadlineAtMs)) {
    const compatibleEngine = await readCompatibleEngine(options);

    if (compatibleEngine) {
      return compatibleEngine;
    }

    const startupLock = await EngineLockService.readEngineStartupLockIfProcessAlive(
      options,
    );

    if (!startupLock) {
      return null;
    }

    await sleep(STARTUP_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for the Claude Memory engine to become healthy.");
}

async function stopLockedEngine(
  engineLock: EngineLock,
  options: EnsureEngineOptions,
): Promise<void> {
  if (engineLock.pid === process.pid) {
    throw new Error("Refusing to terminate the current Claude Memory caller process.");
  }

  process.kill(engineLock.pid, "SIGTERM");

  const deadlineAtMs = Date.now() + ENGINE_REPLACE_TIMEOUT_MS;

  while (!isDeadlineExpired(deadlineAtMs)) {
    const persistedLock = await EngineLockService.readEngineLockIfProcessAlive(options);

    if (!persistedLock || persistedLock.pid !== engineLock.pid) {
      return;
    }

    await sleep(STARTUP_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out replacing incompatible Claude Memory engine pid "${String(engineLock.pid)}".`,
  );
}

function spawnEngineProcess(options: EnsureEngineOptions): ChildProcess {
  const nodeBinaryPath = options.nodeBinaryPath ?? process.execPath;
  const engineEntrypoint = resolveEngineEntrypoint(options);
  const pluginRoot = PluginPathsService.resolvePluginRoot({
    pluginRoot: options.pluginRoot,
  });
  const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
  const engineNodeArguments = options.engineNodeArguments ?? [];

  mkdirSync(storagePaths.rootPath, { recursive: true });

  const stderrFileDescriptor = openSync(storagePaths.engineStderrLogPath, "a");

  try {
    const childProcess = spawn(
      nodeBinaryPath,
      [...engineNodeArguments, engineEntrypoint],
      {
        cwd: pluginRoot,
        detached: true,
        env: {
          ...process.env,
          CLAUDE_MEMORY_HOME: storagePaths.rootPath,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
        },
        stdio: ["ignore", stderrFileDescriptor, stderrFileDescriptor],
      },
    );

    if (!childProcess.pid) {
      throw new Error("Claude Memory engine child process did not report a pid.");
    }

    return childProcess;
  } finally {
    closeSync(stderrFileDescriptor);
  }
}

export async function ensureEngine(
  options: EnsureEngineOptions = {},
): Promise<EnsuredEngine> {
  RuntimeSupportService.assertSupportedRuntime();

  const bootTimeoutMs = resolveEngineBootTimeoutMs(options.bootTimeoutMs);
  const deadlineAtMs = Date.now() + bootTimeoutMs;

  for (;;) {
    const compatibleEngine = await readCompatibleEngine(options);

    if (compatibleEngine) {
      return compatibleEngine;
    }

    await EngineLockService.readEngineStartupLockIfProcessAlive(options);

    const startupLock = await EngineLockService.acquireEngineStartupLock(
      {
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        version: CLAUDE_MEMORY_VERSION,
      },
      options,
    );

    if (!startupLock) {
      const waitingStartupLock =
        await EngineLockService.readEngineStartupLockIfProcessAlive(options);

      if (!waitingStartupLock) {
        continue;
      }

      const waitedEngine = await waitForCompatibleEngineOrStartupUnlock(
        options,
        deadlineAtMs,
      );

      if (waitedEngine) {
        return waitedEngine;
      }

      continue;
    }

    try {
      const recheckedEngine = await readCompatibleEngine(options);

      if (recheckedEngine) {
        return recheckedEngine;
      }

      const lockedEngine = await EngineLockService.readEngineLockIfProcessAlive(options);

      if (lockedEngine) {
        await stopLockedEngine(lockedEngine, options);
      }

      const childProcess = spawnEngineProcess(options);

      try {
        const startedEngine = await waitForCompatibleEngine(
          options,
          deadlineAtMs,
          childProcess,
        );

        childProcess.unref();

        return startedEngine;
      } catch (error) {
        if (childProcess.exitCode === null && childProcess.pid) {
          try {
            process.kill(childProcess.pid, "SIGTERM");
          } catch {
            // Best effort only; startup failure should surface the original error.
          }
        }

        throw error;
      }
    } finally {
      await EngineLockService.clearEngineStartupLockIfOwned(process.pid, options);
    }
  }
}

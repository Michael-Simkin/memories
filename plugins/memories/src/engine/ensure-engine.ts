import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';

import { isPidAlive, removeFileIfExists } from '../shared/fs-utils.js';
import { readLockMetadata } from '../shared/lockfile.js';
import { logInfo, logWarn } from '../shared/logger.js';
import { ensureProjectDirectories, resolvePluginRoot } from '../shared/paths.js';

export interface EngineEndpoint {
  host: string;
  port: number;
}

const ENGINE_UNAVAILABLE_PREFIX = 'ENGINE_UNAVAILABLE';
const REQUIRED_NODE_MAJOR = 20;
const DEFAULT_HEALTH_TIMEOUT_MS = 1000;
const DEFAULT_BOOT_TIMEOUT_MS = 45_000;
const DEFAULT_BOOT_POLL_MS = 120;
const DEFAULT_UNHEALTHY_ENGINE_GRACE_MS = 2_000;
const DEFAULT_ENGINE_TERMINATION_TIMEOUT_MS = 5_000;
const STARTUP_LOCK_STALE_MULTIPLIER = 2;

const execFileAsync = promisify(execFile);

interface StartupLockMetadata {
  pid: number;
  started_at: string;
}

function parseTimeoutMs(environmentName: string, fallback: number): number {
  const rawValue = process.env[environmentName];
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function engineUnavailable(message: string): Error {
  return new Error(`${ENGINE_UNAVAILABLE_PREFIX}: ${message}`);
}

function ensureNodeRuntimeSupported(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < REQUIRED_NODE_MAJOR) {
    throw engineUnavailable(`Node.js >=${REQUIRED_NODE_MAJOR} is required for engine startup.`);
  }
}

async function isEngineHealthy(endpoint: EngineEndpoint): Promise<boolean> {
  const timeoutMs = parseTimeoutMs('MEMORIES_ENGINE_HEALTH_TIMEOUT_MS', DEFAULT_HEALTH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function readStartupLockMetadata(startupLockPath: string): Promise<StartupLockMetadata | null> {
  try {
    const raw = await readFile(startupLockPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const maybeMetadata = parsed as {
      pid?: unknown;
      started_at?: unknown;
    };
    if (
      typeof maybeMetadata.pid !== 'number' ||
      !Number.isInteger(maybeMetadata.pid) ||
      maybeMetadata.pid <= 0 ||
      typeof maybeMetadata.started_at !== 'string' ||
      maybeMetadata.started_at.trim().length === 0
    ) {
      return null;
    }

    return {
      pid: maybeMetadata.pid,
      started_at: maybeMetadata.started_at,
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function tryAcquireStartupLock(startupLockPath: string): Promise<boolean> {
  const payload = {
    pid: process.pid,
    started_at: new Date().toISOString(),
  };

  try {
    await writeFile(startupLockPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function clearStaleStartupLock(startupLockPath: string, staleAfterMs: number): Promise<void> {
  const startupLock = await readStartupLockMetadata(startupLockPath);
  if (!startupLock) {
    await removeFileIfExists(startupLockPath);
    return;
  }

  const startedAtMs = Date.parse(startupLock.started_at);
  const staleByAge = !Number.isFinite(startedAtMs) || Date.now() - startedAtMs > staleAfterMs;
  if (!isPidAlive(startupLock.pid) || staleByAge) {
    await removeFileIfExists(startupLockPath);
  }
}

async function readHealthyEndpointFromLock(lockPath: string): Promise<EngineEndpoint | null> {
  const lock = await readLockMetadata(lockPath);
  if (!lock) {
    return null;
  }
  if (!isPidAlive(lock.pid)) {
    await removeFileIfExists(lockPath);
    return null;
  }

  const endpoint = { host: lock.host, port: lock.port };
  return (await isEngineHealthy(endpoint)) ? endpoint : null;
}

async function waitForHealthyEngine(
  lockPath: string,
  deadlineMs: number,
  pollMs: number,
): Promise<EngineEndpoint | null> {
  while (Date.now() < deadlineMs) {
    const endpoint = await readHealthyEndpointFromLock(lockPath);
    if (endpoint) {
      return endpoint;
    }
    await wait(pollMs);
  }
  return null;
}

async function waitForExistingEngineRecovery(
  lockPath: string,
  pid: number,
  recoveryWindowMs: number,
  pollMs: number,
): Promise<EngineEndpoint | null> {
  const deadlineMs = Date.now() + recoveryWindowMs;
  while (Date.now() < deadlineMs) {
    const lock = await readLockMetadata(lockPath);
    if (!lock || lock.pid !== pid) {
      return readHealthyEndpointFromLock(lockPath);
    }

    const endpoint = await readHealthyEndpointFromLock(lockPath);
    if (endpoint) {
      return endpoint;
    }

    await wait(pollMs);
  }
  return null;
}

async function appendEngineStderrMarker(engineStderrPath: string, message: string): Promise<void> {
  await appendFile(engineStderrPath, `\n[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function normalizeCommand(command: string): string {
  return command.replaceAll('\\', '/').trim();
}

async function isEngineProcess(pid: number, engineEntrypoint: string): Promise<boolean> {
  if (process.platform === 'win32') {
    return false;
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    const command = normalizeCommand(String(stdout));
    const normalizedEntrypoint = normalizeCommand(engineEntrypoint);
    return command.includes(normalizedEntrypoint) || command.includes('/dist/engine/main.js');
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await wait(Math.max(50, Math.min(250, pollMs)));
  }
  return !isPidAlive(pid);
}

async function stopUnhealthyEngine(
  pid: number,
  engineEntrypoint: string,
  pollMs: number,
): Promise<boolean> {
  if (!(await isEngineProcess(pid, engineEntrypoint))) {
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isPidAlive(pid);
  }

  const terminationTimeoutMs = parseTimeoutMs(
    'MEMORIES_ENGINE_TERMINATION_TIMEOUT_MS',
    DEFAULT_ENGINE_TERMINATION_TIMEOUT_MS,
  );
  return waitForPidExit(pid, terminationTimeoutMs, pollMs);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export async function ensureEngine(projectRoot: string): Promise<EngineEndpoint> {
  ensureNodeRuntimeSupported();

  const paths = await ensureProjectDirectories(projectRoot);
  const pluginRoot = resolvePluginRoot();
  const engineEntrypoint = `${pluginRoot}/dist/engine/main.js`;
  const maxWaitMs = parseTimeoutMs('MEMORIES_ENGINE_BOOT_TIMEOUT_MS', DEFAULT_BOOT_TIMEOUT_MS);
  const pollMs = parseTimeoutMs('MEMORIES_ENGINE_BOOT_POLL_MS', DEFAULT_BOOT_POLL_MS);
  const deadlineMs = Date.now() + maxWaitMs;

  const healthyExisting = await readHealthyEndpointFromLock(paths.lockPath);
  if (healthyExisting) {
    return healthyExisting;
  }

  let startupLockAcquired = false;
  while (!startupLockAcquired) {
    const nextHealthyEndpoint = await readHealthyEndpointFromLock(paths.lockPath);
    if (nextHealthyEndpoint) {
      return nextHealthyEndpoint;
    }

    await clearStaleStartupLock(paths.startupLockPath, maxWaitMs * STARTUP_LOCK_STALE_MULTIPLIER);
    startupLockAcquired = await tryAcquireStartupLock(paths.startupLockPath);
    if (startupLockAcquired) {
      break;
    }

    if (Date.now() >= deadlineMs) {
      throw engineUnavailable(
        `Another engine startup is already in progress and did not become healthy before timeout. See ${paths.engineStderrPath}.`,
      );
    }

    await wait(pollMs);
  }

  try {
    const healthyEndpointAfterLock = await readHealthyEndpointFromLock(paths.lockPath);
    if (healthyEndpointAfterLock) {
      return healthyEndpointAfterLock;
    }

    if (!existsSync(engineEntrypoint)) {
      throw engineUnavailable(`Engine entrypoint missing at ${engineEntrypoint}. Run npm run build.`);
    }

    const existingLock = await readLockMetadata(paths.lockPath);
    if (existingLock && isPidAlive(existingLock.pid)) {
      const recoveredEndpoint = await waitForExistingEngineRecovery(
        paths.lockPath,
        existingLock.pid,
        Math.min(
          DEFAULT_UNHEALTHY_ENGINE_GRACE_MS,
          Math.max(pollMs, deadlineMs - Date.now()),
        ),
        pollMs,
      );
      if (recoveredEndpoint) {
        return recoveredEndpoint;
      }

      logWarn('Existing engine stayed unhealthy; attempting a verified restart', {
        engineEntrypoint,
        pid: existingLock.pid,
        projectRoot,
      });
      const stopped = await stopUnhealthyEngine(existingLock.pid, engineEntrypoint, pollMs);
      if (!stopped) {
        throw engineUnavailable(
          `Existing engine pid ${existingLock.pid} is alive but unhealthy; refusing to start a duplicate engine. See ${paths.engineStderrPath}.`,
        );
      }
      await removeFileIfExists(paths.lockPath);
    } else if (existingLock) {
      await removeFileIfExists(paths.lockPath);
    }

    await appendEngineStderrMarker(paths.engineStderrPath, `Launching engine for ${projectRoot}`);

    const spawnState: { failure: Error | null } = { failure: null };
    const stderrFd = openSync(paths.engineStderrPath, 'a');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [engineEntrypoint], {
        detached: true,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          PROJECT_ROOT: projectRoot,
        },
        stdio: ['ignore', 'ignore', stderrFd],
      });
    } finally {
      closeSync(stderrFd);
    }

    child.once('error', (spawnError) => {
      spawnState.failure = spawnError;
    });
    child.unref();

    while (Date.now() < deadlineMs) {
      if (spawnState.failure) {
        throw engineUnavailable(
          `Failed to spawn engine: ${spawnState.failure.message}. See ${paths.engineStderrPath}.`,
        );
      }

      const endpoint = await readHealthyEndpointFromLock(paths.lockPath);
      if (endpoint) {
        logInfo('Engine process is healthy', { ...endpoint });
        return endpoint;
      }

      await wait(pollMs);
    }

    throw engineUnavailable(
      `Engine did not become healthy before timeout. See ${paths.engineStderrPath}.`,
    );
  } finally {
    if (startupLockAcquired) {
      await removeFileIfExists(paths.startupLockPath);
    }
  }
}

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

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

export async function ensureEngine(projectRoot: string): Promise<EngineEndpoint> {
  ensureNodeRuntimeSupported();

  const paths = await ensureProjectDirectories(projectRoot);
  const pluginRoot = resolvePluginRoot();
  const lock = await readLockMetadata(paths.lockPath);

  if (lock && isPidAlive(lock.pid)) {
    const endpoint = { host: lock.host, port: lock.port };
    if (await isEngineHealthy(endpoint)) {
      return endpoint;
    }
    logWarn('Engine lock exists but endpoint is unhealthy; starting a replacement engine', endpoint);
  }

  if (lock && !isPidAlive(lock.pid)) {
    await removeFileIfExists(paths.lockPath);
  }

  const engineEntrypoint = `${pluginRoot}/dist/engine/main.js`;
  if (!existsSync(engineEntrypoint)) {
    throw engineUnavailable(`Engine entrypoint missing at ${engineEntrypoint}. Run npm run build.`);
  }

  const spawnState: { failure: Error | null } = { failure: null };
  const child = spawn(process.execPath, [engineEntrypoint], {
    detached: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PROJECT_ROOT: projectRoot,
    },
    stdio: 'ignore',
  });
  child.once('error', (spawnError) => {
    spawnState.failure = spawnError;
  });
  child.unref();

  const maxWaitMs = parseTimeoutMs('MEMORIES_ENGINE_BOOT_TIMEOUT_MS', DEFAULT_BOOT_TIMEOUT_MS);
  const pollMs = parseTimeoutMs('MEMORIES_ENGINE_BOOT_POLL_MS', DEFAULT_BOOT_POLL_MS);
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    if (spawnState.failure) {
      throw engineUnavailable(`Failed to spawn engine: ${spawnState.failure.message}`);
    }

    const nextLock = await readLockMetadata(paths.lockPath);
    if (nextLock && isPidAlive(nextLock.pid)) {
      const endpoint = {
        host: nextLock.host,
        port: nextLock.port,
      };
      if (await isEngineHealthy(endpoint)) {
        logInfo('Engine process is healthy', endpoint);
        return endpoint;
      }
    }

    await wait(pollMs);
  }

  if (spawnState.failure) {
    throw engineUnavailable(`Failed to spawn engine: ${spawnState.failure.message}`);
  }

  throw engineUnavailable('Engine did not become healthy before timeout.');
}

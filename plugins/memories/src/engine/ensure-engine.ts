import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

import { isPidAlive, removeFileIfExists } from '../shared/fs-utils.js';
import { readLockMetadata } from '../shared/lockfile.js';
import { info, warn } from '../shared/logger.js';
import { ensureProjectDirectories, resolvePluginRoot } from '../shared/paths.js';

export interface EngineEndpoint {
  host: string;
  port: number;
}

const ENGINE_UNAVAILABLE_PREFIX = 'ENGINE_UNAVAILABLE';
const DEFAULT_HEALTH_TIMEOUT_MS = 1000;
const DEFAULT_BOOT_TIMEOUT_MS = 45_000;
const DEFAULT_BOOT_POLL_MS = 120;

function parseTimeoutMs(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function engineUnavailable(detail: string): Error {
  return new Error(`${ENGINE_UNAVAILABLE_PREFIX}: ${detail}`);
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
  const paths = await ensureProjectDirectories(projectRoot);
  const pluginRoot = resolvePluginRoot();
  const lock = await readLockMetadata(paths.lockPath);

  if (lock && isPidAlive(lock.pid)) {
    const endpoint = { host: lock.host, port: lock.port };
    if (await isEngineHealthy(endpoint)) {
      return endpoint;
    }
  }

  if (lock && !isPidAlive(lock.pid)) {
    await removeFileIfExists(paths.lockPath);
  }

  const engineEntrypoint = `${pluginRoot}/dist/engine/main.js`;
  if (!existsSync(engineEntrypoint)) {
    throw engineUnavailable(`engine entrypoint missing at ${engineEntrypoint}`);
  }
  const child = spawn('node', [engineEntrypoint], {
    detached: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PROJECT_ROOT: projectRoot,
    },
    stdio: 'ignore',
  });
  child.unref();

  const startedAt = Date.now();
  const maxWaitMs = parseTimeoutMs('MEMORIES_ENGINE_BOOT_TIMEOUT_MS', DEFAULT_BOOT_TIMEOUT_MS);
  const pollMs = parseTimeoutMs('MEMORIES_ENGINE_BOOT_POLL_MS', DEFAULT_BOOT_POLL_MS);

  while (Date.now() - startedAt < maxWaitMs) {
    const next = await readLockMetadata(paths.lockPath);
    if (next && isPidAlive(next.pid)) {
      const endpoint = { host: next.host, port: next.port };
      if (await isEngineHealthy(endpoint)) {
        info('Engine is ready', endpoint);
        return endpoint;
      }
    }
    await wait(pollMs);
  }

  warn('Engine readiness exceeded budget', { maxWaitMs, projectRoot });
  throw engineUnavailable('failed to become healthy in time');
}

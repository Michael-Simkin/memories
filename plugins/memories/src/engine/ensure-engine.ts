import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import { isPidAlive, removeFileIfExists } from '../shared/fs-utils.js';
import { readLockMetadata } from '../shared/lockfile.js';
import { info, warn } from '../shared/logger.js';
import { ensureProjectDirectories, resolvePluginRoot } from '../shared/paths.js';

export interface EngineEndpoint {
  host: string;
  port: number;
}

async function isEngineHealthy(endpoint: EngineEndpoint): Promise<boolean> {
  const timeoutMs = 120;
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
  const maxWaitMs = 4000;

  while (Date.now() - startedAt < maxWaitMs) {
    const next = await readLockMetadata(paths.lockPath);
    if (next && isPidAlive(next.pid)) {
      const endpoint = { host: next.host, port: next.port };
      if (await isEngineHealthy(endpoint)) {
        info('Engine is ready', endpoint);
        return endpoint;
      }
    }
    await wait(80);
  }

  warn('Engine readiness exceeded budget', { maxWaitMs });
  throw new Error('Engine failed to become healthy in time');
}

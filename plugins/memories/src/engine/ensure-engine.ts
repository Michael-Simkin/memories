import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const REQUIRED_NODE_MAJOR = 24;
const DEFAULT_HEALTH_TIMEOUT_MS = 1000;
const DEFAULT_BOOT_TIMEOUT_MS = 45_000;
const DEFAULT_BOOT_POLL_MS = 120;
const NODE_PROBE_TIMEOUT_MS = 1500;

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

function parseNodeMajor(version: string): number {
  const majorText = version.trim().split('.')[0] ?? '';
  const major = Number.parseInt(majorText, 10);
  return Number.isFinite(major) ? major : Number.NaN;
}

function dedupeCandidates(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value) {
      continue;
    }
    const key = path.resolve(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

function listVersionedNodeBins(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const versions = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .map((name) => ({
      name,
      parts: name
        .replace(/^v/i, '')
        .split('.')
        .map((part) => Number.parseInt(part, 10)),
    }))
    .filter((entry) => entry.parts.length === 3 && entry.parts.every((part) => Number.isFinite(part)))
    .sort((left, right) => {
      const [la, lb, lc] = left.parts;
      const [ra, rb, rc] = right.parts;
      return (ra ?? 0) - (la ?? 0) || (rb ?? 0) - (lb ?? 0) || (rc ?? 0) - (lc ?? 0);
    })
    .map((entry) => entry.name);

  return versions.map((version) => path.join(rootDir, version, 'bin', 'node'));
}

function candidateNodeExecutables(): string[] {
  const homeDir = os.homedir();
  const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');

  return dedupeCandidates([
    process.env.MEMORIES_NODE_BIN ?? '',
    process.execPath,
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'node') : '',
    ...listVersionedNodeBins(path.join(nvmDir, 'versions', 'node')),
    ...listVersionedNodeBins(path.join(homeDir, '.asdf', 'installs', 'nodejs')),
    ...listVersionedNodeBins(path.join(homeDir, '.volta', 'tools', 'image', 'node')),
    '/opt/homebrew/opt/node@24/bin/node',
    '/usr/local/opt/node@24/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ]);
}

async function probeNodeVersion(executable: string): Promise<string | null> {
  if (!existsSync(executable)) {
    return null;
  }

  return new Promise((resolve) => {
    execFile(
      executable,
      ['-p', 'process.versions.node'],
      { timeout: NODE_PROBE_TIMEOUT_MS },
      (probeError, stdout) => {
        if (probeError) {
          resolve(null);
          return;
        }
        const version = stdout.trim();
        resolve(version || null);
      },
    );
  });
}

async function resolveEngineNodeExecutable(): Promise<string> {
  let highestFound: { executable: string; major: number; version: string } | null = null;
  for (const executable of candidateNodeExecutables()) {
    const version = await probeNodeVersion(executable);
    if (!version) {
      continue;
    }
    const major = parseNodeMajor(version);
    if (!Number.isFinite(major)) {
      continue;
    }
    if (!highestFound || major > highestFound.major) {
      highestFound = { executable, major, version };
    }
    if (major >= REQUIRED_NODE_MAJOR) {
      return executable;
    }
  }

  const highestDetail = highestFound
    ? `highest discovered runtime is v${highestFound.version} at ${highestFound.executable}`
    : 'no candidate node runtime was discovered';

  throw engineUnavailable(
    `Node.js >=${REQUIRED_NODE_MAJOR} is required for engine startup (${highestDetail}). Set MEMORIES_NODE_BIN to an absolute Node 24+ binary path.`,
  );
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
  const nodeExecutable = await resolveEngineNodeExecutable();
  const spawnState: { failure: Error | null } = { failure: null };
  const child = spawn(nodeExecutable, [engineEntrypoint], {
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

  const startedAt = Date.now();
  const maxWaitMs = parseTimeoutMs('MEMORIES_ENGINE_BOOT_TIMEOUT_MS', DEFAULT_BOOT_TIMEOUT_MS);
  const pollMs = parseTimeoutMs('MEMORIES_ENGINE_BOOT_POLL_MS', DEFAULT_BOOT_POLL_MS);

  while (Date.now() - startedAt < maxWaitMs) {
    if (spawnState.failure) {
      throw engineUnavailable(
        `failed to spawn engine process via ${nodeExecutable}: ${spawnState.failure.message}`,
      );
    }
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

  if (spawnState.failure) {
    throw engineUnavailable(
      `failed to spawn engine process via ${nodeExecutable}: ${spawnState.failure.message}`,
    );
  }
  warn('Engine readiness exceeded budget', { maxWaitMs, projectRoot });
  throw engineUnavailable('failed to become healthy in time');
}

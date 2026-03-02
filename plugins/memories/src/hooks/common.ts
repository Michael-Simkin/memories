import path from 'node:path';

import { ENGINE_HOST } from '../shared/constants.js';
import { readLockMetadata } from '../shared/lockfile.js';
import { getProjectPaths, resolveProjectRoot } from '../shared/paths.js';

export function resolveHookProjectRoot(payload: {
  project_root?: string | undefined;
  cwd?: string | undefined;
}): string {
  if (payload.project_root && path.isAbsolute(payload.project_root)) {
    return payload.project_root;
  }
  if (payload.cwd && path.isAbsolute(payload.cwd)) {
    return payload.cwd;
  }
  return resolveProjectRoot();
}

export async function resolveEndpointFromLock(projectRoot: string): Promise<{
  host: string;
  port: number;
  lockPath: string;
}> {
  const paths = getProjectPaths(projectRoot);
  const lock = await readLockMetadata(paths.lockPath);
  if (!lock) {
    throw new Error('Engine lock metadata not found');
  }
  if (lock.host !== ENGINE_HOST && lock.host !== 'localhost' && lock.host !== '::1') {
    throw new Error(`Lock host is not loopback: ${lock.host}`);
  }
  return {
    host: lock.host,
    port: lock.port,
    lockPath: paths.lockPath,
  };
}

export function isEngineUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Engine lock metadata not found');
}

export async function postEngineJson<TInput, TOutput>(
  endpoint: { host: string; port: number },
  route: string,
  payload: TInput,
): Promise<TOutput> {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${response.statusText} ${body}`);
  }
  return (await response.json()) as TOutput;
}

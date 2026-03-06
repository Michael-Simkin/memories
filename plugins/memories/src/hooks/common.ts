import path from 'node:path';

import { LOOPBACK_HOST_ALIASES } from '../shared/constants.js';
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
  lockPath: string;
  port: number;
}> {
  const paths = getProjectPaths(projectRoot);
  const lock = await readLockMetadata(paths.lockPath);
  if (!lock) {
    throw new Error('ENGINE_UNAVAILABLE: lock metadata not found');
  }
  if (!LOOPBACK_HOST_ALIASES.includes(lock.host as (typeof LOOPBACK_HOST_ALIASES)[number])) {
    throw new Error(`ENGINE_UNAVAILABLE: lock host is not loopback (${lock.host})`);
  }

  return {
    host: lock.host,
    port: lock.port,
    lockPath: paths.lockPath,
  };
}

export function isEngineUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes('ENGINE_UNAVAILABLE:');
}

export async function postEngineJson<TRequest, TResponse>(
  endpoint: { host: string; port: number },
  route: string,
  payload: TRequest,
): Promise<TResponse> {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ENGINE_UNAVAILABLE: ${response.status} ${response.statusText} ${body}`);
  }
  return (await response.json()) as TResponse;
}

export async function getEngineJson<TResponse>(
  endpoint: { host: string; port: number },
  route: string,
): Promise<TResponse> {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}${route}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ENGINE_UNAVAILABLE: ${response.status} ${response.statusText} ${body}`);
  }
  return (await response.json()) as TResponse;
}

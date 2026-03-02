import { z } from 'zod';

import { ENGINE_HOST } from './constants.js';
import { atomicWriteJson, readJsonFile, removeFileIfExists } from './fs-utils.js';

const lockMetadataSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  started_at: z.string().min(1),
  connected_session_ids: z.array(z.string()).default([]),
});

export type LockMetadata = z.infer<typeof lockMetadataSchema>;

export async function readLockMetadata(lockPath: string): Promise<LockMetadata | null> {
  const raw = await readJsonFile<unknown>(lockPath);
  if (!raw) {
    return null;
  }

  const parsed = lockMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  if (!isLoopback(parsed.data.host)) {
    return null;
  }

  return {
    ...parsed.data,
    connected_session_ids: [...new Set(parsed.data.connected_session_ids)],
  };
}

export async function writeLockMetadata(lockPath: string, payload: LockMetadata): Promise<void> {
  const uniqueSessionIds = [...new Set(payload.connected_session_ids)];
  await atomicWriteJson(lockPath, {
    connected_session_ids: uniqueSessionIds,
    host: payload.host,
    pid: payload.pid,
    port: payload.port,
    started_at: payload.started_at,
  });
}

export async function updateConnectedSessions(
  lockPath: string,
  updater: (current: string[]) => string[],
): Promise<LockMetadata | null> {
  const current = await readLockMetadata(lockPath);
  if (!current) {
    return null;
  }
  const nextSessions = [...new Set(updater(current.connected_session_ids))].filter(Boolean);
  const next: LockMetadata = {
    ...current,
    connected_session_ids: nextSessions,
  };
  await writeLockMetadata(lockPath, next);
  return next;
}

export async function removeLockIfOwned(lockPath: string, ownerPid: number): Promise<void> {
  const current = await readLockMetadata(lockPath);
  if (!current) {
    return;
  }
  if (current.pid !== ownerPid) {
    return;
  }
  await removeFileIfExists(lockPath);
}

export function isLoopback(host: string): boolean {
  return host === ENGINE_HOST || host === 'localhost' || host === '::1';
}

import { z } from 'zod';

import { LOOPBACK_HOST_ALIASES } from './constants.js';
import { atomicWriteJson, readJsonFile, removeFileIfExists } from './fs-utils.js';

const lockMetadataSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  started_at: z.string().min(1),
  connected_session_ids: z.array(z.string().trim().min(1)).default([]),
});

export type LockMetadata = z.infer<typeof lockMetadataSchema>;

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOST_ALIASES.includes(host as (typeof LOOPBACK_HOST_ALIASES)[number]);
}

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
    connected_session_ids: uniqueNonEmpty(parsed.data.connected_session_ids),
  };
}

export async function writeLockMetadata(lockPath: string, payload: LockMetadata): Promise<void> {
  const normalized = lockMetadataSchema.parse({
    ...payload,
    connected_session_ids: uniqueNonEmpty(payload.connected_session_ids),
  });
  if (!isLoopback(normalized.host)) {
    throw new Error(`Lock host must be loopback, received: ${normalized.host}`);
  }
  await atomicWriteJson(lockPath, normalized);
}

export async function updateConnectedSessions(
  lockPath: string,
  updater: (sessions: string[]) => string[],
): Promise<LockMetadata | null> {
  const current = await readLockMetadata(lockPath);
  if (!current) {
    return null;
  }

  const next: LockMetadata = {
    ...current,
    connected_session_ids: uniqueNonEmpty(updater(current.connected_session_ids)),
  };
  await writeLockMetadata(lockPath, next);
  return next;
}

export async function removeLockIfOwned(lockPath: string, ownerPid: number): Promise<void> {
  const current = await readLockMetadata(lockPath);
  if (!current || current.pid !== ownerPid) {
    return;
  }
  await removeFileIfExists(lockPath);
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

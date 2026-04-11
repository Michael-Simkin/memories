import { z } from 'zod';

import { atomicWriteJson, isPidAlive, readJsonFile, removeFileIfExists } from './fs-utils.js';

const syncLockSchema = z.object({
  pid: z.number().int().positive(),
  started_at: z.string().min(1),
});

export type SyncLock = z.infer<typeof syncLockSchema>;

export async function readSyncLock(lockPath: string): Promise<SyncLock | null> {
  const raw = await readJsonFile<unknown>(lockPath);
  if (!raw) {
    return null;
  }
  const parsed = syncLockSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function isSyncRunning(lockPath: string): Promise<boolean> {
  const lock = await readSyncLock(lockPath);
  if (!lock) {
    return false;
  }
  return isPidAlive(lock.pid);
}

export async function writeSyncLock(lockPath: string): Promise<void> {
  await atomicWriteJson(lockPath, {
    pid: process.pid,
    started_at: new Date().toISOString(),
  });
}

export async function removeSyncLockIfOwned(lockPath: string): Promise<void> {
  const lock = await readSyncLock(lockPath);
  if (!lock || lock.pid !== process.pid) {
    return;
  }
  await removeFileIfExists(lockPath);
}

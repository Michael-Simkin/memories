import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isSyncRunning, readSyncLock, removeSyncLockIfOwned, writeSyncLock } from './lockfile.js';
import { atomicWriteJson, isPidAlive, readJsonFile, removeFileIfExists } from './fs-utils.js';

describe('lockfile', () => {
  it('writes and reads sync lock with current PID', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-lock-'));
    const lockPath = path.join(dir, 'sync.lock.json');

    await writeSyncLock(lockPath);

    const lock = await readSyncLock(lockPath);
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(process.pid);
    expect(typeof lock!.started_at).toBe('string');
  });

  it('reports sync running when PID is alive', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-lock-'));
    const lockPath = path.join(dir, 'sync.lock.json');

    await writeSyncLock(lockPath);

    const running = await isSyncRunning(lockPath);
    expect(running).toBe(true);
  });

  it('reports sync not running when no lock file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-lock-'));
    const lockPath = path.join(dir, 'nonexistent.lock.json');

    const running = await isSyncRunning(lockPath);
    expect(running).toBe(false);
  });

  it('removes lock only when owned by current process', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-lock-'));
    const lockPath = path.join(dir, 'sync.lock.json');

    await writeSyncLock(lockPath);
    await removeSyncLockIfOwned(lockPath);

    const lock = await readSyncLock(lockPath);
    expect(lock).toBeNull();
  });
});

describe('fs-utils', () => {
  it('atomic writes and reads JSON', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-fs-'));
    const filePath = path.join(dir, 'data.json');

    await atomicWriteJson(filePath, { key: 'value', num: 42 });

    const result = await readJsonFile<{ key: string; num: number }>(filePath);
    expect(result).toEqual({ key: 'value', num: 42 });
  });

  it('returns null for missing files', async () => {
    const result = await readJsonFile('/nonexistent/path/file.json');
    expect(result).toBeNull();
  });

  it('removes file if exists, no-ops if not', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-fs-'));
    const filePath = path.join(dir, 'temp.json');

    await atomicWriteJson(filePath, { test: true });
    await removeFileIfExists(filePath);

    const result = await readJsonFile(filePath);
    expect(result).toBeNull();

    // Should not throw for missing file
    await removeFileIfExists(filePath);
  });

  it('detects alive PIDs', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999999999)).toBe(false);
  });
});

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizePathForMatch } from './fs-utils.js';
import { readLockMetadata, removeLockIfOwned, writeLockMetadata } from './lockfile.js';
import { appendEventLog, readEventLogs } from './logs.js';
import { formatMemoryRecallMarkdown } from './markdown.js';
import type { MemoryEventLog, SearchResult } from './types.js';

describe('shared foundations', () => {
  it('writes and reads lock metadata with loopback guard and deduped sessions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'memories-lock-'));
    const lockPath = path.join(tempDir, 'engine.lock.json');

    await writeLockMetadata(lockPath, {
      host: '127.0.0.1',
      port: 4182,
      pid: process.pid,
      started_at: new Date().toISOString(),
      connected_session_ids: ['session-a', 'session-a', 'session-b'],
    });

    const lock = await readLockMetadata(lockPath);
    expect(lock).not.toBeNull();
    expect(lock?.connected_session_ids).toEqual(['session-a', 'session-b']);
  });

  it('returns null for non-loopback lock metadata', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'memories-lock-host-'));
    const lockPath = path.join(tempDir, 'engine.lock.json');

    await writeFile(
      lockPath,
      JSON.stringify({
        host: '10.0.0.1',
        port: 4123,
        pid: process.pid,
        started_at: new Date().toISOString(),
        connected_session_ids: [],
      }),
      'utf8',
    );

    const lock = await readLockMetadata(lockPath);
    expect(lock).toBeNull();
  });

  it('removes lock only when owner pid matches', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'memories-lock-owner-'));
    const lockPath = path.join(tempDir, 'engine.lock.json');

    await writeLockMetadata(lockPath, {
      host: '127.0.0.1',
      port: 4242,
      pid: process.pid + 99_999,
      started_at: new Date().toISOString(),
      connected_session_ids: [],
    });

    await removeLockIfOwned(lockPath, process.pid);
    const lockAfterWrongOwner = await readLockMetadata(lockPath);
    expect(lockAfterWrongOwner).not.toBeNull();

    await removeLockIfOwned(lockPath, process.pid + 99_999);
    const lockAfterRightOwner = await readLockMetadata(lockPath);
    expect(lockAfterRightOwner).toBeNull();
  });

  it('normalizes relative and windows-like paths', () => {
    expect(normalizePathForMatch('./src/app.ts')).toBe('src/app.ts');
    expect(normalizePathForMatch('src\\nested\\index.ts')).toBe('src/nested/index.ts');
    expect(normalizePathForMatch('')).toBe('');
  });

  it('redacts secrets in unified logs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'memories-log-'));
    const logPath = path.join(tempDir, 'events.log');

    const event: MemoryEventLog = {
      at: new Date().toISOString(),
      event: 'test.log',
      status: 'ok',
      kind: 'system',
      detail: 'token=abc123',
      data: {
        apiKey: 'sk-test-secret-token',
      },
    };

    await appendEventLog(logPath, event);
    const raw = await readFile(logPath, 'utf8');
    expect(raw.includes('sk-test-secret-token')).toBe(false);
    expect(raw.includes('[REDACTED]')).toBe(true);

    const loaded = await readEventLogs(logPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.event).toBe('test.log');
  });

  it('renders grouped markdown sections in canonical order', () => {
    const results: SearchResult[] = [
      {
        id: 'mem-1',
        memory_type: 'rule',
        content: 'Never commit credentials.',
        tags: ['security'],
        is_pinned: true,
        path_matchers: ['**/*.env'],
        score: 0.98,
        source: 'path',
        updated_at: '2026-03-05T00:00:00.000Z',
      },
      {
        id: 'mem-2',
        memory_type: 'fact',
        content: 'Project uses Node 20.',
        tags: ['runtime'],
        is_pinned: false,
        path_matchers: [],
        score: 0.7,
        source: 'hybrid',
        updated_at: '2026-03-05T00:00:00.000Z',
      },
    ];

    const markdown = formatMemoryRecallMarkdown({
      query: 'runtime and security',
      results,
      durationMs: 9,
      source: 'hybrid',
    });

    expect(markdown.includes('# Memory Recall')).toBe(true);
    expect(markdown.indexOf('## Facts')).toBeLessThan(markdown.indexOf('## Rules'));
    expect(markdown.includes('Project uses Node 20.')).toBe(true);
    expect(markdown.includes('Never commit credentials.')).toBe(true);
  });
});

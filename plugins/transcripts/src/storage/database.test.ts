import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TranscriptStore } from './database.js';

async function createTempStore(): Promise<TranscriptStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-db-'));
  return new TranscriptStore(path.join(dir, 'test.db'));
}

describe('TranscriptStore', () => {
  it('inserts and retrieves chunks with embeddings', async () => {
    const store = await createTempStore();

    store.setSyncProgress('/test.jsonl', 100, 1, 'complete');
    store.insertChunk({
      chunkId: 'c1',
      transcriptPath: '/test.jsonl',
      lineNumber: 5,
      role: 'user',
      chunkText: 'test content',
      chunkIndex: 0,
      sessionTimestamp: 1000,
      projectPath: '/project',
    });
    store.insertEmbedding('c1', [0.1, 0.2, 0.3]);

    const all = store.getAllEmbeddings();
    expect(all).toHaveLength(1);
    expect(all[0]!.chunkId).toBe('c1');
    expect(all[0]!.chunkText).toBe('test content');
    expect(all[0]!.vector).toEqual([0.1, 0.2, 0.3]);
    expect(all[0]!.lineNumber).toBe(5);
    expect(all[0]!.role).toBe('user');

    store.close();
  });

  it('tracks sync progress per transcript', async () => {
    const store = await createTempStore();

    store.setSyncProgress('/a.jsonl', 100, 10, 'complete');
    store.setSyncProgress('/b.jsonl', 200, 5, 'error');

    const a = store.getSyncStatus('/a.jsonl');
    expect(a).not.toBeNull();
    expect(a!.mtime).toBe(100);
    expect(a!.status).toBe('complete');

    const b = store.getSyncStatus('/b.jsonl');
    expect(b!.status).toBe('error');

    const missing = store.getSyncStatus('/c.jsonl');
    expect(missing).toBeNull();

    store.close();
  });

  it('upserts sync progress on conflict', async () => {
    const store = await createTempStore();

    store.setSyncProgress('/a.jsonl', 100, 10, 'partial');
    store.setSyncProgress('/a.jsonl', 200, 20, 'complete');

    const status = store.getSyncStatus('/a.jsonl');
    expect(status!.mtime).toBe(200);
    expect(status!.status).toBe('complete');

    store.close();
  });

  it('deletes all chunks for a transcript', async () => {
    const store = await createTempStore();

    store.setSyncProgress('/a.jsonl', 100, 2, 'complete');
    store.insertChunk({
      chunkId: 'c1',
      transcriptPath: '/a.jsonl',
      lineNumber: 1,
      role: 'user',
      chunkText: 'chunk 1',
      chunkIndex: 0,
      sessionTimestamp: 1000,
      projectPath: '/p',
    });
    store.insertChunk({
      chunkId: 'c2',
      transcriptPath: '/a.jsonl',
      lineNumber: 2,
      role: 'assistant',
      chunkText: 'chunk 2',
      chunkIndex: 0,
      sessionTimestamp: 1000,
      projectPath: '/p',
    });
    store.insertEmbedding('c1', [0.1]);
    store.insertEmbedding('c2', [0.2]);

    store.deleteChunksForTranscript('/a.jsonl');

    expect(store.getAllEmbeddings()).toHaveLength(0);
    expect(store.getSyncStatus('/a.jsonl')).toBeNull();

    store.close();
  });

  it('returns all synced paths', async () => {
    const store = await createTempStore();

    store.setSyncProgress('/a.jsonl', 100, 10, 'complete');
    store.setSyncProgress('/b.jsonl', 200, 5, 'complete');

    const paths = store.getAllSyncedPaths();
    expect(paths.size).toBe(2);
    expect(paths.has('/a.jsonl')).toBe(true);
    expect(paths.has('/b.jsonl')).toBe(true);

    store.close();
  });

  it('handles transactions correctly', async () => {
    const store = await createTempStore();

    store.setSyncProgress('/a.jsonl', 100, 0, 'complete');

    store.beginTransaction();
    store.insertChunk({
      chunkId: 'c1',
      transcriptPath: '/a.jsonl',
      lineNumber: 1,
      role: 'user',
      chunkText: 'test',
      chunkIndex: 0,
      sessionTimestamp: 1000,
      projectPath: '/p',
    });
    store.rollbackTransaction();

    expect(store.getAllEmbeddings()).toHaveLength(0);

    store.close();
  });
});

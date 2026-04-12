import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TranscriptStore } from '../storage/database.js';
import { searchTranscripts } from './retrieval.js';

function normalizedVector(seed: number, dims: number): number[] {
  const vec = Array.from({ length: dims }, (_, i) => Math.sin(seed + i));
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / norm);
}

class MockEmbedder {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  get dimensions() {
    return 16;
  }
  get model() {
    return 'mock';
  }
  async embed(_text: string): Promise<number[] | null> {
    return normalizedVector(this.seed, 16);
  }
}

async function createStoreWithChunks(): Promise<TranscriptStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-search-'));
  const store = new TranscriptStore(path.join(dir, 'test.db'));

  store.setCheckpoint('/a.jsonl', 100, 50, 3, '/project', 1000, 'complete');

  const chunks = [
    { id: 'c1', line: 1, role: 'user', text: 'How to write tests', seed: 1.0, ts: 1000 },
    { id: 'c2', line: 5, role: 'assistant', text: 'Use vitest with describe', seed: 1.2, ts: 1000 },
    { id: 'c3', line: 10, role: 'user', text: 'Deploy to production', seed: 5.0, ts: 2000 },
  ];

  for (const c of chunks) {
    store.insertChunk({
      chunkId: c.id,
      transcriptPath: '/a.jsonl',
      lineNumber: c.line,
      role: c.role,
      chunkText: c.text,
      chunkIndex: 0,
      sessionTimestamp: c.ts,
      projectPath: '/project',
    });
    store.insertEmbedding(c.id, normalizedVector(c.seed, 16));
  }

  return store;
}

describe('retrieval', () => {
  it('returns results sorted by similarity score', async () => {
    const store = await createStoreWithChunks();
    const embedder = new MockEmbedder(1.1) as any;

    const results = await searchTranscripts(store, embedder, 'testing', 10);

    expect(results.length).toBeGreaterThan(0);

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }

    store.close();
  });

  it('respects the limit parameter', async () => {
    const store = await createStoreWithChunks();
    const embedder = new MockEmbedder(1.0) as any;

    const results = await searchTranscripts(store, embedder, 'test', 1);
    expect(results.length).toBeLessThanOrEqual(1);

    store.close();
  });

  it('returns empty array when embedder fails', async () => {
    const store = await createStoreWithChunks();
    const failingEmbedder = {
      dimensions: 16,
      model: 'mock',
      async embed() {
        return null;
      },
    } as any;

    const results = await searchTranscripts(store, failingEmbedder, 'test', 10);
    expect(results).toHaveLength(0);

    store.close();
  });

  it('includes correct metadata in results', async () => {
    const store = await createStoreWithChunks();
    const embedder = new MockEmbedder(1.0) as any;

    const results = await searchTranscripts(store, embedder, 'test', 10);

    for (const r of results) {
      expect(r.transcriptPath).toBe('/a.jsonl');
      expect(r.projectPath).toBe('/project');
      expect(typeof r.lineNumber).toBe('number');
      expect(typeof r.score).toBe('number');
      expect(typeof r.snippet).toBe('string');
      expect(r.snippet.length).toBeLessThanOrEqual(200 + 3); // +3 for "..."
    }

    store.close();
  });
});

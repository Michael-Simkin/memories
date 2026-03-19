import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AddMemoryInput } from '../shared/types.js';
import { MemoryStore } from './database.js';

async function createStore(): Promise<MemoryStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'memories-db-'));
  const dbPath = path.join(tempDir, 'ai_memory.db');
  return new MemoryStore({
    dbPath,
    embeddingDimensions: 3,
  });
}

describe('MemoryStore', () => {
  it('rolls back on failed create transaction', async () => {
    const store = await createStore();

    const invalidInput = {
      memory_type: 'invalid',
      content: 'bad memory type',
      tags: ['bad'],
      is_pinned: false,
      path_matchers: [],
    } as unknown as AddMemoryInput;

    expect(() => store.createMemory('test-repo-id-0001', invalidInput)).toThrow();
    expect(store.memoryCount('test-repo-id-0001')).toBe(0);

    store.close();
  });

  it('supports create-update-delete round trip with matchers and embeddings', async () => {
    const store = await createStore();

    const repoId = 'test-repo-id-0001';
    const created = store.createMemory(
      repoId,
      {
        repo_id: repoId,
        memory_type: 'fact',
        content: 'Node runtime is 20+',
        tags: ['runtime', 'node'],
        is_pinned: true,
        path_matchers: [{ path_matcher: 'package.json' }],
      },
      [0.1, 0.2, 0.3],
    );

    expect(created.path_matchers).toEqual([{ path_matcher: 'package.json' }]);

    const updated = store.updateMemory(
      repoId,
      created.id,
      {
        repo_id: repoId,
        tags: ['runtime', 'node', 'platform'],
        path_matchers: [{ path_matcher: 'plugins/**' }],
      },
      [0.3, 0.2, 0.1],
    );

    expect(updated).not.toBeNull();
    expect(updated?.tags).toEqual(['runtime', 'node', 'platform']);
    expect(updated?.path_matchers).toEqual([{ path_matcher: 'plugins/**' }]);

    const embeddings = store.listEmbeddings(repoId);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]?.vector).toEqual([0.3, 0.2, 0.1]);

    const deleted = store.deleteMemory(repoId, created.id);
    expect(deleted).toBe(true);
    expect(store.getMemory(repoId, created.id)).toBeNull();
    expect(store.listEmbeddings(repoId)).toHaveLength(0);

    store.close();
  });

  it('enforces schema constraints for tags_json validity', async () => {
    const store = await createStore();
    const database = (store as unknown as { database: { prepare: (sql: string) => { run: (...params: unknown[]) => void } } }).database;

    expect(() => {
      database
        .prepare(
          `
            INSERT INTO memories (id, memory_type, content, tags_json, is_pinned, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'mem-raw',
          'fact',
          'raw insert',
          '{invalid json',
          0,
          new Date().toISOString(),
          new Date().toISOString(),
        );
    }).toThrow();

    store.close();
  });
});

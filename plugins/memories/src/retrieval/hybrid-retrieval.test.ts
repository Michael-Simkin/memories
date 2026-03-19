import { describe, expect, it } from 'vitest';

import type { MemoryRecord, MemoryType, SearchResult } from '../shared/types.js';
import type { MemoryStore } from '../storage/database.js';
import type { EmbeddingClient } from './embeddings.js';
import { RetrievalService } from './hybrid-retrieval.js';

interface FakeEmbeddingRow {
  id: string;
  memory_type: MemoryType;
  content: string;
  tags: string[];
  is_pinned: boolean;
  updated_at: string;
  vector: number[];
}

class FakeStore {
  public lexicalResults: SearchResult[] = [];
  public pathMatchers: Array<{ memory_id: string; path_matcher: string }> = [];
  public memoriesById = new Map<string, SearchResult>();
  public embeddings: FakeEmbeddingRow[] = [];

  public lexicalSearch(_repoId: string): SearchResult[] {
    return this.lexicalResults;
  }

  public listPathMatchers(_repoId: string): Array<{ memory_id: string; path_matcher: string }> {
    return this.pathMatchers;
  }

  public getMemoriesByIds(_repoId: string, ids: string[]): SearchResult[] {
    return ids.flatMap((id) => {
      const value = this.memoriesById.get(id);
      return value ? [value] : [];
    });
  }

  public listEmbeddings(_repoId: string): FakeEmbeddingRow[] {
    return this.embeddings;
  }

  public getMemory(_repoId: string, id: string): MemoryRecord | null {
    const result = this.memoriesById.get(id);
    if (!result) {
      return null;
    }
    return {
      id: result.id,
      memory_type: result.memory_type,
      content: result.content,
      tags: result.tags,
      is_pinned: result.is_pinned,
      path_matchers: result.path_matchers.map((pathMatcher) => ({ path_matcher: pathMatcher })),
      created_at: result.updated_at,
      updated_at: result.updated_at,
    };
  }
}

class FakeEmbeddingClient {
  private readonly queryVector: number[] | null;

  public constructor(queryVector: number[] | null) {
    this.queryVector = queryVector;
  }

  public isConfigured(): boolean {
    return true;
  }

  public async embed(): Promise<number[] | null> {
    return this.queryVector;
  }
}

function makeResult(input: {
  id: string;
  type: MemoryType;
  content: string;
  tags?: string[];
  pinned?: boolean;
  source?: 'path' | 'hybrid';
  score?: number;
  updatedAt?: string;
  pathMatchers?: string[];
}): SearchResult {
  return {
    id: input.id,
    memory_type: input.type,
    content: input.content,
    tags: input.tags ?? [],
    is_pinned: input.pinned ?? false,
    path_matchers: input.pathMatchers ?? [],
    source: input.source ?? 'hybrid',
    score: input.score ?? 0,
    updated_at: input.updatedAt ?? '2026-03-05T00:00:00.000Z',
  };
}

describe('RetrievalService', () => {
  it('ranks path matches by policy effect then specificity', async () => {
    const store = new FakeStore();
    store.pathMatchers = [
      { memory_id: 'm1', path_matcher: 'src/**' },
      { memory_id: 'm2', path_matcher: 'src/app.ts' },
      { memory_id: 'm3', path_matcher: 'src/*.ts' },
      { memory_id: 'm4', path_matcher: 'src' },
    ];
    store.memoriesById.set(
      'm1',
      makeResult({
        id: 'm1',
        type: 'rule',
        content: 'Do not modify generated files.',
        pathMatchers: ['src/**'],
      }),
    );
    store.memoriesById.set(
      'm2',
      makeResult({
        id: 'm2',
        type: 'rule',
        content: 'You must keep source files readable.',
        pathMatchers: ['src/app.ts'],
      }),
    );
    store.memoriesById.set(
      'm3',
      makeResult({
        id: 'm3',
        type: 'rule',
        content: 'You must follow naming conventions.',
        pinned: true,
        pathMatchers: ['src/*.ts'],
      }),
    );
    store.memoriesById.set(
      'm4',
      makeResult({
        id: 'm4',
        type: 'rule',
        content: 'Context for this directory.',
        pathMatchers: ['src'],
      }),
    );

    const retrieval = new RetrievalService(
      store as unknown as MemoryStore,
      new FakeEmbeddingClient(null) as unknown as EmbeddingClient,
    );

    const results = await retrieval.search('test-repo-id-0001', {
      query: '',
      limit: 10,
      includePinned: true,
      targetPaths: ['src', 'src/app.ts'],
    });

    expect(results.map((value) => value.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(results.every((value) => value.source === 'path')).toBe(true);
    expect(results[0]?.matched_by).toEqual(['path']);
    expect(results[0]?.score).toBeCloseTo(1, 5);
    expect(results[1]?.score).toBeCloseTo(0.5, 5);
    expect(results[0]?.path_score).toBeCloseTo(1, 5);
  });

  it('merges lexical and semantic branches with de-duplication and stable ordering', async () => {
    const store = new FakeStore();
    store.lexicalResults = [
      makeResult({
        id: 'a',
        type: 'fact',
        content: 'A',
        updatedAt: '2026-03-01T00:00:00.000Z',
        score: 0.9,
      }),
      makeResult({
        id: 'b',
        type: 'fact',
        content: 'B',
        updatedAt: '2026-03-03T00:00:00.000Z',
        score: 0.8,
      }),
    ];
    store.memoriesById.set('a', store.lexicalResults[0]!);
    store.memoriesById.set('b', store.lexicalResults[1]!);
    store.memoriesById.set(
      'c',
      makeResult({
        id: 'c',
        type: 'fact',
        content: 'C',
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
    );
    store.embeddings = [
      {
        id: 'b',
        memory_type: 'fact',
        content: 'B',
        tags: [],
        is_pinned: false,
        updated_at: '2026-03-03T00:00:00.000Z',
        vector: [1, 0],
      },
      {
        id: 'c',
        memory_type: 'fact',
        content: 'C',
        tags: [],
        is_pinned: false,
        updated_at: '2026-03-02T00:00:00.000Z',
        vector: [0.9, 0],
      },
    ];

    const retrieval = new RetrievalService(
      store as unknown as MemoryStore,
      new FakeEmbeddingClient([1, 0]) as unknown as EmbeddingClient,
    );

    const results = await retrieval.search('test-repo-id-0001', {
      query: 'query',
      limit: 5,
      includePinned: true,
    });

    expect(results.map((value) => value.id)).toEqual(['b', 'a', 'c']);
    expect(results[0]?.matched_by).toEqual(['lexical', 'semantic']);
    expect(results[0]?.lexical_score).toBeCloseTo(0.8, 5);
    expect(results[0]?.semantic_score).toBeCloseTo(1, 5);
    expect(results[0]?.rrf_score).toBeCloseTo(1 / 62 + 1 / 61, 5);
    expect(results[0]?.score).toBeCloseTo(1, 5);
    expect(results[1]?.matched_by).toEqual(['lexical']);
    expect(results[1]?.score).toBeCloseTo((1 / 61) / (1 / 62 + 1 / 61), 5);
    expect(results[2]?.matched_by).toEqual(['semantic']);
  });

  it('falls back to lexical results when embedding lookup fails', async () => {
    const store = new FakeStore();
    store.lexicalResults = [
      makeResult({
        id: 'only-lexical',
        type: 'fact',
        content: 'Lexical result',
      }),
    ];

    const retrieval = new RetrievalService(
      store as unknown as MemoryStore,
      new FakeEmbeddingClient(null) as unknown as EmbeddingClient,
    );

    const results = await retrieval.search('test-repo-id-0001', {
      query: 'whatever',
      limit: 5,
      includePinned: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('only-lexical');
  });

  it('applies response token budget to bound output size', async () => {
    const store = new FakeStore();
    store.lexicalResults = [
      makeResult({
        id: 'long-1',
        type: 'fact',
        content: 'This is a long memory that costs many tokens'.repeat(4),
      }),
      makeResult({
        id: 'long-2',
        type: 'fact',
        content: 'Another long memory result that should be clipped'.repeat(4),
      }),
    ];

    const retrieval = new RetrievalService(
      store as unknown as MemoryStore,
      new FakeEmbeddingClient(null) as unknown as EmbeddingClient,
    );

    const results = await retrieval.search('test-repo-id-0001', {
      query: 'long',
      limit: 10,
      includePinned: true,
      responseTokenBudget: 30,
    });

    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe('long-1');
  });
});

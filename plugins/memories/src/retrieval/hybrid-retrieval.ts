import picomatch from 'picomatch';

import { DEFAULT_LEXICAL_K, DEFAULT_SEMANTIC_K } from '../shared/constants.js';
import { normalizePathForMatch } from '../shared/fs-utils.js';
import type { MemoryType, SearchResult } from '../shared/types.js';
import type { MemoryStore } from '../storage/database.js';
import type { EmbeddingClient } from './embeddings.js';

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const ai = a[index] ?? 0;
    const bi = b[index] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface QueryOptions {
  query: string;
  limit: number;
  memoryTypes?: MemoryType[] | undefined;
  includePinned: boolean;
  semanticK?: number | undefined;
  lexicalK?: number | undefined;
}

export class RetrievalService {
  private readonly store: MemoryStore;
  private readonly embeddingClient: EmbeddingClient;

  public constructor(store: MemoryStore, embeddingClient: EmbeddingClient) {
    this.store = store;
    this.embeddingClient = embeddingClient;
  }

  public async search(options: QueryOptions): Promise<SearchResult[]> {
    const lexical = this.store.lexicalSearch({
      query: options.query,
      limit: options.lexicalK ?? DEFAULT_LEXICAL_K,
      includePinned: options.includePinned,
      ...(options.memoryTypes ? { memoryTypes: options.memoryTypes } : {}),
    });
    const semantic = await this.semanticSearch(options);
    return this.mergeHybrid({
      lexical,
      semantic,
      limit: options.limit,
    });
  }

  public async searchForPretool(input: {
    query: string;
    targetPaths: string[];
    limit: number;
    memoryTypes?: MemoryType[] | undefined;
    includePinned: boolean;
    semanticK?: number | undefined;
    lexicalK?: number | undefined;
  }): Promise<SearchResult[]> {
    const pathMatches = this.findPathMatches(
      input.targetPaths,
      input.memoryTypes,
      input.includePinned,
    );
    const hybrid = await this.search({
      query: input.query,
      limit: input.limit,
      includePinned: input.includePinned,
      ...(input.memoryTypes ? { memoryTypes: input.memoryTypes } : {}),
      ...(typeof input.semanticK === 'number' ? { semanticK: input.semanticK } : {}),
      ...(typeof input.lexicalK === 'number' ? { lexicalK: input.lexicalK } : {}),
    });

    const merged: SearchResult[] = [];
    const seen = new Set<string>();
    for (const result of pathMatches) {
      seen.add(result.id);
      merged.push(result);
      if (merged.length >= input.limit) {
        return merged;
      }
    }
    for (const result of hybrid) {
      if (seen.has(result.id)) {
        continue;
      }
      merged.push(result);
      if (merged.length >= input.limit) {
        break;
      }
    }
    return merged;
  }

  private async semanticSearch(options: QueryOptions): Promise<SearchResult[]> {
    if (!this.embeddingClient.isConfigured() || options.query.trim().length === 0) {
      return [];
    }
    const queryVector = await this.embeddingClient.embed(options.query);
    if (!queryVector) {
      return [];
    }

    const rows = this.store.listEmbeddings(options.memoryTypes, options.includePinned);
    return rows
      .map((row) => ({
        id: row.id,
        memory_type: row.memory_type,
        content: row.content,
        tags: row.tags,
        score: cosineSimilarity(queryVector, row.vector),
        is_pinned: row.is_pinned,
        updated_at: row.updated_at,
      }))
      .sort((a, b) => this.sortSearchResults(a, b))
      .slice(0, options.semanticK ?? DEFAULT_SEMANTIC_K);
  }

  private findPathMatches(
    targetPaths: string[],
    memoryTypes: MemoryType[] | undefined,
    includePinned: boolean,
  ): SearchResult[] {
    const normalizedPaths = targetPaths
      .map((inputPath) => normalizePathForMatch(inputPath))
      .filter(Boolean);
    if (normalizedPaths.length === 0) {
      return [];
    }

    const matchers = this.store.listPathMatchers();
    const matchScore = new Map<string, number>();
    for (const matcher of matchers) {
      const matcherFn = picomatch(matcher.path_matcher);
      const isMatch = normalizedPaths.some((targetPath) => matcherFn(targetPath));
      if (!isMatch) {
        continue;
      }
      const current = matchScore.get(matcher.memory_id) ?? Number.NEGATIVE_INFINITY;
      if (matcher.priority > current) {
        matchScore.set(matcher.memory_id, matcher.priority);
      }
    }

    const ids = [...matchScore.keys()];
    if (ids.length === 0) {
      return [];
    }
    const memories = this.store
      .getMemoriesByIds(ids)
      .filter((memory) => (memoryTypes ? memoryTypes.includes(memory.memory_type) : true))
      .filter((memory) => (includePinned ? true : !memory.is_pinned))
      .map((memory) => ({
        ...memory,
        score: (matchScore.get(memory.id) ?? 0) + 1000,
      }));

    memories.sort((a, b) => this.sortSearchResults(a, b));
    return memories;
  }

  private mergeHybrid(input: {
    lexical: SearchResult[];
    semantic: SearchResult[];
    limit: number;
  }): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const result of [...input.lexical, ...input.semantic]) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) {
        byId.set(result.id, result);
      }
    }
    return [...byId.values()].sort((a, b) => this.sortSearchResults(a, b)).slice(0, input.limit);
  }

  private sortSearchResults(a: SearchResult, b: SearchResult): number {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  }
}

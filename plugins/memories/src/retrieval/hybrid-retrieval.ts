import picomatch from 'picomatch';

import { DEFAULT_LEXICAL_K, DEFAULT_SEMANTIC_K } from '../shared/constants.js';
import { normalizePathForMatch } from '../shared/fs-utils.js';
import type { MemoryType, SearchResult } from '../shared/types.js';
import type { MemoryStore } from '../storage/database.js';
import type { EmbeddingClient } from './embeddings.js';

const RRF_RANK_CONSTANT = 60;

interface MatcherSpecificity {
  hasDoubleStar: boolean;
  literalSegmentCount: number;
  matcherLength: number;
  scopeRank: number;
  wildcardSegmentCount: number;
}

interface RankedPathMatch {
  effectRank: number;
  memory: SearchResult;
  specificity: MatcherSpecificity;
}

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
    const bestMatchSpecificityByMemoryId = new Map<string, MatcherSpecificity>();
    for (const matcher of matchers) {
      const matcherFn = picomatch(matcher.path_matcher, { dot: true });
      const isMatch = normalizedPaths.some((targetPath) => matcherFn(targetPath));
      if (!isMatch) {
        continue;
      }
      const specificity = this.computeMatcherSpecificity(matcher.path_matcher);
      const current = bestMatchSpecificityByMemoryId.get(matcher.memory_id);
      if (!current || this.sortByMatcherSpecificity(specificity, current) < 0) {
        bestMatchSpecificityByMemoryId.set(matcher.memory_id, specificity);
      }
    }

    const ids = [...bestMatchSpecificityByMemoryId.keys()];
    if (ids.length === 0) {
      return [];
    }

    const rankedPathMatches: RankedPathMatch[] = this.store
      .getMemoriesByIds(ids)
      .filter((memory) => (memoryTypes ? memoryTypes.includes(memory.memory_type) : true))
      .filter((memory) => (includePinned ? true : !memory.is_pinned))
      .flatMap((memory) => {
        const specificity = bestMatchSpecificityByMemoryId.get(memory.id);
        if (!specificity) {
          return [];
        }
        return [
          {
            effectRank: this.classifyPolicyEffect(memory),
            memory,
            specificity,
          },
        ];
      });

    rankedPathMatches.sort((a, b) => this.sortPathMatches(a, b));
    return rankedPathMatches.map((entry, index) => ({
      ...entry.memory,
      score: 1 / (index + 1),
    }));
  }

  private mergeHybrid(input: {
    lexical: SearchResult[];
    semantic: SearchResult[];
    limit: number;
  }): SearchResult[] {
    const byId = new Map<
      string,
      {
        bestRank: number;
        representative: SearchResult;
        rrfScore: number;
      }
    >();

    const addRankedList = (results: SearchResult[]): void => {
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (!result) {
          continue;
        }
        const rank = index + 1;
        const contribution = 1 / (RRF_RANK_CONSTANT + rank);
        const current = byId.get(result.id);
        if (!current) {
          byId.set(result.id, {
            bestRank: rank,
            representative: result,
            rrfScore: contribution,
          });
          continue;
        }
        current.rrfScore += contribution;
        if (rank < current.bestRank) {
          current.bestRank = rank;
          current.representative = result;
        }
      }
    };

    addRankedList(input.lexical);
    addRankedList(input.semantic);

    return [...byId.values()]
      .map((entry) => ({
        ...entry.representative,
        score: entry.rrfScore,
      }))
      .sort((a, b) => this.sortSearchResults(a, b))
      .slice(0, input.limit);
  }

  private sortSearchResults(a: SearchResult, b: SearchResult): number {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  }

  private sortPathMatches(a: RankedPathMatch, b: RankedPathMatch): number {
    if (a.effectRank !== b.effectRank) {
      return b.effectRank - a.effectRank;
    }
    const specificityOrder = this.sortByMatcherSpecificity(a.specificity, b.specificity);
    if (specificityOrder !== 0) {
      return specificityOrder;
    }
    if (a.memory.is_pinned !== b.memory.is_pinned) {
      return a.memory.is_pinned ? -1 : 1;
    }
    return Date.parse(b.memory.updated_at) - Date.parse(a.memory.updated_at);
  }

  private sortByMatcherSpecificity(a: MatcherSpecificity, b: MatcherSpecificity): number {
    if (a.scopeRank !== b.scopeRank) {
      return b.scopeRank - a.scopeRank;
    }
    if (a.literalSegmentCount !== b.literalSegmentCount) {
      return b.literalSegmentCount - a.literalSegmentCount;
    }
    if (a.wildcardSegmentCount !== b.wildcardSegmentCount) {
      return a.wildcardSegmentCount - b.wildcardSegmentCount;
    }
    if (a.hasDoubleStar !== b.hasDoubleStar) {
      return a.hasDoubleStar ? 1 : -1;
    }
    if (a.matcherLength !== b.matcherLength) {
      return b.matcherLength - a.matcherLength;
    }
    return 0;
  }

  private computeMatcherSpecificity(pattern: string): MatcherSpecificity {
    const normalized = normalizePathForMatch(pattern);
    const segments = normalized.split('/').filter(Boolean);
    const hasDoubleStar = normalized.includes('**');
    const wildcardSegmentCount = segments.reduce((count, segment) => {
      return this.hasGlobChars(segment) ? count + 1 : count;
    }, 0);
    const literalSegmentCount = segments.length - wildcardSegmentCount;
    const hasGlob = this.hasGlobChars(normalized);
    const isLiteral = !hasGlob;
    const scopeRank = isLiteral ? (this.looksFileLikePath(normalized) ? 4 : 3) : hasDoubleStar ? 1 : 2;

    return {
      hasDoubleStar,
      literalSegmentCount,
      matcherLength: normalized.length,
      scopeRank,
      wildcardSegmentCount,
    };
  }

  private classifyPolicyEffect(memory: SearchResult): number {
    if (memory.memory_type !== 'rule') {
      return 0;
    }
    const text = `${memory.content} ${memory.tags.join(' ')}`.toLowerCase();
    const hasNegativeInstruction =
      /\b(do not|don't|never|must not|forbidden|prohibit|cannot|can't)\b/.test(text);
    const hasEditVerb = /\b(edit|modify|change|touch|delete|remove|overwrite|write)\b/.test(text);
    if (hasNegativeInstruction && hasEditVerb) {
      return 3;
    }
    if (/\b(must|always|required|enforce|only|policy)\b/.test(text)) {
      return 2;
    }
    return 1;
  }

  private hasGlobChars(value: string): boolean {
    return /[*?[\]{}()]/.test(value);
  }

  private looksFileLikePath(value: string): boolean {
    const base = value.split('/').filter(Boolean).at(-1) ?? '';
    if (!base) {
      return false;
    }
    return base.includes('.') || base.startsWith('.');
  }
}

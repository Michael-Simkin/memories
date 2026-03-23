import picomatch from 'picomatch';

import { DEFAULT_LEXICAL_K, DEFAULT_SEMANTIC_K, MIN_SEMANTIC_SCORE } from '../shared/constants.js';
import { normalizePathForMatch } from '../shared/fs-utils.js';
import { applyTokenBudget } from '../shared/token-budget.js';
import type { MemoryType, SearchMatchSource, SearchResult } from '../shared/types.js';
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

interface QueryOptions {
  query: string;
  limit: number;
  targetPaths?: string[] | undefined;
  memoryTypes?: MemoryType[] | undefined;
  includePinned: boolean;
  semanticK?: number | undefined;
  lexicalK?: number | undefined;
  responseTokenBudget?: number | undefined;
}

interface RankedPathMatch {
  effectRank: number;
  memory: SearchResult;
  specificity: MatcherSpecificity;
}

interface EmbeddingRow {
  id: string;
  memory_type: MemoryType;
  content: string;
  tags: string[];
  is_pinned: boolean;
  updated_at: string;
  vector: number[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function normalizeRankScore(rawScore: number, maxScore: number): number {
  if (maxScore <= 0) {
    return 0;
  }
  return clamp01(rawScore / maxScore);
}

function orderMatchSources(values: Iterable<SearchMatchSource>): SearchMatchSource[] {
  const order: SearchMatchSource[] = ['path', 'lexical', 'semantic'];
  const set = new Set(values);
  return order.filter((value) => set.has(value));
}

export class RetrievalService {
  private readonly store: MemoryStore;
  private readonly embeddingClient: EmbeddingClient;

  public constructor(store: MemoryStore, embeddingClient: EmbeddingClient) {
    this.store = store;
    this.embeddingClient = embeddingClient;
  }

  public async search(repoId: string, options: QueryOptions): Promise<SearchResult[]> {
    const pathMatches = this.findPathMatches(
      repoId,
      options.targetPaths ?? [],
      options.memoryTypes,
      options.includePinned,
    );

    const lexical = this.store.lexicalSearch(repoId, {
      query: options.query,
      limit: options.lexicalK ?? DEFAULT_LEXICAL_K,
      includePinned: options.includePinned,
      ...(options.memoryTypes ? { memoryTypes: options.memoryTypes } : {}),
    });
    const semantic = await this.semanticSearch(repoId, {
      query: options.query,
      semanticK: options.semanticK ?? DEFAULT_SEMANTIC_K,
      includePinned: options.includePinned,
      ...(options.memoryTypes ? { memoryTypes: options.memoryTypes } : {}),
    });
    const hybrid = this.mergeHybrid({
      lexical,
      semantic,
      limit: options.limit,
    });

    const merged: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const result of pathMatches) {
      if (seenIds.has(result.id)) {
        continue;
      }
      merged.push(result);
      seenIds.add(result.id);
      if (merged.length >= options.limit) {
        return merged;
      }
    }

    for (const result of hybrid) {
      if (seenIds.has(result.id)) {
        continue;
      }
      merged.push(result);
      seenIds.add(result.id);
      if (merged.length >= options.limit) {
        break;
      }
    }

    const budgeted =
      typeof options.responseTokenBudget === 'number' && options.responseTokenBudget > 0
        ? applyTokenBudget(merged, options.responseTokenBudget)
        : merged;
    return budgeted.slice(0, options.limit);
  }

  private async semanticSearch(repoId: string, input: {
    query: string;
    semanticK: number;
    memoryTypes?: MemoryType[] | undefined;
    includePinned: boolean;
  }): Promise<SearchResult[]> {
    if (!this.embeddingClient.isConfigured() || !input.query.trim()) {
      return [];
    }

    const queryVector = await this.embeddingClient.embed(input.query);
    if (!queryVector) {
      return [];
    }

    const rows = this.store.listEmbeddings(repoId, input.memoryTypes, input.includePinned) as EmbeddingRow[];
    return rows
      .filter((row) => row.vector.length === queryVector.length)
      .map((row) => {
        const cosine = cosineSimilarity(queryVector, row.vector);
        const normalizedScore = (cosine + 1) / 2;
        const memory = this.store.getMemory(repoId, row.id);
        const pathMatchers = memory?.path_matchers.map((value) => value.path_matcher) ?? [];

        return {
          id: row.id,
          memory_type: row.memory_type,
          content: row.content,
          tags: row.tags,
          is_pinned: row.is_pinned,
          path_matchers: pathMatchers,
          score: normalizedScore,
          matched_by: ['semantic'] as SearchMatchSource[],
          semantic_score: normalizedScore,
          source: 'hybrid' as const,
          updated_at: row.updated_at,
        };
      })
      .filter((row) => row.score >= MIN_SEMANTIC_SCORE)
      .sort((left, right) => this.sortSearchResults(left, right))
      .slice(0, input.semanticK);
  }

  private findPathMatches(
    repoId: string,
    targetPaths: string[],
    memoryTypes: MemoryType[] | undefined,
    includePinned: boolean,
  ): SearchResult[] {
    const normalizedTargets = targetPaths
      .map((value) => normalizePathForMatch(value))
      .filter(Boolean);
    if (normalizedTargets.length === 0) {
      return [];
    }

    const bestMatchByMemoryId = new Map<string, MatcherSpecificity>();
    for (const matcher of this.store.listPathMatchers(repoId)) {
      if (!this.matchesAnyTarget(matcher.path_matcher, normalizedTargets)) {
        continue;
      }
      const specificity = this.computeMatcherSpecificity(matcher.path_matcher);
      const existing = bestMatchByMemoryId.get(matcher.memory_id);
      if (!existing || this.sortByMatcherSpecificity(specificity, existing) < 0) {
        bestMatchByMemoryId.set(matcher.memory_id, specificity);
      }
    }

    const memoryIds = [...bestMatchByMemoryId.keys()];
    if (memoryIds.length === 0) {
      return [];
    }

    const ranked = this.store
      .getMemoriesByIds(repoId, memoryIds)
      .filter((memory) => (memoryTypes ? memoryTypes.includes(memory.memory_type) : true))
      .filter((memory) => (includePinned ? true : !memory.is_pinned))
      .flatMap((memory) => {
        const specificity = bestMatchByMemoryId.get(memory.id);
        if (!specificity) {
          return [];
        }
        return [
          {
            memory,
            specificity,
            effectRank: this.classifyPolicyEffect(memory),
          },
        ];
      });

    ranked.sort((left, right) => this.sortPathMatches(left, right));

    return ranked.map((entry, index) => {
      const pathScore = 1 / (index + 1);
      return {
        ...entry.memory,
        source: 'path',
        score: pathScore,
        matched_by: ['path'] as SearchMatchSource[],
        path_score: pathScore,
      };
    });
  }

  private matchesAnyTarget(pathMatcher: string, targets: string[]): boolean {
    try {
      const matcher = picomatch(pathMatcher, { dot: true });
      return targets.some((target) => matcher(target));
    } catch {
      return false;
    }
  }

  private mergeHybrid(input: {
    lexical: SearchResult[];
    semantic: SearchResult[];
    limit: number;
  }): SearchResult[] {
    const byMemoryId = new Map<
      string,
      {
        bestRank: number;
        representative: SearchResult;
        rrfScore: number;
        matchedBy: Set<SearchMatchSource>;
        lexicalScore?: number | undefined;
        semanticScore?: number | undefined;
      }
    >();

    const addRankedBranch = (branch: SearchResult[], branchName: 'lexical' | 'semantic'): void => {
      for (let index = 0; index < branch.length; index += 1) {
        const result = branch[index];
        if (!result) {
          continue;
        }

        const rank = index + 1;
        const contribution = 1 / (RRF_RANK_CONSTANT + rank);
        const current = byMemoryId.get(result.id);

        if (!current) {
          byMemoryId.set(result.id, {
            representative: result,
            bestRank: rank,
            rrfScore: contribution,
            matchedBy: new Set<SearchMatchSource>([branchName]),
            lexicalScore: branchName === 'lexical' ? result.lexical_score ?? result.score : undefined,
            semanticScore: branchName === 'semantic' ? result.semantic_score ?? result.score : undefined,
          });
          continue;
        }

        current.rrfScore += contribution;
        current.matchedBy.add(branchName);
        if (branchName === 'lexical') {
          current.lexicalScore = result.lexical_score ?? result.score;
        } else {
          current.semanticScore = result.semantic_score ?? result.score;
        }
        if (rank < current.bestRank) {
          current.bestRank = rank;
          current.representative = result;
        }
      }
    };

    addRankedBranch(input.lexical, 'lexical');
    addRankedBranch(input.semantic, 'semantic');

    const mergedValues = [...byMemoryId.values()];
    const maxRrfScore = mergedValues.reduce((best, entry) => {
      return Math.max(best, entry.rrfScore);
    }, 0);

    return mergedValues
      .map((entry) => ({
        ...entry.representative,
        score: normalizeRankScore(entry.rrfScore, maxRrfScore),
        matched_by: orderMatchSources(entry.matchedBy),
        ...(typeof entry.lexicalScore === 'number' ? { lexical_score: entry.lexicalScore } : {}),
        ...(typeof entry.semanticScore === 'number' ? { semantic_score: entry.semanticScore } : {}),
        rrf_score: entry.rrfScore,
        source: 'hybrid' as const,
      }))
      .sort((left, right) => this.sortSearchResults(left, right))
      .slice(0, input.limit);
  }

  private sortSearchResults(left: SearchResult, right: SearchResult): number {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const timeOrder = right.updated_at.localeCompare(left.updated_at);
    if (timeOrder !== 0) {
      return timeOrder;
    }
    return left.id.localeCompare(right.id);
  }

  private sortPathMatches(left: RankedPathMatch, right: RankedPathMatch): number {
    if (left.effectRank !== right.effectRank) {
      return right.effectRank - left.effectRank;
    }

    const specificityOrder = this.sortByMatcherSpecificity(left.specificity, right.specificity);
    if (specificityOrder !== 0) {
      return specificityOrder;
    }

    if (left.memory.is_pinned !== right.memory.is_pinned) {
      return left.memory.is_pinned ? -1 : 1;
    }

    const timeOrder = right.memory.updated_at.localeCompare(left.memory.updated_at);
    if (timeOrder !== 0) {
      return timeOrder;
    }
    return left.memory.id.localeCompare(right.memory.id);
  }

  private sortByMatcherSpecificity(left: MatcherSpecificity, right: MatcherSpecificity): number {
    if (left.scopeRank !== right.scopeRank) {
      return right.scopeRank - left.scopeRank;
    }
    if (left.literalSegmentCount !== right.literalSegmentCount) {
      return right.literalSegmentCount - left.literalSegmentCount;
    }
    if (left.wildcardSegmentCount !== right.wildcardSegmentCount) {
      return left.wildcardSegmentCount - right.wildcardSegmentCount;
    }
    if (left.hasDoubleStar !== right.hasDoubleStar) {
      return left.hasDoubleStar ? 1 : -1;
    }
    return right.matcherLength - left.matcherLength;
  }

  private computeMatcherSpecificity(pathMatcher: string): MatcherSpecificity {
    const normalized = normalizePathForMatch(pathMatcher);
    const segments = normalized.split('/').filter(Boolean);
    const hasDoubleStar = normalized.includes('**');
    const wildcardSegmentCount = segments.reduce((count, segment) => {
      return this.hasGlobChars(segment) ? count + 1 : count;
    }, 0);
    const literalSegmentCount = segments.length - wildcardSegmentCount;
    const hasGlob = this.hasGlobChars(normalized);

    let scopeRank = 1;
    if (!hasGlob) {
      scopeRank = this.looksFileLikePath(normalized) ? 4 : 3;
    } else if (!hasDoubleStar) {
      scopeRank = 2;
    }

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
    if (/\b(do not|don't|never|must not|forbidden|deny|prohibit|cannot|can't)\b/.test(text)) {
      return 4;
    }
    if (/\b(must|always|required|enforce|only)\b/.test(text)) {
      return 3;
    }
    if (/\b(prefer|should|recommended|ideally)\b/.test(text)) {
      return 2;
    }
    return 1;
  }

  private hasGlobChars(value: string): boolean {
    return /[*?[\]{}()]/.test(value);
  }

  private looksFileLikePath(value: string): boolean {
    const lastSegment = value.split('/').filter(Boolean).at(-1) ?? '';
    return Boolean(lastSegment) && (lastSegment.includes('.') || lastSegment.startsWith('.'));
  }
}

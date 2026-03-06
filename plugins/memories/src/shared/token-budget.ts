import type { SearchResult } from './types.js';

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateSearchResultTokens(result: SearchResult): number {
  return estimateTextTokens(
    `${result.content} ${result.tags.join(' ')} ${result.path_matchers.join(' ')}`,
  );
}

export function applyTokenBudget(results: SearchResult[], maxTokens: number): SearchResult[] {
  const selected: SearchResult[] = [];
  let consumed = 0;

  for (const result of results) {
    const cost = estimateSearchResultTokens(result);
    if (selected.length > 0 && consumed + cost > maxTokens) {
      break;
    }
    selected.push(result);
    consumed += cost;
  }

  return selected;
}

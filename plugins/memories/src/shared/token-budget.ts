import type { SearchResult } from './types.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function applyTokenBudget(results: SearchResult[], maxTokens: number): SearchResult[] {
  const selected: SearchResult[] = [];
  let used = 0;
  for (const result of results) {
    const cost = estimateTokens(`${result.content} ${result.tags.join(' ')}`);
    if (selected.length > 0 && used + cost > maxTokens) {
      break;
    }
    selected.push(result);
    used += cost;
  }
  return selected;
}

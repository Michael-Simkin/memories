import type { SearchResult } from './types.js';

const MEMORY_SECTION_ORDER = ['fact', 'rule', 'decision', 'episode'] as const;

function sectionTitle(memoryType: (typeof MEMORY_SECTION_ORDER)[number]): string {
  switch (memoryType) {
    case 'fact':
      return 'Facts';
    case 'rule':
      return 'Rules';
    case 'decision':
      return 'Decisions';
    case 'episode':
      return 'Episodes';
  }
}

function formatResultLine(result: SearchResult): string[] {
  const tags = result.tags.length > 0 ? result.tags.join(', ') : 'none';
  const matchers = result.path_matchers.length > 0 ? result.path_matchers.join(', ') : 'none';

  return [
    `- ${result.content}`,
    `  - id: ${result.id}; source: ${result.source}; score: ${result.score.toFixed(4)}; pinned: ${result.is_pinned}; tags: ${tags}; matchers: ${matchers}; updated_at: ${result.updated_at}`,
  ];
}

export function formatMemoryRecallMarkdown(input: {
  query: string;
  results: SearchResult[];
  durationMs: number;
  source: string;
}): string {
  const deduped = dedupeByMemoryId(input.results);
  const grouped = groupByMemoryType(deduped);

  const lines: string[] = [
    '# Memory Recall',
    `- Query: ${input.query}`,
    `- Returned: ${deduped.length}`,
    `- Duration: ${input.durationMs}ms`,
    `- Source: ${input.source}`,
    '',
  ];

  for (const memoryType of MEMORY_SECTION_ORDER) {
    lines.push(`## ${sectionTitle(memoryType)}`);
    const values = grouped.get(memoryType) ?? [];
    if (values.length === 0) {
      lines.push('- None');
    } else {
      for (const value of values) {
        lines.push(...formatResultLine(value));
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function dedupeByMemoryId(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    if (seen.has(result.id)) {
      continue;
    }
    seen.add(result.id);
    deduped.push(result);
  }
  return deduped;
}

function groupByMemoryType(
  results: SearchResult[],
): Map<(typeof MEMORY_SECTION_ORDER)[number], SearchResult[]> {
  const grouped = new Map<(typeof MEMORY_SECTION_ORDER)[number], SearchResult[]>(
    MEMORY_SECTION_ORDER.map((memoryType) => [memoryType, [] as SearchResult[]]),
  );

  for (const result of results) {
    grouped.get(result.memory_type)?.push(result);
  }
  return grouped;
}

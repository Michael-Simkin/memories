import type { SearchResult } from './types.js';

const ORDER = ['fact', 'rule', 'decision', 'episode'] as const;

function sectionTitle(type: (typeof ORDER)[number]): string {
  switch (type) {
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

function renderItem(result: SearchResult): string {
  const tags = result.tags.length > 0 ? result.tags.join(', ') : 'none';
  return [
    `- ${result.content}`,
    `  - id: ${result.id}; score: ${result.score.toFixed(4)}; pinned: ${result.is_pinned}; updated_at: ${result.updated_at}; tags: ${tags}`,
  ].join('\n');
}

export function formatMemoryRecallMarkdown(input: {
  query: string;
  results: SearchResult[];
  durationMs: number;
  source: string;
}): string {
  const seen = new Set<string>();
  const deduped = input.results.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });

  const grouped = new Map<(typeof ORDER)[number], SearchResult[]>(
    ORDER.map((type) => [type, [] as SearchResult[]]),
  );
  for (const result of deduped) {
    grouped.get(result.memory_type)?.push(result);
  }

  const lines: string[] = [
    '# Memory Recall',
    `- Query: ${input.query}`,
    `- Returned: ${deduped.length}`,
    `- Duration: ${input.durationMs}ms`,
    `- Source: ${input.source}`,
    '',
  ];

  for (const type of ORDER) {
    lines.push(`## ${sectionTitle(type)}`);
    const values = grouped.get(type) ?? [];
    if (values.length === 0) {
      lines.push('- None');
    } else {
      for (const value of values) {
        lines.push(renderItem(value));
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

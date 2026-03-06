import type {
  BackgroundHooksResponse,
  EventLog,
  Memory,
  MemorySearchResult,
  MemoryType,
  StatsResponse,
} from './types.js';

const MAX_SEARCH_LIMIT = 50;

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${response.statusText} ${text}`);
  }
  return (await response.json()) as T;
}

export async function fetchStats(): Promise<StatsResponse> {
  return parseJson<StatsResponse>(await fetch('/stats'));
}

export async function fetchBackgroundHooks(): Promise<BackgroundHooksResponse> {
  return parseJson<BackgroundHooksResponse>(await fetch('/background-hooks'));
}

export async function fetchMemories(): Promise<{ items: Memory[]; total: number }> {
  return parseJson<{ items: Memory[]; total: number }>(await fetch('/memories?limit=200&offset=0'));
}

export async function searchMemories(
  query: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<MemorySearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, options?.limit ?? 30));
  const response = await fetch('/memories/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(options?.signal ? { signal: options.signal } : {}),
    body: JSON.stringify({
      query: normalizedQuery,
      limit,
      include_pinned: true,
    }),
  });
  const payload = await parseJson<{ results: MemorySearchResult[] }>(response);
  return payload.results;
}

export async function createMemory(payload: {
  memory_type: MemoryType;
  content: string;
  tags: string[];
  is_pinned: boolean;
  path_matchers: Array<{ path_matcher: string }>;
}): Promise<Memory> {
  const response = await fetch('/memories/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ memory: Memory }>(response);
  return data.memory;
}

export async function updateMemory(payload: {
  id: string;
  content: string;
  tags: string[];
  is_pinned: boolean;
  path_matchers: Array<{ path_matcher: string }>;
}): Promise<Memory> {
  const response = await fetch(`/memories/${payload.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: payload.content,
      tags: payload.tags,
      is_pinned: payload.is_pinned,
      path_matchers: payload.path_matchers,
    }),
  });
  const data = await parseJson<{ memory: Memory }>(response);
  return data.memory;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  await parseJson<{ deleted: boolean; id: string }>(
    await fetch(`/memories/${memoryId}`, { method: 'DELETE' }),
  );
}

export async function fetchLogs(limit = 300): Promise<EventLog[]> {
  const payload = await parseJson<{ items: EventLog[] }>(
    await fetch(`/logs?limit=${limit}&order=desc`),
  );
  return payload.items;
}

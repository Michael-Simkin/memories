import type { Memory, MemorySearchResult, MemoryType, StatsResponse } from './types';

const MAX_SEARCH_LIMIT = 50;

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${response.statusText} ${text}`);
  }
  return (await response.json()) as T;
}

export async function fetchStats(): Promise<StatsResponse> {
  const response = await fetch('/stats');
  return parseJson<StatsResponse>(response);
}

export async function fetchMemories(): Promise<{ items: Memory[]; total: number }> {
  const response = await fetch('/memories?limit=200&offset=0');
  return parseJson<{ items: Memory[]; total: number }>(response);
}

export async function searchMemories(
  query: string,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<MemorySearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const requestedLimit = options?.limit ?? 30;
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, requestedLimit));

  const response = await fetch('/memories/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
}): Promise<void> {
  const response = await fetch('/memories/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await parseJson<{ memory: Memory }>(response);
}

export async function updateMemory(
  memoryId: string,
  payload: {
    content: string;
    tags: string[];
    is_pinned: boolean;
    path_matchers: Array<{ path_matcher: string }>;
  },
): Promise<void> {
  const response = await fetch(`/memories/${memoryId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await parseJson<{ memory: Memory }>(response);
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const response = await fetch(`/memories/${memoryId}`, {
    method: 'DELETE',
  });
  await parseJson<{ deleted: boolean; id: string }>(response);
}

export async function fetchHookLogs(): Promise<Record<string, unknown>[]> {
  const response = await fetch('/logs/hooks?limit=300');
  const payload = await parseJson<{ items: Record<string, unknown>[] }>(response);
  return payload.items;
}

export async function fetchOperationLogs(): Promise<Record<string, unknown>[]> {
  const response = await fetch('/logs/operations?limit=300');
  const payload = await parseJson<{ items: Record<string, unknown>[] }>(response);
  return payload.items;
}

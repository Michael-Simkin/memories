import type {
  BackfillState,
  BackgroundHooksResponse,
  EventLog,
  ExtractionStatusResponse,
  Memory,
  MemorySearchResult,
  MemoryType,
  RepoInfo,
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

export async function fetchExtractionStatus(): Promise<ExtractionStatusResponse> {
  return parseJson<ExtractionStatusResponse>(await fetch('/extraction/status'));
}

export async function fetchBackgroundHooks(): Promise<BackgroundHooksResponse> {
  return parseJson<BackgroundHooksResponse>(await fetch('/background-hooks'));
}

export async function fetchRepos(): Promise<RepoInfo[]> {
  const payload = await parseJson<{ repos: RepoInfo[] }>(await fetch('/repos'));
  return payload.repos;
}

export async function fetchMemories(repoId: string): Promise<{ items: Memory[]; total: number }> {
  return parseJson<{ items: Memory[]; total: number }>(
    await fetch(`/memories?repo_id=${encodeURIComponent(repoId)}&limit=200&offset=0`),
  );
}

export async function searchMemories(
  repoId: string,
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
      repo_id: repoId,
      query: normalizedQuery,
      limit,
      include_pinned: true,
    }),
  });
  const payload = await parseJson<{ results: MemorySearchResult[] }>(response);
  return payload.results;
}

export async function createMemory(repoId: string, payload: {
  memory_type: MemoryType;
  content: string;
  tags: string[];
  is_pinned: boolean;
  path_matchers: Array<{ path_matcher: string }>;
}): Promise<Memory> {
  const response = await fetch('/memories/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, repo_id: repoId }),
  });
  const data = await parseJson<{ memory: Memory }>(response);
  return data.memory;
}

export async function updateMemory(repoId: string, payload: {
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
      repo_id: repoId,
      content: payload.content,
      tags: payload.tags,
      is_pinned: payload.is_pinned,
      path_matchers: payload.path_matchers,
    }),
  });
  const data = await parseJson<{ memory: Memory }>(response);
  return data.memory;
}

export async function deleteMemory(repoId: string, memoryId: string): Promise<void> {
  await parseJson<{ deleted: boolean; id: string }>(
    await fetch(`/memories/${memoryId}?repo_id=${encodeURIComponent(repoId)}`, { method: 'DELETE' }),
  );
}

export async function shutdownEngine(): Promise<void> {
  await parseJson<{ status: string }>(
    await fetch('/shutdown', { method: 'POST' }),
  );
}

export async function startBackfill(repoId: string): Promise<void> {
  await parseJson<{ status: string }>(
    await fetch('/backfill/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo_id: repoId }),
    }),
  );
}

export async function fetchBackfillStatus(): Promise<BackfillState> {
  return parseJson<BackfillState>(await fetch('/backfill/status'));
}

export async function cancelBackfill(): Promise<void> {
  await parseJson<{ status: string }>(
    await fetch('/backfill/cancel', { method: 'POST' }),
  );
}

export async function fetchLogs(limit = 300): Promise<EventLog[]> {
  const payload = await parseJson<{ items: EventLog[] }>(
    await fetch(`/logs?limit=${limit}&order=desc`),
  );
  return payload.items;
}

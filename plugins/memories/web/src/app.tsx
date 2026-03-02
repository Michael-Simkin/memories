import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

import {
  createMemory,
  deleteMemory,
  fetchHookLogs,
  fetchMemories,
  fetchOperationLogs,
  fetchStats,
  searchMemories,
  updateMemory,
} from './api';
import type { Memory, MemorySearchResult, MemoryType, PathMatcher } from './types';

type Tab = 'memories' | 'logs';
const MIN_SEARCH_QUERY_LENGTH = 2;
const SEARCH_RESULT_LIMIT = 30;

interface MemoryDraft {
  content: string;
  is_pinned: boolean;
  memory_type: MemoryType;
  path_matchers: string;
  tags: string;
}

interface DisplayMemory {
  id: string;
  memory_type: MemoryType;
  content: string;
  tags: string[];
  is_pinned: boolean;
  updated_at: string;
  score?: number;
}

function toDraft(memory?: Memory): MemoryDraft {
  return {
    content: memory?.content ?? '',
    is_pinned: memory?.is_pinned ?? false,
    memory_type: memory?.memory_type ?? 'fact',
    path_matchers:
      memory?.path_matchers
        .map((matcher) => `${matcher.path_matcher}:${matcher.priority}`)
        .join('\n') ?? '',
    tags: memory?.tags.join(', ') ?? '',
  };
}

function parseMatchers(input: string): Array<{ path_matcher: string; priority: number }> {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [matcher, priorityRaw] = line.split(':');
      const priority = Number.parseInt(priorityRaw ?? '100', 10);
      return {
        path_matcher: (matcher ?? '').trim(),
        priority: Number.isInteger(priority) ? priority : 100,
      };
    })
    .filter((value) => value.path_matcher.length > 0);
}

function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatPathMatchers(pathMatchers: PathMatcher[]): string {
  if (pathMatchers.length === 0) {
    return 'none';
  }
  return pathMatchers.map((matcher) => `${matcher.path_matcher} (p${matcher.priority})`).join(', ');
}

function toDisplayMemory(memory: Memory): DisplayMemory {
  return {
    id: memory.id,
    memory_type: memory.memory_type,
    content: memory.content,
    tags: memory.tags,
    is_pinned: memory.is_pinned,
    updated_at: memory.updated_at,
  };
}

function toDisplayMemoryFromSearchResult(memory: MemorySearchResult): DisplayMemory {
  return {
    id: memory.id,
    memory_type: memory.memory_type,
    content: memory.content,
    tags: memory.tags,
    is_pinned: memory.is_pinned,
    updated_at: memory.updated_at,
    score: memory.score,
  };
}

interface MemoryModalProps {
  draft: MemoryDraft;
  mode: 'create' | 'edit';
  onClose: () => void;
  onSave: (next: MemoryDraft) => Promise<void>;
}

function MemoryModal(props: MemoryModalProps) {
  const [draft, setDraft] = useState<MemoryDraft>(props.draft);
  const [isSaving, setIsSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorText(null);
    setIsSaving(true);
    try {
      await props.onSave(draft);
      props.onClose();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={props.onClose}>
      <div className="modal-content" role="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>{props.mode === 'create' ? 'Create Memory' : 'Edit Memory'}</h3>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label>
            Type
            <select
              value={draft.memory_type}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  memory_type: event.currentTarget.value as MemoryType,
                }))
              }
            >
              <option value="fact">fact</option>
              <option value="rule">rule</option>
              <option value="decision">decision</option>
              <option value="episode">episode</option>
            </select>
          </label>
          <label>
            Content
            <textarea
              rows={4}
              required
              value={draft.content}
              onChange={(event) =>
                setDraft((current) => ({ ...current, content: event.currentTarget.value }))
              }
            />
          </label>
          <label>
            Tags (comma separated)
            <input
              type="text"
              value={draft.tags}
              onChange={(event) =>
                setDraft((current) => ({ ...current, tags: event.currentTarget.value }))
              }
            />
          </label>
          <label>
            Path matchers (`glob:priority`, one per line)
            <textarea
              rows={3}
              value={draft.path_matchers}
              onChange={(event) =>
                setDraft((current) => ({ ...current, path_matchers: event.currentTarget.value }))
              }
            />
          </label>
          <label className="pin-toggle-row">
            <span className="pin-toggle-text">Pinned (inject on SessionStart)</span>
            <span className="pin-toggle-control">
              <input
                type="checkbox"
                className="pin-toggle-input"
                checked={draft.is_pinned}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, is_pinned: event.currentTarget.checked }))
                }
              />
              <span className="pin-toggle-slider" aria-hidden="true" />
            </span>
          </label>
          {errorText ? <p className="error-text">{errorText}</p> : null}
          <div className="modal-actions">
            <button type="button" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" disabled={isSaving}>
              {isSaving ? 'Saving…' : props.mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type LogRecord = Record<string, unknown> & {
  at?: string;
  data?: Record<string, unknown>;
  detail?: string;
  memory_id?: string;
  op?: string;
  session_id?: string;
  source?: 'hook' | 'operation';
  status?: string;
  event?: string;
};

type LogSource = 'hook' | 'operation';
type LogStatus = 'ok' | 'error' | 'skipped' | 'unknown';

interface LogEntry {
  id: string;
  source: LogSource;
  status: LogStatus;
  name: string;
  timestampLabel: string;
  timestampMs: number;
  detail?: string;
  sessionId?: string;
  memoryId?: string;
  data?: Record<string, unknown>;
}

function toLogStatus(value: unknown): LogStatus {
  if (value === 'ok' || value === 'error' || value === 'skipped') {
    return value;
  }
  return 'unknown';
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length > 0 ? record : undefined;
}

function buildLogEntry(raw: LogRecord, source: LogSource, index: number): LogEntry {
  const at = toOptionalString(raw.at);
  const timestampMs = at ? Date.parse(at) : Number.NaN;
  const detail = toOptionalString(raw.detail);
  const sessionId = toOptionalString(raw.session_id);
  const memoryId = toOptionalString(raw.memory_id);
  const status = toLogStatus(raw.status);
  const data = toOptionalRecord(raw.data);

  const name =
    source === 'hook'
      ? (toOptionalString(raw.event) ?? 'hook-event')
      : (toOptionalString(raw.op) ?? 'operation');

  const timestampLabel =
    Number.isFinite(timestampMs) && at ? new Date(timestampMs).toLocaleString() : 'Unknown time';

  return {
    id: `${source}-${at ?? 'na'}-${index}-${name}`,
    source,
    status,
    name,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
    timestampLabel,
    ...(detail ? { detail } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(memoryId ? { memoryId } : {}),
    ...(data ? { data } : {}),
  };
}

export function App() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('memories');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 320);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [searchInput]);

  const statsQuery = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    refetchInterval: 2000,
  });
  const memoriesQuery = useQuery({
    queryKey: ['memories'],
    queryFn: fetchMemories,
    refetchInterval: 3000,
  });
  const memoriesSearchQuery = useQuery({
    queryKey: ['memories', 'search', searchQuery],
    queryFn: ({ signal }) => searchMemories(searchQuery, { limit: SEARCH_RESULT_LIMIT, signal }),
    enabled: activeTab === 'memories' && searchQuery.length >= MIN_SEARCH_QUERY_LENGTH,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 15000,
  });
  const hookLogsQuery = useQuery({
    queryKey: ['logs', 'hooks'],
    queryFn: fetchHookLogs,
    enabled: activeTab === 'logs',
    refetchInterval: activeTab === 'logs' ? 1000 : false,
  });
  const operationLogsQuery = useQuery({
    queryKey: ['logs', 'operations'],
    queryFn: fetchOperationLogs,
    enabled: activeTab === 'logs',
    refetchInterval: activeTab === 'logs' ? 1000 : false,
  });

  const createMutation = useMutation({
    mutationFn: createMemory,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memories'] });
      await queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof updateMemory>[1] }) =>
      updateMemory(id, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memories'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteMemory,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memories'] });
      await queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const mergedLogs = useMemo(() => {
    const withSource: LogEntry[] = [
      ...(hookLogsQuery.data ?? []).map((entry, index) =>
        buildLogEntry(entry as LogRecord, 'hook', index),
      ),
      ...(operationLogsQuery.data ?? []).map((entry, index) =>
        buildLogEntry(entry as LogRecord, 'operation', index),
      ),
    ];
    return withSource.sort((a, b) => {
      return b.timestampMs - a.timestampMs;
    });
  }, [hookLogsQuery.data, operationLogsQuery.data]);

  const memoryRows = useMemo<DisplayMemory[]>(() => {
    if (searchQuery.length >= MIN_SEARCH_QUERY_LENGTH) {
      return (memoriesSearchQuery.data ?? []).map((memory) =>
        toDisplayMemoryFromSearchResult(memory),
      );
    }
    return (memoriesQuery.data?.items ?? []).map((memory) => toDisplayMemory(memory));
  }, [searchQuery, memoriesSearchQuery.data, memoriesQuery.data?.items]);

  const memoryIndexById = useMemo(() => {
    return new Map((memoriesQuery.data?.items ?? []).map((memory) => [memory.id, memory]));
  }, [memoriesQuery.data?.items]);

  const isSearchActive = searchQuery.length >= MIN_SEARCH_QUERY_LENGTH;
  const hasSearchInput = searchInput.trim().length > 0;
  const memoriesLoading = isSearchActive ? memoriesSearchQuery.isLoading : memoriesQuery.isLoading;
  const memoriesError = isSearchActive ? memoriesSearchQuery.error : memoriesQuery.error;
  const memorySummaryText = isSearchActive
    ? `Showing ${memoryRows.length} result${memoryRows.length === 1 ? '' : 's'} for "${searchQuery}"`
    : hasSearchInput
      ? `Type at least ${MIN_SEARCH_QUERY_LENGTH} characters to search`
      : `Showing ${memoryRows.length} memories`;

  function openEditMemory(memory: DisplayMemory): void {
    const fullMemory = memoryIndexById.get(memory.id);
    if (fullMemory) {
      setEditing(fullMemory);
      return;
    }
    setEditing({
      id: memory.id,
      memory_type: memory.memory_type,
      content: memory.content,
      tags: memory.tags,
      is_pinned: memory.is_pinned,
      path_matchers: [],
      created_at: memory.updated_at,
      updated_at: memory.updated_at,
    });
  }

  return (
    <main>
      <header className="stats-bar">
        <span>Memories: {statsQuery.data?.memory_count ?? '—'}</span>
        <span>Sessions: {statsQuery.data?.active_sessions ?? '—'}</span>
        <span>Uptime: {statsQuery.data ? Math.floor(statsQuery.data.uptime_ms / 1000) : '—'}s</span>
        <span>Status: {statsQuery.data?.online ? 'online' : 'offline'}</span>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={activeTab === 'memories' ? 'active' : ''}
          onClick={() => setActiveTab('memories')}
        >
          Memories
        </button>
        <button
          type="button"
          className={activeTab === 'logs' ? 'active' : ''}
          onClick={() => setActiveTab('logs')}
        >
          Logs
        </button>
      </nav>

      {activeTab === 'memories' ? (
        <section>
          <div className="section-header">
            <h2>Memories</h2>
            <button type="button" onClick={() => setCreating(true)}>
              New Memory
            </button>
          </div>

          <div className="memory-toolbar">
            <div className="memory-search">
              <input
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.currentTarget.value)}
                placeholder="Search memories (semantic + lexical)"
              />
              {searchInput.length > 0 ? (
                <button type="button" onClick={() => setSearchInput('')}>
                  Clear
                </button>
              ) : null}
            </div>
            <small className="memory-summary">
              {memoriesSearchQuery.isFetching && isSearchActive ? 'Searching…' : memorySummaryText}
            </small>
          </div>

          {memoriesLoading ? <p>Loading…</p> : null}
          {memoriesError ? <p className="error-text">{String(memoriesError)}</p> : null}
          <ul className="memory-list">
            {memoryRows.map((memory) => (
              <li
                key={memory.id}
                className={`memory-card type-${memory.memory_type} ${memory.is_pinned ? 'is-pinned' : 'is-unpinned'}`}
              >
                <div className="memory-card-header">
                  <span className={`memory-pill type-${memory.memory_type}`}>
                    {memory.memory_type}
                  </span>
                  <span className={`memory-pill pin-${memory.is_pinned ? 'pinned' : 'unpinned'}`}>
                    {memory.is_pinned ? 'Pinned' : 'Not pinned'}
                  </span>
                  <span className="memory-updated">
                    Updated {new Date(memory.updated_at).toLocaleString()}
                  </span>
                </div>
                <p className="memory-content">{memory.content}</p>
                <p className="memory-tags">tags: {memory.tags.join(', ') || 'none'}</p>
                <p className="memory-path-matchers">
                  path matchers: {formatPathMatchers(memoryIndexById.get(memory.id)?.path_matchers ?? [])}
                </p>
                {isSearchActive && typeof memory.score === 'number' ? (
                  <p className="memory-score">match score: {memory.score.toFixed(3)}</p>
                ) : null}
                <div className="memory-actions">
                  <button type="button" onClick={() => openEditMemory(memory)}>
                    Edit
                  </button>
                  <button type="button" onClick={() => deleteMutation.mutate(memory.id)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section>
          <div className="section-header">
            <h2>Logs</h2>
            <small>Polling every 1s while this tab is active.</small>
          </div>
          <div className="logs-panel">
            {hookLogsQuery.isLoading || operationLogsQuery.isLoading ? <p>Loading logs…</p> : null}
            {hookLogsQuery.isError ? (
              <p className="error-text">Hook logs error: {String(hookLogsQuery.error)}</p>
            ) : null}
            {operationLogsQuery.isError ? (
              <p className="error-text">Operation logs error: {String(operationLogsQuery.error)}</p>
            ) : null}
            {mergedLogs.length === 0 ? (
              <p>No logs yet.</p>
            ) : (
              <ul className="log-list">
                {mergedLogs.map((log) => (
                  <li key={log.id} className="log-item">
                    <div className="log-item-header">
                      <span className={`log-badge source-${log.source}`}>{log.source}</span>
                      <strong>{log.name}</strong>
                      <span className={`log-badge status-${log.status}`}>{log.status}</span>
                      <span className="log-time">{log.timestampLabel}</span>
                    </div>
                    {log.detail ? <p className="log-detail">{log.detail}</p> : null}
                    {log.sessionId || log.memoryId ? (
                      <p className="log-meta">
                        {log.sessionId ? <span>session: {log.sessionId}</span> : null}
                        {log.memoryId ? <span>memory: {log.memoryId}</span> : null}
                      </p>
                    ) : null}
                    {log.data ? (
                      <pre className="log-data">{JSON.stringify(log.data, null, 2)}</pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {creating ? (
        <MemoryModal
          draft={toDraft()}
          mode="create"
          onClose={() => setCreating(false)}
          onSave={async (draft) => {
            await createMutation.mutateAsync({
              content: draft.content,
              is_pinned: draft.is_pinned,
              memory_type: draft.memory_type,
              path_matchers: parseMatchers(draft.path_matchers),
              tags: parseTags(draft.tags),
            });
          }}
        />
      ) : null}

      {editing ? (
        <MemoryModal
          draft={toDraft(editing)}
          mode="edit"
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            await updateMutation.mutateAsync({
              id: editing.id,
              payload: {
                content: draft.content,
                is_pinned: draft.is_pinned,
                path_matchers: parseMatchers(draft.path_matchers),
                tags: parseTags(draft.tags),
              },
            });
          }}
        />
      ) : null}
    </main>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

import {
  createMemory,
  deleteMemory,
  fetchBackgroundHooks,
  fetchLogs,
  fetchMemories,
  fetchRepos,
  fetchStats,
  searchMemories,
  updateMemory,
} from './api.js';
import type {
  BackgroundHook,
  EventLog,
  Memory,
  MemorySearchResult,
  MemoryType,
  SearchMatchSource,
} from './types.js';

type Tab = 'memories' | 'hooks' | 'logs';
const MIN_SEARCH_QUERY_LENGTH = 2;

interface MemoryDraft {
  content: string;
  is_pinned: boolean;
  memory_type: MemoryType;
  path_matchers: string;
  tags: string;
}

interface DisplayMemory {
  id: string;
  content: string;
  is_pinned: boolean;
  memory_type: MemoryType;
  path_matchers: string[];
  tags: string[];
  updated_at: string;
  score?: number;
  matched_by?: SearchMatchSource[];
  path_score?: number;
  lexical_score?: number;
  semantic_score?: number;
  rrf_score?: number;
}

function toDraft(memory?: DisplayMemory): MemoryDraft {
  return {
    content: memory?.content ?? '',
    is_pinned: memory?.is_pinned ?? false,
    memory_type: memory?.memory_type ?? 'fact',
    path_matchers: memory?.path_matchers.join('\n') ?? '',
    tags: memory?.tags.join(', ') ?? '',
  };
}

function parseMatchers(input: string): Array<{ path_matcher: string }> {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((pathMatcher) => ({ path_matcher: pathMatcher }));
}

function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function classifyPolicyEffect(memory: DisplayMemory): 'deny' | 'must' | 'preference' | 'context' {
  if (memory.memory_type !== 'rule') {
    return 'context';
  }
  const text = `${memory.content} ${memory.tags.join(' ')}`.toLowerCase();
  if (/\b(do not|don't|never|must not|forbidden|prohibit|cannot|can't)\b/.test(text)) {
    return 'deny';
  }
  if (/\b(must|always|required|enforce|only)\b/.test(text)) {
    return 'must';
  }
  if (/\b(prefer|should|recommended|ideally)\b/.test(text)) {
    return 'preference';
  }
  return 'context';
}

function classifyMatcherScope(pattern: string): 'exact-file' | 'exact-dir' | 'single-glob' | 'deep-glob' {
  const trimmed = pattern.trim();
  const hasDoubleStar = trimmed.includes('**');
  const hasGlobChars = /[*?[\]{}()]/.test(trimmed);
  if (!hasGlobChars) {
    const lastSegment = trimmed.split('/').filter(Boolean).at(-1) ?? '';
    return lastSegment.includes('.') || lastSegment.startsWith('.') ? 'exact-file' : 'exact-dir';
  }
  return hasDoubleStar ? 'deep-glob' : 'single-glob';
}

function formatMatchedBy(matchedBy: SearchMatchSource[] | undefined): string | null {
  if (!matchedBy || matchedBy.length === 0) {
    return null;
  }
  return matchedBy.join(' + ');
}

function formatSearchDebug(memory: DisplayMemory): string | null {
  const parts: string[] = [];
  if (typeof memory.path_score === 'number') {
    parts.push(`path ${memory.path_score.toFixed(3)}`);
  }
  if (typeof memory.lexical_score === 'number') {
    parts.push(`lexical ${memory.lexical_score.toFixed(3)}`);
  }
  if (typeof memory.semantic_score === 'number') {
    parts.push(`semantic ${memory.semantic_score.toFixed(3)}`);
  }
  if (typeof memory.rrf_score === 'number') {
    parts.push(`fusion ${memory.rrf_score.toFixed(4)}`);
  }
  return parts.length > 0 ? parts.join(' • ') : null;
}

function formatDurationMs(inputMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(inputMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

interface MemoryModalProps {
  draft: MemoryDraft;
  mode: 'create' | 'edit';
  onClose: () => void;
  onSave: (draft: MemoryDraft) => Promise<void>;
}

function MemoryModal(props: MemoryModalProps) {
  const [draft, setDraft] = useState<MemoryDraft>(props.draft);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setErrorText(null);
    try {
      await props.onSave(draft);
      props.onClose();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
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
              onChange={(event) => {
                const memoryType = event.currentTarget.value as MemoryType;
                setDraft((current) => ({ ...current, memory_type: memoryType }));
              }}
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
              rows={5}
              required
              value={draft.content}
              onChange={(event) => {
                const content = event.currentTarget.value;
                setDraft((current) => ({ ...current, content }));
              }}
            />
          </label>
          <label>
            Tags (comma separated)
            <input
              type="text"
              value={draft.tags}
              onChange={(event) => {
                const tags = event.currentTarget.value;
                setDraft((current) => ({ ...current, tags }));
              }}
            />
          </label>
          <label>
            Path matchers (one per line)
            <textarea
              rows={4}
              value={draft.path_matchers}
              onChange={(event) => {
                const pathMatchers = event.currentTarget.value;
                setDraft((current) => ({ ...current, path_matchers: pathMatchers }));
              }}
            />
          </label>
          <label className="pin-toggle-row">
            <span className="pin-toggle-text">Pinned (inject at SessionStart)</span>
            <span className="pin-toggle-control">
              <input
                type="checkbox"
                className="pin-toggle-input"
                checked={draft.is_pinned}
                onChange={(event) => {
                  const isPinned = event.currentTarget.checked;
                  setDraft((current) => ({ ...current, is_pinned: isPinned }));
                }}
              />
              <span className="pin-toggle-slider" aria-hidden="true" />
            </span>
          </label>
          {errorText ? <p className="error-text">{errorText}</p> : null}
          <div className="modal-actions">
            <button type="button" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : props.mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function toDisplayMemory(memory: Memory): DisplayMemory {
  return {
    id: memory.id,
    content: memory.content,
    is_pinned: memory.is_pinned,
    memory_type: memory.memory_type,
    path_matchers: memory.path_matchers.map((value) => value.path_matcher),
    tags: memory.tags,
    updated_at: memory.updated_at,
  };
}

function toDisplayMemoryFromSearch(result: MemorySearchResult): DisplayMemory {
  return {
    id: result.id,
    content: result.content,
    is_pinned: result.is_pinned,
    memory_type: result.memory_type,
    path_matchers: result.path_matchers,
    tags: result.tags,
    updated_at: result.updated_at,
    score: result.score,
    ...(result.matched_by ? { matched_by: result.matched_by } : {}),
    ...(typeof result.path_score === 'number' ? { path_score: result.path_score } : {}),
    ...(typeof result.lexical_score === 'number' ? { lexical_score: result.lexical_score } : {}),
    ...(typeof result.semantic_score === 'number' ? { semantic_score: result.semantic_score } : {}),
    ...(typeof result.rrf_score === 'number' ? { rrf_score: result.rrf_score } : {}),
  };
}

function formatRepoLabel(label: string): string {
  if (label.includes('/')) {
    const parts = label.split('/');
    if (parts.length >= 2) {
      return parts.slice(-2).join('/');
    }
  }
  return label;
}

export function App() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('memories');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DisplayMemory | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(() => new Set());
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState('');

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 280);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [searchInput]);

  const reposQuery = useQuery({
    queryKey: ['repos'],
    queryFn: fetchRepos,
    refetchInterval: 10000,
  });

  useEffect(() => {
    const repos = reposQuery.data;
    if (repos && repos.length > 0 && !selectedRepoId) {
      setSelectedRepoId(repos[0]!.repo_id);
    }
  }, [reposQuery.data, selectedRepoId]);

  const filteredRepos = useMemo(() => {
    const repos = reposQuery.data ?? [];
    const filter = repoFilter.trim().toLowerCase();
    if (!filter) return repos;
    return repos.filter(
      (repo) => repo.label.toLowerCase().includes(filter) || repo.repo_id.includes(filter),
    );
  }, [reposQuery.data, repoFilter]);

  const statsQuery = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    refetchInterval: 2000,
  });

  const backgroundHooksQuery = useQuery({
    queryKey: ['background-hooks'],
    queryFn: fetchBackgroundHooks,
    enabled: activeTab === 'hooks',
    refetchInterval: activeTab === 'hooks' ? 1000 : false,
  });

  const memoriesQuery = useQuery({
    queryKey: ['memories', selectedRepoId],
    queryFn: () => fetchMemories(selectedRepoId!),
    enabled: !!selectedRepoId,
    refetchInterval: activeTab === 'memories' ? 2000 : false,
  });

  const searchResultsQuery = useQuery({
    queryKey: ['memory-search', selectedRepoId, searchQuery],
    queryFn: ({ signal }) => searchMemories(selectedRepoId!, searchQuery, { signal }),
    enabled: !!selectedRepoId && activeTab === 'memories' && searchQuery.length >= MIN_SEARCH_QUERY_LENGTH,
    refetchInterval: activeTab === 'memories' && searchQuery.length >= MIN_SEARCH_QUERY_LENGTH ? 2000 : false,
  });

  const logsQuery = useQuery({
    queryKey: ['logs'],
    queryFn: () => fetchLogs(300),
    enabled: activeTab === 'logs',
    refetchInterval: activeTab === 'logs' ? 1000 : false,
  });

  const createMutation = useMutation({
    mutationFn: (payload: Parameters<typeof createMemory>[1]) => createMemory(selectedRepoId!, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['logs'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (payload: Parameters<typeof updateMemory>[1]) => updateMemory(selectedRepoId!, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
      void queryClient.invalidateQueries({ queryKey: ['logs'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (memoryId: string) => deleteMemory(selectedRepoId!, memoryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['logs'] });
    },
  });

  const memoryRows = useMemo(() => {
    if (searchQuery.length >= MIN_SEARCH_QUERY_LENGTH) {
      return (searchResultsQuery.data ?? []).map((result) => toDisplayMemoryFromSearch(result));
    }
    return (memoriesQuery.data?.items ?? []).map((memory) => toDisplayMemory(memory));
  }, [memoriesQuery.data?.items, searchQuery, searchResultsQuery.data]);

  const memoryById = useMemo(() => {
    return new Map(memoryRows.map((memory) => [memory.id, memory]));
  }, [memoryRows]);

  const logs = logsQuery.data ?? [];
  const backgroundHooks = backgroundHooksQuery.data?.items ?? [];
  const backgroundHooksNowMs = backgroundHooksQuery.data
    ? Date.parse(backgroundHooksQuery.data.meta.now)
    : Date.now();

  function trimLogLine(value: string, maxChars = 120): string {
    const singleLine = value.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxChars) {
      return singleLine;
    }
    return `${singleLine.slice(0, maxChars - 1)}…`;
  }

  function oneLineLogMessage(log: EventLog): string {
    const main = log.detail?.trim();
    if (main) {
      return trimLogLine(main);
    }
    return trimLogLine(log.event);
  }

  function toggleExpandedLog(logId: string): void {
    setExpandedLogs((current) => {
      const next = new Set(current);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  }

  return (
    <div className="app-layout">
      <aside className="repo-sidebar">
        <h2 className="sidebar-title">Repositories</h2>
        <input
          type="text"
          className="repo-filter-input"
          placeholder="Filter repos..."
          value={repoFilter}
          onChange={(event) => setRepoFilter(event.currentTarget.value)}
        />
        <ul className="repo-list">
          {filteredRepos.map((repo) => (
            <li key={repo.repo_id}>
              <button
                type="button"
                className={`repo-item ${selectedRepoId === repo.repo_id ? 'selected' : ''}`}
                onClick={() => setSelectedRepoId(repo.repo_id)}
                title={repo.label}
              >
                <span className="repo-name">{formatRepoLabel(repo.label)}</span>
                <span className="repo-id">{repo.repo_id}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="main-content">
      <header className="stats-bar">
        <span>Hooks: {statsQuery.data?.active_background_hooks ?? '—'}</span>
        <span>Uptime: {statsQuery.data ? Math.floor(statsQuery.data.uptime_ms / 1000) : '—'}s</span>
        <span>Idle: {statsQuery.data ? Math.floor(statsQuery.data.idle_remaining_ms / 1000) : '—'}s</span>
        <span>{statsQuery.data?.online ? 'Online' : 'Offline'}</span>
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
          className={activeTab === 'hooks' ? 'active' : ''}
          onClick={() => setActiveTab('hooks')}
        >
          Hooks
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
                onChange={(event) => {
                  setSearchInput(event.currentTarget.value);
                }}
                placeholder="Search memories (semantic + lexical)"
              />
              {searchInput ? (
                <button type="button" onClick={() => setSearchInput('')}>
                  Clear
                </button>
              ) : null}
            </div>
            <small className="memory-summary">
              {searchQuery.length >= MIN_SEARCH_QUERY_LENGTH
                ? `Showing ${memoryRows.length} result${memoryRows.length === 1 ? '' : 's'}`
                : `Showing ${memoryRows.length} memories`}
            </small>
          </div>

          {memoriesQuery.isLoading || searchResultsQuery.isLoading ? <p>Loading…</p> : null}
          {memoriesQuery.error ? <p className="error-text">{String(memoriesQuery.error)}</p> : null}
          {searchResultsQuery.error ? (
            <p className="error-text">{String(searchResultsQuery.error)}</p>
          ) : null}

          <ul className="memory-list">
            {memoryRows.map((memory) => {
              const policyEffect = classifyPolicyEffect(memory);
              const matchedBy = formatMatchedBy(memory.matched_by);
              const searchDebug = formatSearchDebug(memory);
              return (
                <li
                  key={memory.id}
                  className={`memory-card type-${memory.memory_type} ${memory.is_pinned ? 'is-pinned' : ''}`}
                >
                  <div className="memory-card-header">
                    <span className={`memory-pill type-${memory.memory_type}`}>{memory.memory_type}</span>
                    <span className={`memory-pill effect-${policyEffect}`}>{policyEffect}</span>
                    <span className={`memory-pill pin-${memory.is_pinned ? 'pinned' : 'unpinned'}`}>
                      {memory.is_pinned ? 'Pinned' : 'Not pinned'}
                    </span>
                    <span className="memory-updated">
                      Updated {new Date(memory.updated_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="memory-content">{memory.content}</p>
                  <p className="memory-tags">tags: {memory.tags.join(', ') || 'none'}</p>
                  <div className="memory-path-matchers">
                    <span className="memory-meta-label">path matchers:</span>
                    {memory.path_matchers.length > 0 ? (
                      <span className="memory-matcher-list">
                        {memory.path_matchers.map((pathMatcher) => {
                          const scope = classifyMatcherScope(pathMatcher);
                          return (
                            <span key={`${memory.id}-${pathMatcher}`} className="memory-matcher-chip">
                              <code>{pathMatcher}</code>
                              <span className={`memory-matcher-scope scope-${scope}`}>{scope}</span>
                            </span>
                          );
                        })}
                      </span>
                    ) : (
                      <span className="memory-empty">none</span>
                    )}
                  </div>
                  {typeof memory.score === 'number' ? (
                    <p className="memory-score">rank score: {memory.score.toFixed(3)}</p>
                  ) : null}
                  {matchedBy ? <p className="memory-search-meta">matched by: {matchedBy}</p> : null}
                  {searchDebug ? <p className="memory-search-debug">{searchDebug}</p> : null}
                  <div className="memory-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(memoryById.get(memory.id) ?? memory);
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" onClick={() => deleteMutation.mutate(memory.id)}>
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : activeTab === 'hooks' ? (
        <section>
          <div className="section-header">
            <h2>Background Hooks</h2>
            <small>Polling every 1s while this tab is active.</small>
          </div>
          <div className="background-hooks-panel">
            {backgroundHooksQuery.isLoading ? <p>Loading background hooks…</p> : null}
            {backgroundHooksQuery.error ? (
              <p className="error-text">{String(backgroundHooksQuery.error)}</p>
            ) : null}
            {backgroundHooks.length === 0 ? (
              <p className="background-hooks-empty">No background hooks running.</p>
            ) : (
              <ul className="background-hook-list">
                {backgroundHooks.map((hook: BackgroundHook) => {
                  const runningForMs = backgroundHooksNowMs - Date.parse(hook.started_at);
                  const heartbeatAgeMs = backgroundHooksNowMs - Date.parse(hook.last_heartbeat_at);
                  const staleInMs = Date.parse(hook.stale_at) - backgroundHooksNowMs;
                  const hardTimeoutInMs = Date.parse(hook.hard_timeout_at) - backgroundHooksNowMs;
                  return (
                    <li key={hook.id} className="background-hook-card">
                      <div className="background-hook-header">
                        <strong>{hook.hook_name}</strong>
                        <span className="memory-pill effect-must">{hook.state}</span>
                      </div>
                      <p className="background-hook-metrics">
                        running for {formatDurationMs(runningForMs)} • last heartbeat{' '}
                        {formatDurationMs(heartbeatAgeMs)} ago
                      </p>
                      <p className="background-hook-metrics">
                        stale in {formatDurationMs(staleInMs)} • hard timeout in{' '}
                        {formatDurationMs(hardTimeoutInMs)}
                      </p>
                      <p className="background-hook-meta">
                        id: <code>{hook.id}</code>
                        {hook.session_id ? ` • session: ${hook.session_id}` : ''}
                        {typeof hook.pid === 'number' ? ` • pid: ${hook.pid}` : ''}
                      </p>
                      {hook.detail ? <p className="background-hook-detail">{hook.detail}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      ) : (
        <section>
          <div className="section-header">
            <h2>Logs</h2>
            <small>Polling every 1s while this tab is active.</small>
          </div>
          <div className="logs-panel">
            {logsQuery.isLoading ? <p>Loading logs…</p> : null}
            {logsQuery.error ? <p className="error-text">{String(logsQuery.error)}</p> : null}
            {logs.length === 0 ? (
              <p>No logs yet.</p>
            ) : (
              <ul className="log-list">
                {logs.map((log, index) => {
                  const logId = `${log.at}-${log.event}-${index}`;
                  const expanded = expandedLogs.has(logId);

                  return (
                    <li
                      key={logId}
                      className={`log-item ${expanded ? 'is-expanded' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleExpandedLog(logId)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleExpandedLog(logId);
                        }
                      }}
                    >
                      <div className="log-item-line">
                        <span className="log-caret" aria-hidden="true">
                          {expanded ? '▾' : '▸'}
                        </span>
                        <span className={`log-badge source-${log.kind}`}>{log.kind}</span>
                        <span className={`log-badge status-${log.status}`}>{log.status}</span>
                        <strong className="log-event">{log.event}</strong>
                        <span className="log-summary">{oneLineLogMessage(log)}</span>
                        <span className="log-time">{new Date(log.at).toLocaleString()}</span>
                      </div>
                      {expanded ? (
                        <div className="log-expanded">
                          {log.detail ? <p className="log-detail">{log.detail}</p> : null}
                          {log.memory_id ? (
                            <p className="log-meta">
                              <span>memory: {log.memory_id}</span>
                            </p>
                          ) : null}
                          {log.session_id ? (
                            <p className="log-meta">
                              <span>session: {log.session_id}</span>
                            </p>
                          ) : null}
                          {log.data ? (
                            <pre className="log-data">{JSON.stringify(log.data, null, 2)}</pre>
                          ) : (
                            <p className="log-empty-payload">No payload</p>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      )}

      {creating ? (
        <MemoryModal
          mode="create"
          draft={toDraft()}
          onClose={() => setCreating(false)}
          onSave={async (draft) => {
            await createMutation.mutateAsync({
              memory_type: draft.memory_type,
              content: draft.content,
              tags: parseTags(draft.tags),
              is_pinned: draft.is_pinned,
              path_matchers: parseMatchers(draft.path_matchers),
            });
          }}
        />
      ) : null}

      {editing ? (
        <MemoryModal
          mode="edit"
          draft={toDraft(editing)}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            await updateMutation.mutateAsync({
              id: editing.id,
              content: draft.content,
              tags: parseTags(draft.tags),
              is_pinned: draft.is_pinned,
              path_matchers: parseMatchers(draft.path_matchers),
            });
          }}
        />
      ) : null}
      </main>
    </div>
  );
}

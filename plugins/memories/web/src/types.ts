export type MemoryType = 'fact' | 'rule' | 'decision' | 'episode';
export type SearchMatchSource = 'path' | 'lexical' | 'semantic';

export interface PathMatcher {
  path_matcher: string;
}

export interface Memory {
  id: string;
  memory_type: MemoryType;
  content: string;
  tags: string[];
  is_pinned: boolean;
  path_matchers: PathMatcher[];
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  id: string;
  memory_type: MemoryType;
  content: string;
  tags: string[];
  is_pinned: boolean;
  path_matchers: string[];
  score: number;
  source: 'path' | 'hybrid';
  matched_by?: SearchMatchSource[];
  path_score?: number;
  lexical_score?: number;
  semantic_score?: number;
  rrf_score?: number;
  updated_at: string;
}

export interface StatsResponse {
  active_sessions: number;
  active_background_hooks: number;
  memory_count: number;
  online: boolean;
  shutdown_blocked: boolean;
  uptime_ms: number;
}

export interface BackgroundHook {
  id: string;
  hook_name: string;
  state: 'running';
  started_at: string;
  last_heartbeat_at: string;
  stale_at: string;
  hard_timeout_at: string;
  session_id?: string;
  detail?: string;
  pid?: number;
}

export interface BackgroundHooksResponse {
  items: BackgroundHook[];
  meta: {
    active: number;
    now: string;
  };
}

export interface EventLog {
  at: string;
  event: string;
  status: 'ok' | 'error' | 'skipped';
  kind: 'hook' | 'operation' | 'system';
  session_id?: string;
  memory_id?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

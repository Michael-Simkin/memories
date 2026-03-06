export type MemoryType = 'fact' | 'rule' | 'decision' | 'episode';

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
  updated_at: string;
}

export interface StatsResponse {
  active_sessions: number;
  memory_count: number;
  online: boolean;
  uptime_ms: number;
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

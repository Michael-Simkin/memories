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
  score: number;
  is_pinned: boolean;
  updated_at: string;
}

export interface StatsResponse {
  active_sessions: number;
  memory_count: number;
  online: boolean;
  uptime_ms: number;
}

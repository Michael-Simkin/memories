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

export interface RepoInfo {
  repo_id: string;
  label: string;
}

export interface StatsResponse {
  active_background_hooks: number;
  online: boolean;
  uptime_ms: number;
  last_interaction_at: string;
  idle_timeout_ms: number;
  idle_remaining_ms: number;
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

export interface ExtractionJob {
  repo_id: string;
  transcript_path: string;
  session_id?: string;
}

export interface ExtractionStatusResponse {
  active: ExtractionJob | null;
  queue: ExtractionJob[];
}

export type BackfillStatus = 'idle' | 'discovering' | 'phase1' | 'phase2' | 'done' | 'error';

export interface TranscriptJobResult {
  sessionId: string;
  repoId: string;
  transcriptPath: string;
  status: 'pending' | 'running' | 'done' | 'error';
  candidateCount?: number;
  error?: string;
}

export interface ProjectJobResult {
  repoId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  candidateInputCount?: number;
  actionsApplied?: number;
  error?: string;
}

export interface BackfillState {
  status: BackfillStatus;
  repoId?: string;
  startedAt?: string;
  discovery?: {
    totalTranscripts: number;
    totalProjects: number;
  };
  phase1: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    results: TranscriptJobResult[];
  };
  phase2: {
    total: number;
    completed: number;
    running: number;
    results: ProjectJobResult[];
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

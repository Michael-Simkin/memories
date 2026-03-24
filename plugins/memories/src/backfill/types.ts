export interface DiscoveredTranscript {
  transcriptPath: string;
  projectFolder: string;
  cwd: string;
  repoId: string;
  sessionId: string;
  timestamp: string;
  lineCount: number;
}

export interface DiscoveryResult {
  transcripts: DiscoveredTranscript[];
  projects: Map<string, DiscoveredTranscript[]>;
}

export interface CandidateInsight {
  content: string;
  memory_type: 'guide' | 'context';
  tags: string[];
  is_pinned: boolean;
  path_matchers: Array<{ path_matcher: string }>;
  confidence: number;
  reason: string;
  source_session: string;
}

export type TranscriptJobStatus = 'pending' | 'running' | 'done' | 'error';
export type ProjectJobStatus = 'pending' | 'running' | 'done' | 'error';
export type BackfillStatus = 'idle' | 'discovering' | 'phase1' | 'phase2' | 'done' | 'error';

export interface TranscriptJobResult {
  sessionId: string;
  repoId: string;
  transcriptPath: string;
  status: TranscriptJobStatus;
  candidateCount?: number;
  error?: string;
}

export interface ProjectJobResult {
  repoId: string;
  status: ProjectJobStatus;
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

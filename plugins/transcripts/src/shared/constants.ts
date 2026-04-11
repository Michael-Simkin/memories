export const TRANSCRIPT_DB_FILE = 'transcripts.db';
export const SYNC_LOCK_FILE = 'transcripts.sync.lock.json';
export const SYNC_STDERR_LOG_FILE = 'transcripts.sync.stderr.log';

export const CHUNK_MAX_CHARS = 2000;
export const SNIPPET_MAX_CHARS = 200;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const READ_MAX_LINES = 50;

export const MIN_SEMANTIC_SCORE = 0.5;

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_TIMEOUT_MS = 10_000;
export const OLLAMA_REQUEST_FAILURE_BACKOFF_MS = 15_000;
export const OLLAMA_KEEP_ALIVE = '30m';

export const OLLAMA_PROFILE_CONFIG = {
  bge: {
    dimensions: 1024,
    model: 'bge-m3',
  },
  nomic: {
    dimensions: 768,
    model: 'nomic-embed-text',
  },
} as const;

export type OllamaProfile = keyof typeof OLLAMA_PROFILE_CONFIG;

export const DROPPED_LINE_TYPES = new Set([
  'progress',
  'file-history-snapshot',
  'system',
  'queue-operation',
  'last-prompt',
]);

export const TOOL_RESULT_TRUNCATION_CHARS = 150;
export const ERROR_RESULT_TRUNCATION_CHARS = 500;

export function resolveOllamaProfile(rawProfile: string | undefined): OllamaProfile {
  const normalized = rawProfile?.trim().toLowerCase();
  if (normalized === 'nomic') {
    return 'nomic';
  }
  return 'bge';
}

export function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

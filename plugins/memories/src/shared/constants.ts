export const LOOPBACK_HOST = '127.0.0.1';
export const LOOPBACK_HOST_ALIASES = [LOOPBACK_HOST, 'localhost', '::1'] as const;

export const MEMORY_TYPES = ['fact', 'rule', 'decision', 'episode'] as const;

export const MEMORY_DB_FILE = 'ai_memory.db';
export const ENGINE_LOCK_FILE = 'engine.lock.json';
export const MEMORY_EVENTS_LOG_FILE = 'ai_memory_events.log';

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEMANTIC_K = 30;
export const DEFAULT_LEXICAL_K = 30;
export const DEFAULT_RESPONSE_TOKEN_BUDGET = 6000;

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_TIMEOUT_MS = 10_000;
export const DEFAULT_MCP_ENGINE_TIMEOUT_MS = 2_500;

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

export function resolveOllamaProfile(rawProfile: string | undefined): OllamaProfile {
  const normalized = rawProfile?.trim().toLowerCase();
  if (normalized === 'nomic') {
    return 'nomic';
  }
  return 'bge';
}

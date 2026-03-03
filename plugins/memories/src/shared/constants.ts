export const ENGINE_HOST = '127.0.0.1';
export const MAX_HOOK_INJECTION_TOKENS = 6000;
export const DEFAULT_SEMANTIC_K = 30;
export const DEFAULT_LEXICAL_K = 30;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const MEMORY_TYPES = ['fact', 'rule', 'decision', 'episode'] as const;
export const ENGINE_LOCK_FILE = 'engine.lock.json';
export const MEMORY_DB_FILE = 'ai_memory.db';
export const OPERATION_LOG_FILE = 'ai_memory_operations.log';
export const HOOK_LOG_FILE = 'ai_memory_hook_events.log';

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

type OllamaEmbeddingProfile = 'bge' | 'nomic';

function parseEmbeddingProfile(rawValue: string | undefined): OllamaEmbeddingProfile | null {
  const value = (rawValue ?? '').trim().toLowerCase();
  if (value === 'bge' || value === 'bge-m3') {
    return 'bge';
  }
  if (value === 'nomic' || value === 'nomic-embed-text') {
    return 'nomic';
  }
  return null;
}

function inferEmbeddingDimensionsFromModel(model: string): number | null {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'bge-m3' || normalized.startsWith('bge-m3:')) {
    return 1024;
  }
  if (normalized === 'nomic-embed-text' || normalized.startsWith('nomic-embed-text:')) {
    return 768;
  }
  return null;
}

export const OLLAMA_URL = process.env.MEMORIES_OLLAMA_URL?.trim() || 'http://127.0.0.1:11434';
const selectedProfile = parseEmbeddingProfile(process.env.MEMORIES_OLLAMA_PROFILE);
export const OLLAMA_EMBED_PROFILE: OllamaEmbeddingProfile = selectedProfile ?? 'bge';
const defaultModelByProfile = OLLAMA_EMBED_PROFILE === 'nomic' ? 'nomic-embed-text' : 'bge-m3';
const defaultDimensionsByProfile = OLLAMA_EMBED_PROFILE === 'nomic' ? 768 : 1024;

export const OLLAMA_EMBED_MODEL = process.env.MEMORIES_OLLAMA_MODEL?.trim() || defaultModelByProfile;
export const OLLAMA_EMBED_TIMEOUT_MS = parsePositiveInt(process.env.MEMORIES_OLLAMA_TIMEOUT_MS, 10000);
const inferredDimensions = inferEmbeddingDimensionsFromModel(OLLAMA_EMBED_MODEL);
export const EMBEDDING_DIMENSIONS = parsePositiveInt(
  process.env.MEMORIES_EMBEDDING_DIMENSIONS,
  inferredDimensions ?? defaultDimensionsByProfile,
);

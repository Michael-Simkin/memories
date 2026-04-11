import {
  DEFAULT_OLLAMA_TIMEOUT_MS,
  DEFAULT_OLLAMA_URL,
  OLLAMA_KEEP_ALIVE,
  OLLAMA_PROFILE_CONFIG,
  OLLAMA_REQUEST_FAILURE_BACKOFF_MS,
  type OllamaProfile,
  parsePositiveInteger,
  resolveOllamaProfile,
} from '../shared/constants.js';
import { logWarn } from '../shared/logger.js';

export class EmbeddingClient {
  private readonly baseUrl: string;
  private readonly profile: OllamaProfile;
  private readonly timeoutMs: number;
  private nextRetryAtMs = 0;

  constructor() {
    this.profile = resolveOllamaProfile(process.env.TRANSCRIPTS_OLLAMA_PROFILE);
    this.baseUrl = (
      process.env.TRANSCRIPTS_OLLAMA_URL ?? DEFAULT_OLLAMA_URL
    ).replace(/\/+$/, '');
    this.timeoutMs = parsePositiveInteger(
      process.env.TRANSCRIPTS_OLLAMA_TIMEOUT_MS,
      DEFAULT_OLLAMA_TIMEOUT_MS,
    );
  }

  get model(): string {
    return OLLAMA_PROFILE_CONFIG[this.profile].model;
  }

  get dimensions(): number {
    return OLLAMA_PROFILE_CONFIG[this.profile].dimensions;
  }

  async embed(text: string): Promise<number[] | null> {
    if (Date.now() < this.nextRetryAtMs) return null;

    const normalizedText = text.trim();
    if (!normalizedText) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          input: normalizedText,
          keep_alive: OLLAMA_KEEP_ALIVE,
        }),
      });

      if (!response.ok) {
        logWarn('Ollama embed request failed', {
          model: this.model,
          status: response.status,
        });
        this.nextRetryAtMs = Date.now() + OLLAMA_REQUEST_FAILURE_BACKOFF_MS;
        return null;
      }

      const payload = (await response.json()) as unknown;
      const vector = this.parseEmbedding(payload);
      if (!vector) {
        logWarn('Ollama response did not include a valid embedding vector');
        this.nextRetryAtMs = Date.now() + OLLAMA_REQUEST_FAILURE_BACKOFF_MS;
        return null;
      }

      this.nextRetryAtMs = 0;
      return vector;
    } catch (error) {
      logWarn('Ollama embed request error', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.nextRetryAtMs = Date.now() + OLLAMA_REQUEST_FAILURE_BACKOFF_MS;
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseEmbedding(payload: unknown): number[] | null {
    if (!payload || typeof payload !== 'object') return null;

    const p = payload as { embedding?: unknown; embeddings?: unknown };

    if (Array.isArray(p.embedding) && p.embedding.every(isFiniteNumber)) {
      return p.embedding;
    }

    if (
      Array.isArray(p.embeddings) &&
      Array.isArray(p.embeddings[0]) &&
      p.embeddings[0].every(isFiniteNumber)
    ) {
      return p.embeddings[0];
    }

    return null;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

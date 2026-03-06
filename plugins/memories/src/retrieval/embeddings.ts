import {
  DEFAULT_OLLAMA_TIMEOUT_MS,
  DEFAULT_OLLAMA_URL,
  OLLAMA_PROFILE_CONFIG,
  type OllamaProfile,
  parsePositiveInteger,
  resolveOllamaProfile,
} from '../shared/constants.js';
import { logWarn } from '../shared/logger.js';

const REQUEST_FAILURE_BACKOFF_MS = 15_000;
const DEFAULT_KEEP_ALIVE = '30m';

export interface EmbeddingClientConfig {
  baseUrl?: string;
  profile?: OllamaProfile;
  timeoutMs?: number;
}

export class EmbeddingClient {
  private readonly baseUrl: string;
  private readonly profile: OllamaProfile;
  private readonly timeoutMs: number;
  private nextRetryAtMs: number;

  public constructor(config: EmbeddingClientConfig = {}) {
    const profile = config.profile ?? resolveOllamaProfile(process.env.MEMORIES_OLLAMA_PROFILE);

    this.baseUrl = (config.baseUrl ?? process.env.MEMORIES_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(
      /\/+$/,
      '',
    );
    this.profile = profile;
    this.timeoutMs =
      config.timeoutMs ??
      parsePositiveInteger(process.env.MEMORIES_OLLAMA_TIMEOUT_MS, DEFAULT_OLLAMA_TIMEOUT_MS);
    this.nextRetryAtMs = 0;
  }

  public get model(): string {
    return OLLAMA_PROFILE_CONFIG[this.profile].model;
  }

  public get dimensions(): number {
    return OLLAMA_PROFILE_CONFIG[this.profile].dimensions;
  }

  public isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  public async embed(text: string): Promise<number[] | null> {
    if (!this.isConfigured()) {
      return null;
    }
    if (Date.now() < this.nextRetryAtMs) {
      return null;
    }

    const normalizedText = text.trim();
    if (!normalizedText) {
      return null;
    }

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
          keep_alive: DEFAULT_KEEP_ALIVE,
        }),
      });

      if (!response.ok) {
        const responseText = await response.text();
        logWarn('Ollama embed request failed', {
          model: this.model,
          responseText,
          status: response.status,
          statusText: response.statusText,
        });
        this.nextRetryAtMs = Date.now() + REQUEST_FAILURE_BACKOFF_MS;
        return null;
      }

      const payload = (await response.json()) as unknown;
      const vector = this.parseEmbedding(payload);
      if (!vector) {
        logWarn('Ollama response did not include a valid embedding vector', {
          model: this.model,
        });
        this.nextRetryAtMs = Date.now() + REQUEST_FAILURE_BACKOFF_MS;
        return null;
      }

      if (vector.length !== this.dimensions) {
        logWarn('Embedding dimensions mismatch for profile', {
          expected: this.dimensions,
          actual: vector.length,
          model: this.model,
          profile: this.profile,
        });
      }

      this.nextRetryAtMs = 0;
      return vector;
    } catch (error) {
      logWarn('Ollama embed request threw an error', {
        error: error instanceof Error ? error.message : String(error),
        model: this.model,
        timeoutMs: this.timeoutMs,
      });
      this.nextRetryAtMs = Date.now() + REQUEST_FAILURE_BACKOFF_MS;
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseEmbedding(payload: unknown): number[] | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const maybePayload = payload as {
      embedding?: unknown;
      embeddings?: unknown;
    };

    if (Array.isArray(maybePayload.embedding) && maybePayload.embedding.every(isNumber)) {
      return maybePayload.embedding;
    }

    if (
      Array.isArray(maybePayload.embeddings) &&
      Array.isArray(maybePayload.embeddings[0]) &&
      maybePayload.embeddings[0].every(isNumber)
    ) {
      return maybePayload.embeddings[0];
    }

    return null;
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

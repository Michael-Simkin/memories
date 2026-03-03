import {
  EMBEDDING_DIMENSIONS,
  OLLAMA_EMBED_MODEL,
  OLLAMA_EMBED_TIMEOUT_MS,
  OLLAMA_URL,
} from '../shared/constants.js';
import { warn } from '../shared/logger.js';

const REQUEST_FAILURE_BACKOFF_MS = 15 * 1000;
const DEFAULT_KEEP_ALIVE = '30m';

export class EmbeddingClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private nextRetryAtMs: number;

  public constructor(model = OLLAMA_EMBED_MODEL, baseUrl = OLLAMA_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.nextRetryAtMs = 0;
  }

  public isConfigured(): boolean {
    return this.baseUrl.length > 0 && this.model.length > 0;
  }

  public async embed(text: string): Promise<number[] | null> {
    if (!this.isConfigured()) {
      return null;
    }
    if (this.nextRetryAtMs > Date.now()) {
      return null;
    }

    const normalizedText = text.trim();
    if (!normalizedText) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_EMBED_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          input: normalizedText,
          keep_alive: DEFAULT_KEEP_ALIVE,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        warn('Ollama embedding call failed', {
          status: response.status,
          statusText: response.statusText,
          errorText,
          model: this.model,
          url: this.baseUrl,
        });
        this.nextRetryAtMs = Date.now() + REQUEST_FAILURE_BACKOFF_MS;
        return null;
      }

      const parsed = this.parseEmbedding(await response.json());
      if (!parsed) {
        warn('Ollama embedding response did not contain vector', {
          model: this.model,
          url: this.baseUrl,
        });
        this.nextRetryAtMs = Date.now() + REQUEST_FAILURE_BACKOFF_MS;
        return null;
      }

      if (parsed.length !== EMBEDDING_DIMENSIONS) {
        warn('Ollama embedding dimensions mismatch with configured engine expectation', {
          actual: parsed.length,
          expected: EMBEDDING_DIMENSIONS,
          model: this.model,
        });
      }
      this.nextRetryAtMs = 0;
      return parsed;
    } catch (error) {
      warn('Ollama embedding request failed', {
        error: error instanceof Error ? error.message : String(error),
        model: this.model,
        timeout_ms: OLLAMA_EMBED_TIMEOUT_MS,
        url: this.baseUrl,
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
    const value = payload as {
      embeddings?: number[][];
    };
    const values = value.embeddings?.[0];
    if (!Array.isArray(values)) {
      return null;
    }
    if (!values.every((entry) => typeof entry === 'number')) {
      return null;
    }
    return values;
  }
}

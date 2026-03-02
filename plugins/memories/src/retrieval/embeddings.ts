import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GoogleAuth } from 'google-auth-library';

import { EMBEDDING_DIMENSIONS } from '../shared/constants.js';
import { warn } from '../shared/logger.js';

const execFileAsync = promisify(execFile);
const TOKEN_CACHE_TTL_MS = 45 * 60 * 1000;
const TOKEN_FAILURE_BACKOFF_MS = 15 * 1000;

export class EmbeddingClient {
  private readonly auth: GoogleAuth;
  private readonly projectId: string | null;
  private readonly region: string | null;
  private readonly model: string;
  private tokenCache: { token: string; expiresAtMs: number } | null;
  private nextTokenRetryAtMs: number;

  public constructor(model = 'gemini-embedding-001') {
    this.projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? null;
    this.region = process.env.CLOUD_ML_REGION ?? null;
    this.model = model;
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      ...(this.projectId ? { projectId: this.projectId } : {}),
    });
    this.tokenCache = null;
    this.nextTokenRetryAtMs = 0;
  }

  public isConfigured(): boolean {
    return Boolean(this.projectId && this.region);
  }

  public async embed(text: string): Promise<number[] | null> {
    if (!this.projectId || !this.region) {
      return null;
    }
    const token = await this.getAccessToken();
    if (!token) {
      warn('Embedding auth unavailable: unable to acquire Google access token');
      return null;
    }

    const endpoint = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${this.model}:predict`;
    const body = {
      instances: [{ content: text, task_type: 'RETRIEVAL_QUERY' }],
      parameters: { outputDimensionality: EMBEDDING_DIMENSIONS },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      warn('Embedding call failed', {
        status: response.status,
        statusText: response.statusText,
        errorText,
      });
      return null;
    }

    const payload = (await response.json()) as unknown;
    const parsed = this.parseEmbedding(payload);
    if (!parsed) {
      warn('Embedding response did not contain vector');
      return null;
    }
    if (parsed.length !== EMBEDDING_DIMENSIONS) {
      warn('Embedding dimensions mismatch', {
        expected: EMBEDDING_DIMENSIONS,
        actual: parsed.length,
      });
      return null;
    }
    return parsed;
  }

  private parseEmbedding(payload: unknown): number[] | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const value = payload as {
      predictions?: Array<{
        embeddings?: { values?: number[] };
      }>;
    };
    const values = value.predictions?.[0]?.embeddings?.values;
    if (!Array.isArray(values)) {
      return null;
    }
    if (!values.every((entry) => typeof entry === 'number')) {
      return null;
    }
    return values;
  }

  private async getAccessToken(): Promise<string | null> {
    const cached = this.tokenCache;
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.token;
    }
    if (this.nextTokenRetryAtMs > Date.now()) {
      return null;
    }

    const adcToken = await this.getAccessTokenFromGoogleAuth();
    if (adcToken) {
      this.tokenCache = {
        token: adcToken,
        expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS,
      };
      this.nextTokenRetryAtMs = 0;
      return adcToken;
    }

    const gcloudAdcToken = await this.getAccessTokenFromGcloud([
      'auth',
      'application-default',
      'print-access-token',
    ]);
    if (gcloudAdcToken) {
      this.tokenCache = {
        token: gcloudAdcToken,
        expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS,
      };
      this.nextTokenRetryAtMs = 0;
      return gcloudAdcToken;
    }

    const gcloudUserToken = await this.getAccessTokenFromGcloud(['auth', 'print-access-token']);
    if (gcloudUserToken) {
      this.tokenCache = {
        token: gcloudUserToken,
        expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS,
      };
      this.nextTokenRetryAtMs = 0;
      return gcloudUserToken;
    }

    this.nextTokenRetryAtMs = Date.now() + TOKEN_FAILURE_BACKOFF_MS;
    return null;
  }

  private async getAccessTokenFromGoogleAuth(): Promise<string | null> {
    try {
      const client = await this.auth.getClient();
      const accessToken = await client.getAccessToken();
      const token = accessToken.token ?? null;
      if (!token) {
        return null;
      }
      const trimmed = token.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
      warn('GoogleAuth access token acquisition failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async getAccessTokenFromGcloud(args: string[]): Promise<string | null> {
    try {
      const result = await execFileAsync('gcloud', args, {
        timeout: 2000,
      });
      const token = result.stdout.trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
}

import {
  MEMORY_SEMANTIC_MODEL,
} from "../constants/embeddings.js";
import { normalizeSemanticEmbedding } from "../utils/embeddings.js";
import { normalizeNonEmptyString } from "../utils/strings.js";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_TIMEOUT_MS = 1_000;

interface OllamaEmbeddingServiceOptions {
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class OllamaEmbeddingService {
  static resolveBaseUrl(configuredBaseUrl?: string): string {
    const normalizedBaseUrl = normalizeNonEmptyString(
      configuredBaseUrl ?? process.env["MEMORIES_OLLAMA_URL"],
    );

    if (!normalizedBaseUrl) {
      return DEFAULT_OLLAMA_BASE_URL;
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(normalizedBaseUrl);
    } catch {
      throw new Error("MEMORIES_OLLAMA_URL must be a valid absolute URL.");
    }

    parsedUrl.pathname = "";
    parsedUrl.search = "";
    parsedUrl.hash = "";

    return parsedUrl.toString().replace(/\/$/u, "");
  }

  static resolveTimeoutMs(configuredTimeoutMs?: number): number {
    if (configuredTimeoutMs === undefined) {
      return DEFAULT_OLLAMA_TIMEOUT_MS;
    }

    if (!Number.isInteger(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
      throw new Error("Ollama embedding timeout must be a positive integer.");
    }

    return configuredTimeoutMs;
  }

  private static normalizeInputs(texts: readonly string[]): string[] {
    return texts.map((text) => {
      const normalizedText = normalizeNonEmptyString(text);

      if (!normalizedText) {
        throw new Error("Ollama embedding input must be a non-empty string.");
      }

      return normalizedText;
    });
  }

  private static async readErrorMessage(response: Response): Promise<string> {
    try {
      const payload = await response.json();

      if (isRecord(payload) && typeof payload["error"] === "string") {
        return payload["error"];
      }
    } catch {
      // Fall back to the generic status text below.
    }

    return `status ${String(response.status)}`;
  }

  private static async readEmbedResponse(
    response: Response,
    expectedCount: number,
  ): Promise<number[][]> {
    if (!response.ok) {
      const errorMessage = await OllamaEmbeddingService.readErrorMessage(response);

      throw new Error(`Ollama embed request failed: ${errorMessage}.`);
    }

    const payload = await response.json();

    if (!isRecord(payload) || !Array.isArray(payload["embeddings"])) {
      throw new Error("Ollama embed response must contain an embeddings array.");
    }

    const embeddings = payload["embeddings"].map((embedding, index) => {
      if (!Array.isArray(embedding)) {
        throw new Error(
          `Ollama embedding at index ${String(index)} must be an array.`,
        );
      }

      return normalizeSemanticEmbedding(
        embedding.map((value) => {
          if (typeof value !== "number") {
            throw new Error(
              `Ollama embedding at index ${String(index)} must contain only numbers.`,
            );
          }

          return value;
        }),
      );
    });

    if (embeddings.length !== expectedCount) {
      throw new Error(
        `Ollama embed response count mismatch: expected ${String(expectedCount)} embeddings but received ${String(embeddings.length)}.`,
      );
    }

    return embeddings;
  }

  static async embedTexts(
    texts: readonly string[],
    options: OllamaEmbeddingServiceOptions = {},
  ): Promise<number[][]> {
    const normalizedTexts = OllamaEmbeddingService.normalizeInputs(texts);
    const baseUrl = OllamaEmbeddingService.resolveBaseUrl(options.baseUrl);
    const timeoutMs = OllamaEmbeddingService.resolveTimeoutMs(options.timeoutMs);
    const input =
      normalizedTexts.length === 1 ? normalizedTexts[0] : normalizedTexts;
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MEMORY_SEMANTIC_MODEL,
        input,
        truncate: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    return OllamaEmbeddingService.readEmbedResponse(
      response,
      normalizedTexts.length,
    );
  }

  static async embedText(
    text: string,
    options: OllamaEmbeddingServiceOptions = {},
  ): Promise<number[]> {
    const embeddings = await OllamaEmbeddingService.embedTexts([text], options);
    const firstEmbedding = embeddings[0];

    if (!firstEmbedding) {
      throw new Error("Ollama embed response did not include the first embedding.");
    }

    return firstEmbedding;
  }
}

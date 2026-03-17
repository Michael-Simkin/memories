import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";

import {
  MEMORY_SEMANTIC_DIMENSIONS,
  MEMORY_SEMANTIC_MODEL,
} from "../constants/embeddings.js";
import { OllamaEmbeddingService } from "../services/ollama-embedding-service.js";

function createVector(entries: Array<[number, number]>): number[] {
  const vector = Array.from({ length: MEMORY_SEMANTIC_DIMENSIONS }, () => 0);

  for (const [index, value] of entries) {
    vector[index] = value;
  }

  return vector;
}

async function startMockOllamaServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> | void,
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    server.close();
    await once(server, "close");
    throw new Error("Mock Ollama server did not bind to a TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    async close(): Promise<void> {
      server.close();
      await once(server, "close");
    },
  };
}

describe("OllamaEmbeddingService", () => {
  it("uses the default Ollama base URL when no override is set", () => {
    const originalOllamaUrl = process.env["MEMORIES_OLLAMA_URL"];

    delete process.env["MEMORIES_OLLAMA_URL"];

    try {
      assert.equal(
        OllamaEmbeddingService.resolveBaseUrl(),
        "http://127.0.0.1:11434",
      );
    } finally {
      if (originalOllamaUrl === undefined) {
        delete process.env["MEMORIES_OLLAMA_URL"];
      } else {
        process.env["MEMORIES_OLLAMA_URL"] = originalOllamaUrl;
      }
    }
  });

  it("posts to /api/embed and normalizes the returned embedding", async (testContext) => {
    const mockServer = await startMockOllamaServer(async (request, response) => {
      const requestBodyChunks: Buffer[] = [];

      for await (const chunk of request) {
        const bufferChunk = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), "utf8");

        requestBodyChunks.push(bufferChunk);
      }

      const requestBody = JSON.parse(
        Buffer.concat(requestBodyChunks).toString("utf8"),
      ) as { input: string; model: string };

      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/embed");
      assert.equal(requestBody.model, MEMORY_SEMANTIC_MODEL);
      assert.equal(requestBody.input, "Normalize this embedding.");

      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          embeddings: [createVector([[0, 3], [1, 4]])],
        }),
      );
    });

    testContext.after(async () => {
      await mockServer.close();
    });

    const embedding = await OllamaEmbeddingService.embedText(
      "Normalize this embedding.",
      {
        baseUrl: `${mockServer.baseUrl}/`,
      },
    );
    const firstValue = embedding[0];
    const secondValue = embedding[1];

    assert.equal(embedding.length, MEMORY_SEMANTIC_DIMENSIONS);
    assert.ok(firstValue !== undefined);
    assert.ok(secondValue !== undefined);
    assert.ok(Math.abs(firstValue - 0.6) < Number.EPSILON);
    assert.ok(Math.abs(secondValue - 0.8) < Number.EPSILON);
  });

  it("throws an actionable error when Ollama returns a failure response", async (testContext) => {
    const mockServer = await startMockOllamaServer((_request, response) => {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: "model not loaded",
        }),
      );
    });

    testContext.after(async () => {
      await mockServer.close();
    });

    await assert.rejects(
      () =>
        OllamaEmbeddingService.embedText("Trigger an error.", {
          baseUrl: mockServer.baseUrl,
        }),
      /model not loaded/u,
    );
  });
});

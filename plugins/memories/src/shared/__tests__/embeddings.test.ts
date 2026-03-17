import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MEMORY_SEMANTIC_DIMENSIONS } from "../constants/embeddings.js";
import {
  normalizeSemanticEmbedding,
  serializeSemanticEmbedding,
} from "../utils/embeddings.js";

function createEmbedding(valueAtIndex: [number, number]): number[] {
  const embedding = Array.from({ length: MEMORY_SEMANTIC_DIMENSIONS }, () => 0);
  embedding[valueAtIndex[0]] = valueAtIndex[1];

  return embedding;
}

describe("normalizeSemanticEmbedding", () => {
  it("normalizes embeddings to unit length", () => {
    const normalizedEmbedding = normalizeSemanticEmbedding([3, 4, ...Array.from({
      length: MEMORY_SEMANTIC_DIMENSIONS - 2,
    }, () => 0)]);

    assert.equal(normalizedEmbedding[0], 0.6);
    assert.equal(normalizedEmbedding[1], 0.8);
  });

  it("rejects embeddings with the wrong dimension count", () => {
    assert.throws(
      () => normalizeSemanticEmbedding([1, 2, 3]),
      /exactly 1024 dimensions/u,
    );
  });

  it("rejects zero vectors", () => {
    assert.throws(
      () =>
        normalizeSemanticEmbedding(
          Array.from({ length: MEMORY_SEMANTIC_DIMENSIONS }, () => 0),
        ),
      /zero vector/u,
    );
  });
});

describe("serializeSemanticEmbedding", () => {
  it("serializes normalized embeddings as JSON", () => {
    const serializedEmbedding = serializeSemanticEmbedding(createEmbedding([8, 5]));
    const parsedEmbedding = JSON.parse(serializedEmbedding) as number[];

    assert.match(serializedEmbedding, /^\[/u);
    assert.equal(parsedEmbedding.length, MEMORY_SEMANTIC_DIMENSIONS);
    assert.equal(parsedEmbedding[8], 1);
  });
});

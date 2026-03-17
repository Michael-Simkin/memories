import { MEMORY_SEMANTIC_DIMENSIONS } from "../constants/embeddings.js";
function normalizeSemanticEmbedding(embedding) {
  if (embedding.length !== MEMORY_SEMANTIC_DIMENSIONS) {
    throw new Error(
      `Semantic embedding must contain exactly ${String(MEMORY_SEMANTIC_DIMENSIONS)} dimensions.`
    );
  }
  let sumOfSquares = 0;
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error("Semantic embedding values must all be finite numbers.");
    }
    sumOfSquares += value * value;
  }
  if (sumOfSquares <= 0) {
    throw new Error("Semantic embedding must not be the zero vector.");
  }
  const magnitude = Math.sqrt(sumOfSquares);
  return embedding.map((value) => value / magnitude);
}
function serializeSemanticEmbedding(embedding) {
  return JSON.stringify(normalizeSemanticEmbedding(embedding));
}
export {
  normalizeSemanticEmbedding,
  serializeSemanticEmbedding
};

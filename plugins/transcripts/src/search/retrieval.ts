import { MIN_SEMANTIC_SCORE, SNIPPET_MAX_CHARS } from '../shared/constants.js';
import type { SearchResult } from '../shared/types.js';
import { TranscriptStore } from '../storage/database.js';
import { EmbeddingClient } from '../sync/embedder.js';

export async function searchTranscripts(
  store: TranscriptStore,
  embedder: EmbeddingClient,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const queryVector = await embedder.embed(query);
  if (!queryVector) {
    return [];
  }

  const allEmbeddings = store.getAllEmbeddings();
  if (allEmbeddings.length === 0) {
    return [];
  }

  const scored = allEmbeddings
    .map((entry) => ({
      ...entry,
      score: cosineSimilarity(queryVector, entry.vector),
    }))
    .filter((entry) => entry.score >= MIN_SEMANTIC_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((entry) => ({
    transcriptPath: entry.transcriptPath,
    lineNumber: entry.lineNumber,
    score: Math.round(entry.score * 1000) / 1000,
    sessionTimestamp: entry.sessionTimestamp,
    projectPath: entry.projectPath,
    snippet: truncateSnippet(entry.chunkText, SNIPPET_MAX_CHARS),
    role: entry.role,
  }));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dot / denominator;
}

function truncateSnippet(text: string, maxChars: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return oneLine.slice(0, maxChars) + '...';
}

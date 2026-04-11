import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TranscriptStore } from '../storage/database.js';
import { parseTranscriptFile } from '../sync/parser.js';
import { chunkTurns } from '../sync/chunker.js';
import { EmbeddingClient } from '../sync/embedder.js';
import { searchTranscripts } from '../search/retrieval.js';
import { readTranscriptRange } from '../read/formatter.js';

const SAMPLE_TRANSCRIPT =
  '/Users/michaelsi/.claude/projects/-Users-michaelsi-Development-mf-calls-and-meetings/2f3e4ee0-fdf3-490f-b66c-f01af2e83ff3.jsonl';

const transcriptExists = existsSync(SAMPLE_TRANSCRIPT);

describe.skipIf(!transcriptExists)('single transcript integration', () => {
  it('parses a real transcript and extracts turns', () => {
    const raw = readFileSync(SAMPLE_TRANSCRIPT, 'utf8');
    const rawLines = raw.split('\n');

    const { metadata, turns } = parseTranscriptFile(rawLines);

    expect(metadata.projectPath).toBeTruthy();
    expect(metadata.projectPath).not.toBe('unknown');
    expect(metadata.sessionTimestamp).toBeGreaterThan(0);
    expect(turns.length).toBeGreaterThan(0);

    for (const turn of turns) {
      expect(turn.lineNumber).toBeGreaterThan(0);
      expect(['user', 'assistant']).toContain(turn.role);
      expect(turn.text.trim().length).toBeGreaterThan(0);
    }

    const noiseTypes = ['progress', 'file-history-snapshot', 'system', 'queue-operation'];
    for (const turn of turns) {
      for (const noise of noiseTypes) {
        expect(turn.text).not.toContain(`"type":"${noise}"`);
      }
    }
  });

  it('chunks a real transcript with correct constraints', () => {
    const raw = readFileSync(SAMPLE_TRANSCRIPT, 'utf8');
    const { metadata, turns } = parseTranscriptFile(raw.split('\n'));

    const chunks = chunkTurns(
      turns,
      SAMPLE_TRANSCRIPT,
      metadata.sessionTimestamp,
      metadata.projectPath,
    );

    expect(chunks.length).toBeGreaterThanOrEqual(turns.length);

    for (const chunk of chunks) {
      expect(chunk.chunkText.length).toBeLessThanOrEqual(2000);
      expect(chunk.chunkText.trim().length).toBeGreaterThan(0);
      expect(chunk.transcriptPath).toBe(SAMPLE_TRANSCRIPT);
      expect(chunk.chunkId).toBeTruthy();
    }
  });

  it('stores chunks in DB and retrieves them', async () => {
    const raw = readFileSync(SAMPLE_TRANSCRIPT, 'utf8');
    const { metadata, turns } = parseTranscriptFile(raw.split('\n'));
    const chunks = chunkTurns(
      turns,
      SAMPLE_TRANSCRIPT,
      metadata.sessionTimestamp,
      metadata.projectPath,
    );

    const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-integ-'));
    const store = new TranscriptStore(path.join(dir, 'test.db'));

    store.setSyncProgress(SAMPLE_TRANSCRIPT, Date.now(), chunks.length, 'complete');

    for (const chunk of chunks) {
      store.insertChunk(chunk);
      // Insert a dummy embedding for testing retrieval
      const dummyVec = Array.from({ length: 16 }, (_, i) =>
        Math.sin(chunk.lineNumber + i),
      );
      const norm = Math.sqrt(dummyVec.reduce((s, v) => s + v * v, 0));
      store.insertEmbedding(
        chunk.chunkId,
        dummyVec.map((v) => v / norm),
      );
    }

    const all = store.getAllEmbeddings();
    expect(all.length).toBe(chunks.length);

    store.close();
  });

  it('formats transcript range from real file', () => {
    const result = readTranscriptRange(SAMPLE_TRANSCRIPT, 1, 10);

    expect(result.header).toContain('Session:');
    expect(result.lines.length).toBeLessThanOrEqual(10);

    for (const line of result.lines) {
      expect(line).toMatch(/^L\d+ \|/);
    }

    // At least some lines should have content (not all noise)
    const contentLines = result.lines.filter((l) => l.length > l.indexOf('|') + 2);
    expect(contentLines.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!transcriptExists)('single transcript ollama integration', () => {
  it('embeds chunks from a real transcript and searches', async () => {
    const embedder = new EmbeddingClient();

    // Quick health check — skip if ollama is unavailable
    const testVec = await embedder.embed('test');
    if (!testVec) {
      console.log('Ollama unavailable, skipping embedding integration test');
      return;
    }

    expect(testVec.length).toBe(1024); // bge-m3 dimensions

    const raw = readFileSync(SAMPLE_TRANSCRIPT, 'utf8');
    const { metadata, turns } = parseTranscriptFile(raw.split('\n'));
    const chunks = chunkTurns(
      turns,
      SAMPLE_TRANSCRIPT,
      metadata.sessionTimestamp,
      metadata.projectPath,
    );

    // Only embed first 5 chunks to keep test fast
    const testChunks = chunks.slice(0, 5);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-ollama-'));
    const store = new TranscriptStore(path.join(dir, 'test.db'));

    store.setSyncProgress(SAMPLE_TRANSCRIPT, Date.now(), testChunks.length, 'complete');

    for (const chunk of testChunks) {
      store.insertChunk(chunk);
      const vec = await embedder.embed(chunk.chunkText);
      if (vec) {
        store.insertEmbedding(chunk.chunkId, vec);
      }
    }

    const embeddedCount = store.getAllEmbeddings().length;
    expect(embeddedCount).toBeGreaterThan(0);

    // Search should return results
    const results = await searchTranscripts(store, embedder, 'code review changes', 5);
    // Results may be empty if similarity is too low, but no errors
    expect(Array.isArray(results)).toBe(true);

    if (results.length > 0) {
      expect(results[0]!.score).toBeGreaterThan(0);
      expect(results[0]!.transcriptPath).toBe(SAMPLE_TRANSCRIPT);
    }

    store.close();
  }, 30_000); // 30s timeout for ollama calls
});

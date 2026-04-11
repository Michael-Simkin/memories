import { describe, expect, it } from 'vitest';

import { chunkTurns } from './chunker.js';
import type { ParsedTurn } from '../shared/types.js';

const BASE_META = {
  transcriptPath: '/test/session.jsonl',
  sessionTimestamp: 1712700000000,
  projectPath: '/my/project',
};

describe('chunker', () => {
  it('creates one chunk per turn when under limit', () => {
    const turns: ParsedTurn[] = [
      { lineNumber: 1, role: 'user', text: 'Short message' },
      { lineNumber: 2, role: 'assistant', text: 'Short reply' },
    ];

    const chunks = chunkTurns(turns, BASE_META.transcriptPath, BASE_META.sessionTimestamp, BASE_META.projectPath);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.lineNumber).toBe(1);
    expect(chunks[0]!.role).toBe('user');
    expect(chunks[1]!.chunkIndex).toBe(0);
    expect(chunks[1]!.lineNumber).toBe(2);
    expect(chunks[1]!.role).toBe('assistant');
  });

  it('splits a turn exceeding 2000 chars into sub-chunks', () => {
    const longText = 'word '.repeat(500); // ~2500 chars
    const turns: ParsedTurn[] = [
      { lineNumber: 5, role: 'assistant', text: longText },
    ];

    const chunks = chunkTurns(turns, BASE_META.transcriptPath, BASE_META.sessionTimestamp, BASE_META.projectPath);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.chunkText.length).toBeLessThanOrEqual(2000);
      expect(chunk.lineNumber).toBe(5);
      expect(chunk.role).toBe('assistant');
    }

    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[1]!.chunkIndex).toBe(1);
  });

  it('never merges text from different turns', () => {
    const turns: ParsedTurn[] = [
      { lineNumber: 1, role: 'user', text: 'First turn' },
      { lineNumber: 3, role: 'assistant', text: 'Second turn' },
    ];

    const chunks = chunkTurns(turns, BASE_META.transcriptPath, BASE_META.sessionTimestamp, BASE_META.projectPath);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.chunkText).toBe('First turn');
    expect(chunks[1]!.chunkText).toBe('Second turn');
  });

  it('skips turns with empty text', () => {
    const turns: ParsedTurn[] = [
      { lineNumber: 1, role: 'user', text: '  ' },
      { lineNumber: 2, role: 'assistant', text: 'Real content' },
    ];

    const chunks = chunkTurns(turns, BASE_META.transcriptPath, BASE_META.sessionTimestamp, BASE_META.projectPath);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkText).toBe('Real content');
  });

  it('preserves metadata on all chunks', () => {
    const turns: ParsedTurn[] = [
      { lineNumber: 42, role: 'user', text: 'test content' },
    ];

    const chunks = chunkTurns(turns, BASE_META.transcriptPath, BASE_META.sessionTimestamp, BASE_META.projectPath);
    expect(chunks[0]!.transcriptPath).toBe(BASE_META.transcriptPath);
    expect(chunks[0]!.sessionTimestamp).toBe(BASE_META.sessionTimestamp);
    expect(chunks[0]!.projectPath).toBe(BASE_META.projectPath);
  });

  it('generates unique chunk IDs', () => {
    const turns: ParsedTurn[] = [
      { lineNumber: 1, role: 'user', text: 'a' },
      { lineNumber: 2, role: 'user', text: 'b' },
    ];

    const chunks = chunkTurns(turns, BASE_META.transcriptPath, BASE_META.sessionTimestamp, BASE_META.projectPath);
    const ids = new Set(chunks.map((c) => c.chunkId));
    expect(ids.size).toBe(chunks.length);
  });
});

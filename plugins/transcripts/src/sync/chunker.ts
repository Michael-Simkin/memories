import { CHUNK_MAX_CHARS } from '../shared/constants.js';
import type { Chunk, ParsedTurn } from '../shared/types.js';
import { ulid } from 'ulid';

export function chunkTurns(
  turns: ParsedTurn[],
  transcriptPath: string,
  sessionTimestamp: number,
  projectPath: string,
): Chunk[] {
  const chunks: Chunk[] = [];

  for (const turn of turns) {
    const text = turn.text.trim();
    if (!text) continue;

    if (text.length <= CHUNK_MAX_CHARS) {
      chunks.push({
        chunkId: ulid(),
        transcriptPath,
        lineNumber: turn.lineNumber,
        role: turn.role,
        chunkText: text,
        chunkIndex: 0,
        sessionTimestamp,
        projectPath,
      });
    } else {
      const subChunks = splitText(text, CHUNK_MAX_CHARS);
      for (let i = 0; i < subChunks.length; i++) {
        chunks.push({
          chunkId: ulid(),
          transcriptPath,
          lineNumber: turn.lineNumber,
          role: turn.role,
          chunkText: subChunks[i]!,
          chunkIndex: i,
          sessionTimestamp,
          projectPath,
        });
      }
    }
  }

  return chunks;
}

function splitText(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxChars);
    }
    if (splitAt <= 0) {
      splitAt = maxChars;
    }

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

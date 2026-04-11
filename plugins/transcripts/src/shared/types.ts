import { z } from 'zod';

export const sessionStartPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    project_root: z.string().optional(),
    session_id: z.string().optional(),
  })
  .catchall(z.unknown());

export type SessionStartPayload = z.infer<typeof sessionStartPayloadSchema>;

export const sessionEndPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    project_root: z.string().optional(),
    session_id: z.string().optional(),
  })
  .catchall(z.unknown());

export type SessionEndPayload = z.infer<typeof sessionEndPayloadSchema>;

export interface TranscriptLine {
  type: string;
  isSidechain?: boolean;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
    id?: string;
    model?: string;
  };
}

export interface ParsedTurn {
  lineNumber: number;
  role: 'user' | 'assistant';
  text: string;
}

export interface Chunk {
  chunkId: string;
  transcriptPath: string;
  lineNumber: number;
  role: 'user' | 'assistant';
  chunkText: string;
  chunkIndex: number;
  sessionTimestamp: number;
  projectPath: string;
}

export interface ChunkWithEmbedding extends Chunk {
  embedding: number[];
}

export interface SearchResult {
  transcriptPath: string;
  lineNumber: number;
  score: number;
  sessionTimestamp: number;
  projectPath: string;
  snippet: string;
  role: string;
}

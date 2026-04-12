import {
  DROPPED_LINE_TYPES,
  ERROR_RESULT_TRUNCATION_CHARS,
  TOOL_RESULT_TRUNCATION_CHARS,
} from '../shared/constants.js';
import type { ParsedTurn, TranscriptLine } from '../shared/types.js';

export interface TranscriptMetadata {
  projectPath: string;
  sessionTimestamp: number;
}

export function parseTranscriptFile(
  rawLines: string[],
  lineOffset = 0,
): {
  metadata: TranscriptMetadata;
  turns: ParsedTurn[];
} {
  let projectPath = '';
  let sessionTimestamp = 0;
  const turns: ParsedTurn[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    if (!line.trim()) continue;

    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== 'object') continue;

    const obj = parsed as TranscriptLine;

    if (!projectPath && obj.cwd) {
      projectPath = obj.cwd;
    }
    if (!sessionTimestamp && obj.timestamp) {
      sessionTimestamp = new Date(obj.timestamp).getTime();
    }

    if (DROPPED_LINE_TYPES.has(obj.type)) continue;
    if (obj.isSidechain === true) continue;
    if (!obj.message) continue;

    const role = obj.message.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = contentToText(obj.message.content);
    if (!text.trim()) continue;

    turns.push({
      lineNumber: lineOffset + i + 1,
      role: role as 'user' | 'assistant',
      text,
    });
  }

  return {
    metadata: {
      projectPath: projectPath || 'unknown',
      sessionTimestamp: sessionTimestamp || Date.now(),
    },
    turns,
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue;
    const blockType = block.type as string;

    if (blockType === 'thinking') continue;
    if (blockType === 'image') continue;

    if (blockType === 'text') {
      const text = (block.text as string)?.trim();
      if (text) parts.push(text);
    } else if (blockType === 'tool_use') {
      parts.push(`[Tool: ${block.name as string}]`);
    } else if (blockType === 'tool_result') {
      const resultText = extractToolResultText(block.content);
      if (resultText) {
        parts.push(`[Result: ${resultText}]`);
      }
    }
  }

  return parts.join('\n');
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return truncate(
      content,
      looksLikeError(content) ? ERROR_RESULT_TRUNCATION_CHARS : TOOL_RESULT_TRUNCATION_CHARS,
    );
  }
  if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        const limit = looksLikeError(item.text)
          ? ERROR_RESULT_TRUNCATION_CHARS
          : TOOL_RESULT_TRUNCATION_CHARS;
        return truncate(item.text, limit);
      }
    }
  }
  return '';
}

function looksLikeError(text: string): boolean {
  return /error|fail|exception|stderr|traceback|panic/i.test(text.slice(0, 200));
}

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  return oneLine.slice(0, limit) + '...';
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

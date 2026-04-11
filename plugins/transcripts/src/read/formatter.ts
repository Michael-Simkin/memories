import { readFileSync } from 'node:fs';

import {
  DROPPED_LINE_TYPES,
  ERROR_RESULT_TRUNCATION_CHARS,
  TOOL_RESULT_TRUNCATION_CHARS,
} from '../shared/constants.js';
import type { TranscriptLine } from '../shared/types.js';

export interface FormattedTranscript {
  header: string;
  lines: string[];
}

export function readTranscriptRange(
  transcriptPath: string,
  startLine: number,
  endLine: number,
): FormattedTranscript {
  const rawContent = readFileSync(transcriptPath, 'utf8');
  const rawLines = rawContent.split('\n');
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]!.trim() === '') {
    rawLines.pop();
  }

  const projectPath = extractProjectPath(rawLines);
  const sessionDate = extractSessionDate(rawLines);

  const clampedStart = Math.max(1, startLine);
  const clampedEnd = Math.min(rawLines.length, endLine);

  const formattedLines: string[] = [];

  for (let i = clampedStart - 1; i < clampedEnd; i++) {
    const lineNum = i + 1;
    const line = rawLines[i];

    if (!line?.trim()) {
      formattedLines.push(`L${lineNum} |`);
      continue;
    }

    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== 'object') {
      formattedLines.push(`L${lineNum} |`);
      continue;
    }

    const obj = parsed as TranscriptLine;

    if (DROPPED_LINE_TYPES.has(obj.type)) {
      formattedLines.push(`L${lineNum} |`);
      continue;
    }
    if (obj.isSidechain === true) {
      formattedLines.push(`L${lineNum} |`);
      continue;
    }
    if (!obj.message) {
      formattedLines.push(`L${lineNum} |`);
      continue;
    }

    const role = obj.message.role;
    if (role !== 'user' && role !== 'assistant') {
      formattedLines.push(`L${lineNum} |`);
      continue;
    }

    const text = contentToRichText(obj.message.content);
    if (!text.trim()) {
      formattedLines.push(`L${lineNum} |`);
      continue;
    }

    const roleLabel = role === 'user' ? '**User**' : '**Assistant**';
    formattedLines.push(`L${lineNum} | ${roleLabel}: ${text}`);
  }

  return {
    header: `## Session: ${sessionDate} — project: ${projectPath}`,
    lines: formattedLines,
  };
}

function contentToRichText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue;
    const blockType = block.type as string;

    if (blockType === 'thinking' || blockType === 'image') continue;

    if (blockType === 'text') {
      const text = (block.text as string)?.trim();
      if (text) parts.push(text);
    } else if (blockType === 'tool_use') {
      parts.push(`[Tool: ${block.name as string}]`);
    } else if (blockType === 'tool_result') {
      const resultText = extractToolResultText(block.content);
      if (resultText) parts.push(`[Result: ${resultText}]`);
    }
  }

  return parts.join(' | ');
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

function extractProjectPath(rawLines: string[]): string {
  for (const line of rawLines.slice(0, 10)) {
    const parsed = safeJsonParse(line);
    if (parsed && typeof parsed === 'object') {
      const cwd = (parsed as Record<string, unknown>).cwd as string;
      if (cwd) return cwd;
    }
  }
  return 'unknown';
}

function extractSessionDate(rawLines: string[]): string {
  for (const line of rawLines.slice(0, 10)) {
    const parsed = safeJsonParse(line);
    if (parsed && typeof parsed === 'object') {
      const timestamp = (parsed as Record<string, unknown>).timestamp as string;
      if (timestamp) {
        return new Date(timestamp).toISOString().split('T')[0]!;
      }
    }
  }
  return 'unknown-date';
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

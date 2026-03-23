const DROPPED_LINE_TYPES = new Set([
  'progress',
  'file-history-snapshot',
  'system',
  'queue-operation',
  'last-prompt',
]);
const TOOL_RESULT_TRUNCATION_CHARS = 150;
const ERROR_RESULT_TRUNCATION_CHARS = 500;

export function transcriptToMarkdown(lines: string[]): string {
  const parts: string[] = [];

  for (const line of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (DROPPED_LINE_TYPES.has(obj.type as string)) {
      continue;
    }
    if (obj.isSidechain === true) {
      continue;
    }

    const md = lineToMarkdown(obj);
    if (md) {
      parts.push(md);
    }
  }

  return parts.join('\n');
}

function lineToMarkdown(obj: Record<string, unknown>): string | null {
  const type = obj.type as string;
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) {
    return null;
  }

  const content = message.content;
  if (type === 'user') {
    return `User: ${contentToText(content)}`;
  }
  if (type === 'assistant') {
    return `Assistant: ${contentToText(content)}`;
  }
  return null;
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

    if (blockType === 'thinking') {
      continue;
    }
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
    } else if (blockType === 'image') {
      parts.push('[Image]');
    }
  }

  return parts.join('\n') || '';
}

function looksLikeError(text: string): boolean {
  return /error|fail|exception|stderr|traceback|panic/i.test(text.slice(0, 200));
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return truncate(content, looksLikeError(content) ? ERROR_RESULT_TRUNCATION_CHARS : TOOL_RESULT_TRUNCATION_CHARS);
  }
  if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        const limit = looksLikeError(item.text) ? ERROR_RESULT_TRUNCATION_CHARS : TOOL_RESULT_TRUNCATION_CHARS;
        return truncate(item.text, limit);
      }
    }
  }
  return '';
}

function truncate(text: string, limit: number = TOOL_RESULT_TRUNCATION_CHARS): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= limit) {
    return oneLine;
  }
  return oneLine.slice(0, limit) + '...';
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

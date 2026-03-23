const DROPPED_LINE_TYPES = new Set(['progress', 'file-history-snapshot', 'system']);
const TOOL_RESULT_TRUNCATION_CHARS = 200;

export function filterTranscriptLines(lines: string[]): string[] {
  const filtered: string[] = [];
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
    const result = filterContentBlocks(obj);
    if (result) {
      filtered.push(JSON.stringify(stripMetadata(result)));
    }
  }
  return filtered;
}

function stripMetadata(obj: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = { type: obj.type };
  if (obj.message !== undefined) {
    kept.message = obj.message;
  }
  return kept;
}

function filterContentBlocks(obj: Record<string, unknown>): Record<string, unknown> | null {
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) {
    return obj;
  }

  const content = message.content;
  if (typeof content === 'string') {
    return obj;
  }
  if (!Array.isArray(content)) {
    return obj;
  }

  const filtered = content
    .filter((block: Record<string, unknown>) => block?.type !== 'thinking')
    .map((block: Record<string, unknown>) => {
      if (block?.type === 'tool_result') {
        return truncateToolResult(block);
      }
      if (block?.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name };
      }
      return block;
    });

  if (filtered.length === 0) {
    return null;
  }

  return {
    ...obj,
    message: { ...message, content: filtered },
  };
}

function truncateToolResult(block: Record<string, unknown>): Record<string, unknown> {
  const content = block.content;
  if (typeof content === 'string' && content.length > TOOL_RESULT_TRUNCATION_CHARS) {
    return {
      ...block,
      content: content.slice(0, TOOL_RESULT_TRUNCATION_CHARS) + '...[truncated]',
    };
  }
  if (Array.isArray(content)) {
    const truncatedContent = content.map((item: Record<string, unknown>) => {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.length > TOOL_RESULT_TRUNCATION_CHARS) {
        return { ...item, text: item.text.slice(0, TOOL_RESULT_TRUNCATION_CHARS) + '...[truncated]' };
      }
      return item;
    });
    return { ...block, content: truncatedContent };
  }
  return block;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

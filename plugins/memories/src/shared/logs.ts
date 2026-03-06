import { readFile } from 'node:fs/promises';

import { appendJsonLine } from './fs-utils.js';
import { type MemoryEventLog,memoryEventLogSchema } from './types.js';

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /(?<=token[=:]\s?)[A-Za-z0-9._-]+/gi,
];

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    let redacted = value;
    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replaceAll(pattern, '[REDACTED]');
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactSecrets(entry),
      ]),
    );
  }
  return value;
}

export async function appendEventLog(logPath: string, event: MemoryEventLog): Promise<void> {
  const validated = memoryEventLogSchema.parse(event);
  await appendJsonLine(logPath, redactSecrets(validated));
}

export async function readEventLogs(logPath: string, limit = 200): Promise<MemoryEventLog[]> {
  try {
    const raw = await readFile(logPath, 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const selected = lines.slice(Math.max(0, lines.length - limit));
    return selected.flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        const validated = memoryEventLogSchema.safeParse(parsed);
        return validated.success ? [validated.data] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

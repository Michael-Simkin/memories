import { readFile } from 'node:fs/promises';

import { appendJsonLine } from './fs-utils.js';
import type { HookEventLog, OperationLog } from './types.js';

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /(?<=token[=:]\s?)[A-Za-z0-9._-]+/gi,
];

function redactValue(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replaceAll(pattern, '[REDACTED]');
  }
  return redacted;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.map(([key, entry]) => [key, redactUnknown(entry)]));
  }
  return value;
}

export async function hookLog(path: string, payload: HookEventLog): Promise<void> {
  await appendJsonLine(path, redactUnknown(payload));
}

export async function appendOperationLog(path: string, payload: OperationLog): Promise<void> {
  await appendJsonLine(path, redactUnknown(payload));
}

export async function readJsonLogs(path: string, limit = 200): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const picked = lines.slice(Math.max(0, lines.length - limit));
    return picked.flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return [parsed];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (isErrno(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

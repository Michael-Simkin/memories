type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTION_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /(?<=token[=:]\s?)[A-Za-z0-9._-]+/gi,
];

function resolveLogLevel(raw: string | undefined): LogLevel {
  const normalized = raw?.trim().toLowerCase();
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error' ||
    normalized === 'silent'
  ) {
    return normalized;
  }
  return 'info';
}

const configuredLogLevel = resolveLogLevel(process.env.LOG_LEVEL);

function shouldWrite(level: Exclude<LogLevel, 'silent'>): boolean {
  if (configuredLogLevel === 'silent') {
    return false;
  }
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[configuredLogLevel];
}

function redactString(value: string): string {
  let redacted = value;
  for (const pattern of REDACTION_PATTERNS) {
    redacted = redacted.replaceAll(pattern, '[REDACTED]');
  }
  return redacted;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactUnknown(entry),
      ]),
    );
  }
  return value;
}

function writeLog(
  level: Exclude<LogLevel, 'silent'>,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!shouldWrite(level)) {
    return;
  }
  const payload = {
    at: new Date().toISOString(),
    level,
    message: redactString(message),
    ...(data ? { data: redactUnknown(data) } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export function logDebug(message: string, data?: Record<string, unknown>): void {
  writeLog('debug', message, data);
}

export function logInfo(message: string, data?: Record<string, unknown>): void {
  writeLog('info', message, data);
}

export function logWarn(message: string, data?: Record<string, unknown>): void {
  writeLog('warn', message, data);
}

export function logError(message: string, data?: Record<string, unknown>): void {
  writeLog('error', message, data);
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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
    plugin: 'transcripts',
    message,
    ...(data ? { data } : {}),
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

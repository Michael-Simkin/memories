type LogLevel = 'silent' | 'info' | 'warn' | 'error';

const ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  info: 10,
  warn: 20,
  error: 30,
};

const configuredLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase();

function shouldWrite(level: keyof typeof ORDER): boolean {
  if (configuredLevel === 'silent') {
    return false;
  }
  if (!(configuredLevel in ORDER)) {
    return true;
  }
  return ORDER[level] >= ORDER[configuredLevel as keyof typeof ORDER];
}

function write(level: keyof typeof ORDER, message: string, data?: Record<string, unknown>): void {
  if (!shouldWrite(level)) {
    return;
  }

  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(data ? { data } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export function info(message: string, data?: Record<string, unknown>): void {
  write('info', message, data);
}

export function warn(message: string, data?: Record<string, unknown>): void {
  write('warn', message, data);
}

export function error(message: string, data?: Record<string, unknown>): void {
  write('error', message, data);
}

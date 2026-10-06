import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Structured JSON logging. Secrets are redacted by path wherever they could
 * appear (config objects, request headers, error details).
 */
export const REDACT_PATHS = [
  'API_TOKEN',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'NOTIFY_WEBHOOK_URL',
  '*.API_TOKEN',
  '*.GITHUB_TOKEN',
  '*.ANTHROPIC_API_KEY',
  '*.NOTIFY_WEBHOOK_URL',
  'req.headers.authorization',
  'headers.authorization',
  'authorization',
  '*.authorization',
  '*.apiKey',
  '*.secret',
  '*.password',
];

export function createLogger(opts: { name: string; level?: string; pretty?: boolean } & Partial<LoggerOptions>): Logger {
  const { name, level, pretty, ...rest } = opts;
  return pino({
    name,
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: name },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
    ...rest,
  });
}

/** A logger that discards everything; for tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

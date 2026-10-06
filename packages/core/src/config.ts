import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Configuration comes only from the environment. Nothing secret has a default,
 * nothing that can move money defaults to "on". Invalid configuration is a
 * startup error, not a warning.
 */

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean, got "${v}"` });
      return z.NEVER;
    });

const num = (def: number, opts: { min?: number; max?: number; int?: boolean } = {}) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: 'custom', message: `expected a number, got "${v}"` });
        return z.NEVER;
      }
      if (opts.int && !Number.isInteger(n)) {
        ctx.addIssue({ code: 'custom', message: `expected an integer, got "${v}"` });
        return z.NEVER;
      }
      if (opts.min !== undefined && n < opts.min) {
        ctx.addIssue({ code: 'custom', message: `must be >= ${opts.min}` });
        return z.NEVER;
      }
      if (opts.max !== undefined && n > opts.max) {
        ctx.addIssue({ code: 'custom', message: `must be <= ${opts.max}` });
        return z.NEVER;
      }
      return n;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

export const LIVE_CONFIRMATION_PHRASE = 'I_UNDERSTAND_REAL_MONEY_RISK';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (postgres://… or pglite://<dir> or memory://)')
    .refine((v) => /^(postgres(ql)?:\/\/|pglite:\/\/|memory:\/\/)/.test(v), 'DATABASE_URL must start with postgres://, pglite:// or memory://'),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: num(4000, { min: 1, max: 65535, int: true }),
  API_TOKEN: optionalString,
  API_RATE_LIMIT_PER_MINUTE: num(600, { min: 10, int: true }),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  // ---- Safety: live trading is off unless every one of these is set. ----
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  LIVE_TRADING_ENABLED: bool(false),
  LIVE_CONFIRMATION: z.string().default(''),
  LIVE_CAPITAL_CAP_USD: num(0, { min: 0 }),

  // ---- Paper money ----
  PAPER_TOTAL_CAPITAL_USD: num(10_000, { min: 0 }),
  PAPER_DEFAULT_ALLOCATION_USD: num(1_000, { min: 0 }),
  /** Budget pool for simulated business operations (kept apart from the trading paper fund). */
  BUSINESS_SIM_BUDGET_USD: num(20_000, { min: 0 }),
  PAPER_TICK_SECONDS: num(60, { min: 5, int: true }),
  BUSINESS_PAPER_DAYS_PER_TICK: num(1, { min: 1, max: 30, int: true }),

  // ---- Data ----
  MARKET_DATA_ENABLED: bool(true),
  MARKET_DATA_WEBSOCKETS: bool(true),
  DATA_STALE_AFTER_MS: num(120_000, { min: 1_000, int: true }),
  HTTP_TIMEOUT_MS: num(10_000, { min: 500, int: true }),

  // ---- Research ----
  RESEARCH_MONITOR_ENABLED: bool(true),
  GITHUB_TOKEN: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  IDEA_GENERATOR_LLM_ENABLED: bool(false),
  LLM_MODEL: z.string().default('claude-opus-5-5'),

  // ---- Workers ----
  SCHEDULER_ENABLED: bool(true),
  EMBEDDED_WORKER: bool(false),
  WORKER_CONCURRENCY: num(2, { min: 1, max: 16, int: true }),
  WORKER_POLL_MS: num(1_000, { min: 100, int: true }),
  JOB_LEASE_MS: num(5 * 60_000, { min: 5_000, int: true }),

  // ---- Notifications ----
  NOTIFY_WEBHOOK_URL: optionalString,
  NOTIFY_WEBHOOK_FORMAT: z.enum(['generic', 'slack', 'discord']).default('generic'),
});

export type AppConfig = z.output<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ValidationError(`Invalid configuration:\n  ${issues.join('\n  ')}`, { issues });
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && (!cfg.API_TOKEN || cfg.API_TOKEN.length < 24)) {
    throw new ValidationError('API_TOKEN (>= 24 characters) is required when NODE_ENV=production');
  }
  if (cfg.API_TOKEN !== undefined && cfg.API_TOKEN.length < 16) {
    throw new ValidationError('API_TOKEN must be at least 16 characters');
  }
  return cfg;
}

const SECRET_KEYS = ['API_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'NOTIFY_WEBHOOK_URL', 'DATABASE_URL'] as const;

/** Configuration safe to display: secrets replaced, credentials in URLs masked. */
export function redactConfig(cfg: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  for (const key of SECRET_KEYS) {
    const v = out[key];
    if (v === undefined || v === '') continue;
    if (key === 'DATABASE_URL' && typeof v === 'string') {
      out[key] = v.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');
    } else {
      out[key] = '***set***';
    }
  }
  return out;
}

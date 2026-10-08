import { ExternalApiError, describeError } from '@aoc/core';
import type { z } from 'zod';
import { TokenBucket } from './ratelimit';

export interface RequestInfo {
  source: string;
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: ExternalApiError;
}

export interface HttpClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  /** Requests to any other host are refused (no SSRF through configurable URLs). */
  allowedHosts: readonly string[];
  /** Per-host buckets: capacity and refill per second. */
  rateLimits?: Record<string, { capacity: number; refillPerSecond: number }>;
  maxBodyBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  onRequest?: (info: RequestInfo) => void;
}

export interface RequestOptions {
  source: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Token cost for venues with weighted limits (e.g. Binance). */
  weight?: number;
  /** Return the body as text instead of parsing JSON (e.g. Atom XML). */
  raw?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The only way platform code talks to the internet. Every response is
 * validated against a schema; nothing malformed gets past this boundary.
 */
export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    for (const [host, cfg] of Object.entries(opts.rateLimits ?? {})) {
      this.buckets.set(host, new TokenBucket(cfg.capacity, cfg.refillPerSecond, Date.now, this.sleep));
    }
  }

  async json<S extends z.ZodTypeAny>(url: string, schema: S, ro: RequestOptions): Promise<z.output<S>> {
    const raw = await this.request(url, ro);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const err = new ExternalApiError('MALFORMED', `${ro.source}: response did not match the expected schema (${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'})`, { source: ro.source });
      this.opts.onRequest?.({ source: ro.source, url: redact(url), ok: false, status: 200, latencyMs: 0, error: err });
      throw err;
    }
    return parsed.data;
  }

  async request(rawUrl: string, ro: RequestOptions): Promise<unknown> {
    const url = new URL(rawUrl);
    for (const [k, v] of Object.entries(ro.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ExternalApiError('BLOCKED', `protocol ${url.protocol} not allowed`, { source: ro.source });
    if (!this.opts.allowedHosts.includes(url.hostname)) {
      throw new ExternalApiError('BLOCKED', `host ${url.hostname} is not on the outbound allowlist`, { source: ro.source });
    }
    const retries = this.opts.retries ?? 2;
    let attempt = 0;
    for (;;) {
      const bucket = this.buckets.get(url.hostname);
      if (bucket) await bucket.take(ro.weight ?? 1);
      const started = performance.now();
      try {
        const res = await this.fetchImpl(url, {
          method: ro.method ?? 'GET',
          headers: { accept: ro.raw ? '*/*' : 'application/json', 'user-agent': this.opts.userAgent ?? 'automated-opportunity-center/0.1 (paper-only research)', ...(ro.body !== undefined ? { 'content-type': 'application/json' } : {}), ...ro.headers },
          body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
          redirect: 'error',
        });
        const latencyMs = Math.round(performance.now() - started);
        if (!res.ok) {
          const err = classifyStatus(res, ro.source, await safeText(res));
          this.opts.onRequest?.({ source: ro.source, url: redact(url.toString()), ok: false, status: res.status, latencyMs, error: err });
          // Waiting longer than MAX_RETRY_WAIT_MS would stall the caller: fail now, the caller decides.
          if (err.retryable && attempt < retries && (err.retryAfterMs ?? 0) <= MAX_RETRY_WAIT_MS) {
            attempt++;
            await this.sleep(backoff(attempt, err.retryAfterMs));
            continue;
          }
          throw err;
        }
        const text = await res.text();
        if (text.length > (this.opts.maxBodyBytes ?? 20_000_000)) throw new ExternalApiError('MALFORMED', `${ro.source}: response too large (${text.length} bytes)`, { source: ro.source });
        if (ro.raw) {
          this.opts.onRequest?.({ source: ro.source, url: redact(url.toString()), ok: true, status: res.status, latencyMs });
          return text;
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch (cause) {
          throw new ExternalApiError('MALFORMED', `${ro.source}: response is not JSON`, { source: ro.source, status: res.status, cause });
        }
        this.opts.onRequest?.({ source: ro.source, url: redact(url.toString()), ok: true, status: res.status, latencyMs });
        return body;
      } catch (e) {
        if (e instanceof ExternalApiError) {
          if (e.kind === 'MALFORMED') this.opts.onRequest?.({ source: ro.source, url: redact(url.toString()), ok: false, status: e.status ?? null, latencyMs: Math.round(performance.now() - started), error: e });
          throw e;
        }
        const err = classifyThrown(e, ro.source);
        this.opts.onRequest?.({ source: ro.source, url: redact(url.toString()), ok: false, status: null, latencyMs: Math.round(performance.now() - started), error: err });
        if (err.retryable && attempt < retries) {
          attempt++;
          await this.sleep(backoff(attempt));
          continue;
        }
        throw err;
      }
    }
  }
}

/** Longest server-requested wait the client sleeps through before retrying. */
const MAX_RETRY_WAIT_MS = 30_000;

function backoff(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(MAX_RETRY_WAIT_MS, retryAfterMs);
  return Math.min(10_000, 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
}

function classifyStatus(res: Response, source: string, body: string): ExternalApiError {
  const ra = res.headers.get('retry-after');
  const remainingZero = res.headers.get('x-ratelimit-remaining') === '0';
  // Retry-After in seconds, else (quota used up) the reset time in epoch seconds, as GitHub sends it.
  const retryAfterMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : remainingZero ? untilReset(res.headers.get('x-ratelimit-reset')) : undefined;
  // GitHub answers an exhausted quota with 403 (not 429).
  const quotaExhausted = res.status === 403 && (remainingZero || /rate limit/i.test(body));
  if (res.status === 429 || res.status === 418 || quotaExhausted) {
    const when = retryAfterMs !== undefined ? `; retry in ${Math.ceil(retryAfterMs / 1000)} s` : '';
    return new ExternalApiError('RATE_LIMITED', `${source}: rate limited (HTTP ${res.status}${when})`, { status: res.status, retryAfterMs, source });
  }
  if (res.status === 451 || (res.status === 403 && /restrict|forbidden|location|blocked/i.test(body))) {
    return new ExternalApiError('BLOCKED', `${source}: access refused (HTTP ${res.status}); the service may be unavailable from this location`, { status: res.status, source });
  }
  return new ExternalApiError('HTTP', `${source}: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`, { status: res.status, source });
}

/**
 * Wait until an epoch-seconds reset, plus a second for its whole-second
 * rounding. A reset in the past or more than an hour away is not trusted
 * (clock skew or a different format): undefined means normal backoff.
 */
function untilReset(reset: string | null): number | undefined {
  if (!reset || !/^\d+$/.test(reset)) return undefined;
  const ms = Number(reset) * 1000 - Date.now() + 1000;
  return ms > 1000 && ms <= 3_600_000 ? ms : undefined;
}

function classifyThrown(e: unknown, source: string): ExternalApiError {
  const name = (e as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ExternalApiError('TIMEOUT', `${source}: request timed out`, { source, cause: e });
  return new ExternalApiError('NETWORK', `${source}: network error (${describeError(e).message})`, { source, cause: e });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/** Never log query strings that might carry credentials. */
function redact(url: string): string {
  return url.replace(/([?&](?:api_?key|token|signature|secret)=)[^&]+/gi, '$1***');
}

/**
 * Error taxonomy. Every error that crosses a module boundary is one of these,
 * so callers can decide between retrying, degrading and stopping without
 * string-matching messages. Nothing is swallowed silently: code that catches
 * an AocError either rethrows it, records it (system_events / audit_logs), or
 * converts it into an explicit state such as DEGRADED.
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_TRANSITION'
  | 'RISK_LIMIT'
  | 'EMERGENCY_STOP'
  | 'LIVE_TRADING_DISABLED'
  | 'DATA_UNAVAILABLE'
  | 'STALE_DATA'
  | 'EXTERNAL_API'
  | 'DUPLICATE'
  | 'UNAUTHORIZED'
  | 'INTERNAL';

export class AocError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  /** Whether retrying the same operation later may succeed. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export class ValidationError extends AocError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION', message, { details });
  }
}

export class NotFoundError extends AocError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} not found: ${id}`, { details: { entity, id } });
  }
}

export class ConflictError extends AocError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, { details, retryable: true });
  }
}

export class DuplicateError extends AocError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('DUPLICATE', message, { details });
  }
}

export class InvalidTransitionError extends AocError {
  constructor(from: string, to: string, reason?: string) {
    super('INVALID_TRANSITION', `Transition ${from} → ${to} is not allowed${reason ? `: ${reason}` : ''}`, {
      details: { from, to, reason },
    });
  }
}

export class RiskLimitError extends AocError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('RISK_LIMIT', message, { details });
  }
}

export class EmergencyStopError extends AocError {
  constructor(message = 'Emergency stop is engaged; no automated action may run') {
    super('EMERGENCY_STOP', message);
  }
}

export class LiveTradingDisabledError extends AocError {
  constructor(reasons: string[]) {
    super('LIVE_TRADING_DISABLED', `Live trading is disabled: ${reasons.join('; ')}`, { details: { reasons } });
  }
}

export class DataUnavailableError extends AocError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('DATA_UNAVAILABLE', message, { details, retryable: true });
  }
}

export class StaleDataError extends AocError {
  constructor(source: string, ageMs: number, maxAgeMs: number) {
    super('STALE_DATA', `Data from ${source} is stale (${Math.round(ageMs)}ms > ${maxAgeMs}ms)`, {
      details: { source, ageMs, maxAgeMs },
      retryable: true,
    });
  }
}

export type ExternalApiErrorKind = 'TIMEOUT' | 'NETWORK' | 'RATE_LIMITED' | 'HTTP' | 'MALFORMED' | 'BLOCKED';

export class ExternalApiError extends AocError {
  readonly kind: ExternalApiErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: ExternalApiErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; source?: string; cause?: unknown } = {},
  ) {
    const retryable = kind === 'TIMEOUT' || kind === 'NETWORK' || kind === 'RATE_LIMITED' || (kind === 'HTTP' && (opts.status ?? 0) >= 500);
    super('EXTERNAL_API', message, {
      details: { kind, status: opts.status, source: opts.source, retryAfterMs: opts.retryAfterMs },
      retryable,
      cause: opts.cause,
    });
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class UnauthorizedError extends AocError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', message);
  }
}

/** Normalise anything thrown into a message without losing the original. */
export function describeError(err: unknown): { message: string; code: ErrorCode; name: string } {
  if (err instanceof AocError) return { message: err.message, code: err.code, name: err.name };
  if (err instanceof Error) return { message: err.message, code: 'INTERNAL', name: err.name };
  return { message: String(err), code: 'INTERNAL', name: 'UnknownError' };
}

export function isRetryable(err: unknown): boolean {
  return err instanceof AocError ? err.retryable : false;
}

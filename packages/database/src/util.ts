/**
 * Postgres error helpers. node-postgres and PGlite both surface the SQLSTATE
 * as `code`; drizzle may wrap the driver error in `cause`.
 */
export function pgErrorCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_RESTRICT_VIOLATION = '23001';
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK = '40P01';

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}

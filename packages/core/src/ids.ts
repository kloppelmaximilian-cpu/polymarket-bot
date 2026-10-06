import { createHash, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/** Stable short hash for dedupe keys and dataset checksums. */
export function stableHash(input: unknown, length = 16): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, length);
}

/** JSON.stringify with sorted object keys, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Normalise free text for duplicate detection ("AI  Lead-Gen!" → "ai lead gen"). */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

import type { DataHealth } from '@aoc/core';

export interface SourceHealthState {
  id: string;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  successCount: number;
  errorCount: number;
  malformedCount: number;
  staleAfterMs: number;
}

/**
 * Status of a data source at time `now`:
 *   CONNECTED  recent success and no current failure streak
 *   DEGRADED   still delivering, but with recent failures, malformed
 *              payloads or high latency
 *   STALE      the last good data is older than `staleAfterMs`
 *   OFFLINE    never delivered, or failing repeatedly with nothing fresh
 */
export function deriveHealth(s: SourceHealthState, now: number, opts: { offlineAfterFailures?: number; slowMs?: number } = {}): DataHealth {
  const offlineAfter = opts.offlineAfterFailures ?? 3;
  const slow = opts.slowMs ?? 5_000;
  if (s.lastSuccessAt === null) return 'OFFLINE';
  const age = now - s.lastSuccessAt;
  const fresh = age <= s.staleAfterMs;
  if (!fresh) return s.consecutiveFailures >= offlineAfter ? 'OFFLINE' : 'STALE';
  if (s.consecutiveFailures > 0) return 'DEGRADED';
  if (s.latencyMs !== null && s.latencyMs > slow) return 'DEGRADED';
  if (s.lastErrorAt !== null && now - s.lastErrorAt < s.staleAfterMs && s.malformedCount > 0) return 'DEGRADED';
  return 'CONNECTED';
}

export class HealthTracker {
  private readonly sources = new Map<string, SourceHealthState>();

  constructor(private readonly defaultStaleAfterMs: number) {}

  private get(id: string): SourceHealthState {
    let s = this.sources.get(id);
    if (!s) {
      s = { id, lastSuccessAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, latencyMs: null, successCount: 0, errorCount: 0, malformedCount: 0, staleAfterMs: this.defaultStaleAfterMs };
      this.sources.set(id, s);
    }
    return s;
  }

  configure(id: string, staleAfterMs: number): void {
    this.get(id).staleAfterMs = staleAfterMs;
  }

  success(id: string, at: number, latencyMs: number): void {
    const s = this.get(id);
    s.lastSuccessAt = at;
    s.consecutiveFailures = 0;
    s.latencyMs = latencyMs;
    s.successCount++;
  }

  failure(id: string, at: number, message: string, malformed = false): void {
    const s = this.get(id);
    s.lastErrorAt = at;
    s.lastError = message;
    s.consecutiveFailures++;
    s.errorCount++;
    if (malformed) s.malformedCount++;
  }

  state(id: string): SourceHealthState {
    return { ...this.get(id) };
  }

  status(id: string, now: number): DataHealth {
    return deriveHealth(this.get(id), now);
  }

  all(now: number): Array<SourceHealthState & { status: DataHealth }> {
    return [...this.sources.values()].map((s) => ({ ...s, status: deriveHealth(s, now) }));
  }
}

/** Throw-free staleness check for a single timestamped datum. */
export function isStale(receivedAt: number, now: number, maxAgeMs: number): boolean {
  return now - receivedAt > maxAgeMs;
}

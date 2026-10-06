/**
 * The only source of "now". Engines take a Clock so that tests and
 * simulations control time explicitly.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string | number = '2026-01-01T00:00:00Z') {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(t: Date | string | number): void {
    this.t = new Date(t).getTime();
  }
  advance(ms: number): Date {
    this.t += ms;
    return this.now();
  }
}

/** UTC calendar day key, e.g. "2026-10-06". Risk "daily" limits use UTC days. */
export function utcDayKey(t: Date): string {
  return t.toISOString().slice(0, 10);
}

export function startOfUtcDay(t: Date): Date {
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

export const MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

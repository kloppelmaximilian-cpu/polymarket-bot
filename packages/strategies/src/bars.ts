import { AocError, type Bar } from '@aoc/core';

export class LookAheadError extends AocError {
  constructor(index: number, cursor: number) {
    super('INTERNAL', `look-ahead: bar ${index} requested while the current bar is ${cursor}`, { details: { index, cursor } });
  }
}

/**
 * A view on a bar array that only exposes bars up to and including the
 * cursor. Strategies receive this, never the raw array, so a strategy cannot
 * read the future even by accident. The backtester advances the cursor.
 */
export class BarSeries {
  private cursor: number;

  constructor(
    private readonly bars: readonly Bar[],
    cursor = bars.length - 1,
  ) {
    validateBars(bars);
    this.cursor = Math.min(cursor, bars.length - 1);
  }

  /** Number of visible bars. */
  get length(): number {
    return this.cursor + 1;
  }

  get currentIndex(): number {
    return this.cursor;
  }

  /** Advance the visible window (backtester only). */
  setCursor(i: number): void {
    if (i < -1 || i >= this.bars.length) throw new RangeError(`cursor ${i} out of range`);
    this.cursor = i;
  }

  at(i: number): Bar {
    if (i > this.cursor) throw new LookAheadError(i, this.cursor);
    if (i < 0) throw new RangeError(`bar index ${i} < 0`);
    return this.bars[i] as Bar;
  }

  /** The latest visible bar. */
  last(): Bar {
    if (this.cursor < 0) throw new RangeError('no bars visible');
    return this.bars[this.cursor] as Bar;
  }

  /** Bars ago: 0 = current, 1 = previous. */
  ago(n: number): Bar | undefined {
    const i = this.cursor - n;
    return i >= 0 ? (this.bars[i] as Bar) : undefined;
  }

  /** The last `n` visible bars (fewer if not available), oldest first. */
  window(n: number): Bar[] {
    const start = Math.max(0, this.cursor - n + 1);
    return this.bars.slice(start, this.cursor + 1) as Bar[];
  }

  closes(n: number): number[] {
    return this.window(n).map((b) => b.close);
  }
}

/** Reject data that would silently corrupt a backtest. */
export function validateBars(bars: readonly Bar[]): void {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] as Bar;
    const vals = [b.open, b.high, b.low, b.close, b.volume, b.ts];
    if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new AocError('VALIDATION', `bar ${i} has a non-finite field`);
    if (b.low > b.high || b.open > b.high || b.open < b.low || b.close > b.high || b.close < b.low) {
      throw new AocError('VALIDATION', `bar ${i} has inconsistent OHLC (o=${b.open} h=${b.high} l=${b.low} c=${b.close})`);
    }
    if (b.low <= 0) throw new AocError('VALIDATION', `bar ${i} has a non-positive price`);
    if (b.volume < 0) throw new AocError('VALIDATION', `bar ${i} has negative volume`);
    if (i > 0 && b.ts <= (bars[i - 1] as Bar).ts) throw new AocError('VALIDATION', `bars are not strictly increasing in time at ${i}`);
  }
}

/** Typical interval between bars, in ms (median of the first diffs). */
export function inferIntervalMs(bars: readonly Bar[]): number {
  if (bars.length < 2) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(bars.length, 200); i++) diffs.push((bars[i] as Bar).ts - (bars[i - 1] as Bar).ts);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] as number;
}

/** Find gaps larger than `factor` × the typical interval. */
export function findGaps(bars: readonly Bar[], factor = 1.5): Array<{ afterTs: number; missingMs: number }> {
  const iv = inferIntervalMs(bars);
  if (iv === 0) return [];
  const gaps: Array<{ afterTs: number; missingMs: number }> = [];
  for (let i = 1; i < bars.length; i++) {
    const d = (bars[i] as Bar).ts - (bars[i - 1] as Bar).ts;
    if (d > iv * factor) gaps.push({ afterTs: (bars[i - 1] as Bar).ts, missingMs: d - iv });
  }
  return gaps;
}

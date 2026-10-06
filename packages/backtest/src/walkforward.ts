import type { Bar } from '@aoc/core';
import type { BacktestResult, EquityPoint, TradeRecord } from '@aoc/strategies';
import { computeMetrics } from './metrics';

export interface Fold {
  index: number;
  startTs: number;
  endTs: number;
}

/**
 * Split [firstTradableTs, lastTs] into `k` contiguous, non-overlapping test
 * folds. Every fold may use all data *before* its start for warm-up or
 * fitting, never data after it.
 */
export function makeFolds(bars: readonly Bar[], warmupBars: number, k: number): Fold[] {
  if (k < 1) throw new RangeError('k must be >= 1');
  const usable = bars.slice(warmupBars);
  if (usable.length < k * 2) return [];
  const size = Math.floor(usable.length / k);
  const folds: Fold[] = [];
  for (let i = 0; i < k; i++) {
    const start = usable[i * size] as Bar;
    const endBar = i === k - 1 ? undefined : (usable[(i + 1) * size] as Bar);
    folds.push({ index: i, startTs: start.ts, endTs: endBar ? endBar.ts : (usable[usable.length - 1] as Bar).ts + 1 });
  }
  return folds;
}

/** Index of the first bar at or after the train/test boundary. */
export function trainTestBoundary(bars: readonly Bar[], warmupBars: number, trainFraction: number): number {
  if (!(trainFraction > 0 && trainFraction < 1)) throw new RangeError('trainFraction must be in (0, 1)');
  const usable = bars.length - warmupBars;
  const i = warmupBars + Math.floor(usable * trainFraction);
  const b = bars[Math.min(i, bars.length - 1)] as Bar;
  return b.ts;
}

export interface WalkForwardResult {
  folds: Array<{ fold: Fold; result: BacktestResult; chosenParams?: Record<string, unknown> }>;
  /** Out-of-sample equity stitched across folds (each fold restarts from the previous fold's end). */
  oosEquity: EquityPoint[];
  oosTrades: TradeRecord[];
  oosMetrics: ReturnType<typeof computeMetrics>;
  profitableFolds: number;
}

/** Stitch fold results into one out-of-sample record. */
export function stitchFolds(folds: WalkForwardResult['folds'], initialCapital: number, periodMs: number): WalkForwardResult {
  const oosEquity: EquityPoint[] = [];
  const oosTrades: TradeRecord[] = [];
  let scale = 1;
  let profitable = 0;
  for (const f of folds) {
    const r = f.result;
    const base = r.initialCapital;
    for (const p of r.equityCurve) oosEquity.push({ ts: p.ts, equity: (p.equity / base) * initialCapital * scale });
    const last = r.equityCurve[r.equityCurve.length - 1];
    if (last) scale *= last.equity / base;
    oosTrades.push(...r.trades);
    if (r.metrics.netProfit > 0) profitable++;
  }
  return {
    folds,
    oosEquity,
    oosTrades,
    oosMetrics: computeMetrics({ equityCurve: oosEquity, trades: oosTrades, initialCapital, periodMs }),
    profitableFolds: profitable,
  };
}

import { Rng, quantile } from '@aoc/core';
import type { TradeRecord } from '@aoc/strategies';

export interface MonteCarloSummary {
  method: 'trade_bootstrap' | 'block_bootstrap';
  paths: number;
  sampleSize: number;
  totalReturnP5: number;
  totalReturnP50: number;
  totalReturnP95: number;
  probLoss: number;
  maxDrawdownP50: number;
  maxDrawdownP95: number;
  /** Probability that the drawdown exceeds `drawdownLimit`. */
  probDrawdownBeyondLimit: number;
  drawdownLimit: number;
}

/**
 * Resample the realised trades (with replacement, in random order) to see how
 * much of the result is sequence luck. Each path is a sum of trade P&L
 * relative to the initial capital (no compounding — conservative and
 * independent of position sizing assumptions).
 */
export function bootstrapTrades(trades: readonly TradeRecord[], initialCapital: number, opts: { paths?: number; seed: string; drawdownLimit: number }): MonteCarloSummary | null {
  if (trades.length < 5 || !(initialCapital > 0)) return null;
  const pnl = trades.map((t) => t.netPnl);
  return summarise('trade_bootstrap', pnl, initialCapital, opts, (rng) => pnl.map(() => pnl[Math.floor(rng.next() * pnl.length)] as number));
}

/**
 * Stationary block bootstrap of period returns (Politis & Romano), which
 * keeps short-range autocorrelation. Used when there are many periods but
 * few discrete trades (e.g. carry strategies).
 */
export function blockBootstrapReturns(returns: readonly number[], initialCapital: number, opts: { paths?: number; seed: string; drawdownLimit: number; meanBlock?: number }): MonteCarloSummary | null {
  if (returns.length < 20) return null;
  const p = 1 / Math.max(1, opts.meanBlock ?? 10);
  const n = returns.length;
  // Convert compounding returns into P&L increments on a fixed base for comparability.
  return summarise('block_bootstrap', returns as number[], initialCapital, opts, (rng) => {
    const out: number[] = [];
    let i = Math.floor(rng.next() * n);
    let eq = initialCapital;
    while (out.length < n) {
      const r = returns[i] as number;
      const next = eq * (1 + r);
      out.push(next - eq);
      eq = next;
      i = rng.next() < p ? Math.floor(rng.next() * n) : (i + 1) % n;
    }
    return out;
  });
}

function summarise(
  method: MonteCarloSummary['method'],
  sample: number[],
  initialCapital: number,
  opts: { paths?: number; seed: string; drawdownLimit: number },
  draw: (rng: Rng) => number[],
): MonteCarloSummary {
  const paths = opts.paths ?? 2000;
  const rng = new Rng(`mc/${opts.seed}`);
  const totals: number[] = [];
  const dds: number[] = [];
  for (let k = 0; k < paths; k++) {
    const seq = draw(rng);
    let eq = initialCapital;
    let peak = eq;
    let maxDd = 0;
    for (const x of seq) {
      eq += x;
      if (eq > peak) peak = eq;
      if (peak > 0) maxDd = Math.max(maxDd, (peak - eq) / peak);
    }
    totals.push(eq / initialCapital - 1);
    dds.push(maxDd);
  }
  return {
    method,
    paths,
    sampleSize: sample.length,
    totalReturnP5: quantile(totals, 0.05),
    totalReturnP50: quantile(totals, 0.5),
    totalReturnP95: quantile(totals, 0.95),
    probLoss: totals.filter((t) => t < 0).length / paths,
    maxDrawdownP50: quantile(dds, 0.5),
    maxDrawdownP95: quantile(dds, 0.95),
    probDrawdownBeyondLimit: dds.filter((d) => d > opts.drawdownLimit).length / paths,
    drawdownLimit: opts.drawdownLimit,
  };
}

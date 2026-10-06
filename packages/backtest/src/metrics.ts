import { kurtosis, mean, normCdf, normInv, skewness, stdev } from '@aoc/core';
import type { EquityPoint, PerformanceMetrics, TradeRecord } from '@aoc/strategies';

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const EULER_GAMMA = 0.5772156649015329;

export function periodReturns(curve: readonly EquityPoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = (curve[i - 1] as EquityPoint).equity;
    const cur = (curve[i] as EquityPoint).equity;
    if (prev > 0) r.push(cur / prev - 1);
  }
  return r;
}

export function maxDrawdown(curve: readonly EquityPoint[]): { pct: number; durationMs: number } {
  let peak = Number.NEGATIVE_INFINITY;
  let peakTs = curve[0]?.ts ?? 0;
  let maxDd = 0;
  let maxDur = 0;
  for (const p of curve) {
    if (p.equity >= peak) {
      peak = p.equity;
      peakTs = p.ts;
    } else {
      if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
      maxDur = Math.max(maxDur, p.ts - peakTs);
    }
  }
  return { pct: maxDd, durationMs: maxDur };
}

/**
 * Probabilistic Sharpe Ratio (Bailey & López de Prado, 2012): the probability
 * that the true per-period Sharpe exceeds `benchmark`, given the sample's
 * length, skewness and kurtosis.
 */
export function probabilisticSharpe(sr: number, n: number, skew: number, kurt: number, benchmark = 0): number | null {
  if (!Number.isFinite(sr) || n < 3) return null;
  const g3 = Number.isFinite(skew) ? skew : 0;
  const g4 = Number.isFinite(kurt) ? kurt : 3;
  const denom = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  if (!(denom > 0)) return null;
  return normCdf(((sr - benchmark) * Math.sqrt(n - 1)) / Math.sqrt(denom));
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014): the PSR against the
 * Sharpe you would expect from the best of `trials` unskilled strategies.
 * `trialSharpeVariance` is the variance of the per-period Sharpe ratios of
 * all trials. With one trial this equals PSR(0).
 */
export function deflatedSharpe(sr: number, n: number, skew: number, kurt: number, trials: number, trialSharpeVariance: number): number | null {
  if (trials <= 1 || !(trialSharpeVariance > 0)) return probabilisticSharpe(sr, n, skew, kurt, 0);
  const sr0 = Math.sqrt(trialSharpeVariance) * ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E)));
  return probabilisticSharpe(sr, n, skew, kurt, sr0);
}

export interface MetricsInput {
  equityCurve: readonly EquityPoint[];
  trades: readonly TradeRecord[];
  initialCapital: number;
  periodMs: number;
  /** Fraction of periods with an open position, if known. */
  exposurePct?: number | null;
}

/**
 * Every statistic returns null when it is undefined for the sample (too few
 * trades or periods), so that "no data" is never displayed as zero.
 */
export function computeMetrics(input: MetricsInput): PerformanceMetrics {
  const { equityCurve: curve, trades, initialCapital, periodMs } = input;
  const rets = periodReturns(curve);
  const last = curve.length > 0 ? (curve[curve.length - 1] as EquityPoint).equity : initialCapital;
  const first = curve[0];
  const spanMs = curve.length > 1 && first ? (curve[curve.length - 1] as EquityPoint).ts - first.ts : 0;
  const totalReturn = initialCapital > 0 ? last / initialCapital - 1 : null;
  const annualized = totalReturn !== null && spanMs >= 7 * 24 * 3600 * 1000 && last > 0 ? Math.pow(last / initialCapital, YEAR_MS / spanMs) - 1 : null;

  const enough = rets.length >= 10;
  const m = mean(rets);
  const sd = stdev(rets);
  const perYear = periodMs > 0 ? YEAR_MS / periodMs : NaN;
  const srPeriod = enough && sd > 0 ? m / sd : NaN;
  const sharpe = Number.isFinite(srPeriod) && Number.isFinite(perYear) ? srPeriod * Math.sqrt(perYear) : null;
  const downside = rets.filter((r) => r < 0);
  const dd = downside.length >= 2 ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / rets.length) : NaN;
  const sortino = enough && dd > 0 && Number.isFinite(perYear) ? (m / dd) * Math.sqrt(perYear) : null;
  const psr = enough ? probabilisticSharpe(srPeriod, rets.length, skewness(rets), kurtosis(rets)) : null;

  const pnl = trades.map((t) => t.netPnl);
  const wins = pnl.filter((x) => x > 0);
  const losses = pnl.filter((x) => x < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = losses.reduce((a, b) => a + b, 0);
  const tsd = stdev(pnl);
  const mdd = maxDrawdown(curve);

  return {
    trades: trades.length,
    winRate: trades.length > 0 ? wins.length / trades.length : null,
    totalReturnPct: totalReturn,
    annualizedReturnPct: annualized,
    netProfit: last - initialCapital,
    grossProfit,
    grossLoss,
    profitFactor: trades.length > 0 && grossLoss < 0 ? grossProfit / -grossLoss : null,
    expectancy: trades.length > 0 ? mean(pnl) : null,
    avgTradeReturnPct: trades.length > 0 ? mean(trades.map((t) => t.returnPct)) : null,
    sharpe,
    sortino,
    maxDrawdownPct: mdd.pct,
    maxDrawdownDurationMs: mdd.durationMs,
    exposurePct: input.exposurePct ?? null,
    fees: trades.reduce((a, t) => a + t.fees, 0),
    slippage: trades.reduce((a, t) => a + t.slippage, 0),
    carry: trades.reduce((a, t) => a + t.carry, 0),
    tStat: trades.length >= 5 && tsd > 0 ? mean(pnl) / (tsd / Math.sqrt(trades.length)) : null,
    psr,
    periods: rets.length,
    periodMs,
  };
}

/** Per-period Sharpe of an equity curve (not annualised), for DSR across trials. */
export function periodSharpe(curve: readonly EquityPoint[]): number {
  const r = periodReturns(curve);
  const sd = stdev(r);
  return r.length >= 10 && sd > 0 ? mean(r) / sd : NaN;
}

export function emptyMetrics(periodMs: number): PerformanceMetrics {
  return computeMetrics({ equityCurve: [], trades: [], initialCapital: 0, periodMs });
}

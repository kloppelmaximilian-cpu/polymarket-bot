import type { Bar } from '@aoc/core';
import { mean, stdev } from '@aoc/core';

/*
 * Causal indicators: each takes the visible window (oldest first) and returns
 * the value at the last element. NaN means "not enough data" and strategies
 * must treat it as no signal.
 */

export function sma(values: readonly number[], n: number): number {
  if (values.length < n || n <= 0) return NaN;
  return mean(values.slice(values.length - n));
}

export function ema(values: readonly number[], n: number): number {
  if (values.length < n || n <= 0) return NaN;
  const k = 2 / (n + 1);
  let e = mean(values.slice(0, n));
  for (let i = n; i < values.length; i++) e = (values[i] as number) * k + e * (1 - k);
  return e;
}

export function rollingStd(values: readonly number[], n: number): number {
  if (values.length < n || n < 2) return NaN;
  return stdev(values.slice(values.length - n));
}

/** z-score of the last value against the trailing n-window. */
export function zScore(values: readonly number[], n: number): number {
  const m = sma(values, n);
  const s = rollingStd(values, n);
  if (!Number.isFinite(m) || !Number.isFinite(s) || s === 0) return NaN;
  return ((values[values.length - 1] as number) - m) / s;
}

/** Simple return over n periods. */
export function rateOfChange(values: readonly number[], n: number): number {
  if (values.length <= n) return NaN;
  const past = values[values.length - 1 - n] as number;
  return past > 0 ? (values[values.length - 1] as number) / past - 1 : NaN;
}

export function trueRange(cur: Bar, prev: Bar | undefined): number {
  if (!prev) return cur.high - cur.low;
  return Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
}

/** Average true range (simple average of the last n true ranges). */
export function atr(bars: readonly Bar[], n: number): number {
  if (bars.length < n + 1) return NaN;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) s += trueRange(bars[i] as Bar, bars[i - 1]);
  return s / n;
}

/** Highest high / lowest low of the n bars *before* the current one. */
export function donchian(bars: readonly Bar[], n: number): { upper: number; lower: number } {
  if (bars.length < n + 1) return { upper: NaN, lower: NaN };
  const prior = bars.slice(bars.length - 1 - n, bars.length - 1);
  return { upper: Math.max(...prior.map((b) => b.high)), lower: Math.min(...prior.map((b) => b.low)) };
}

/** Log returns of a price series. */
export function logReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) out.push(Math.log((values[i] as number) / (values[i - 1] as number)));
  return out;
}

/** Realised volatility (stdev of log returns) over the last n returns. */
export function realizedVol(values: readonly number[], n: number): number {
  if (values.length < n + 1) return NaN;
  return stdev(logReturns(values.slice(values.length - n - 1)));
}

/** Percentile rank (0..1) of the last value within the trailing n values. */
export function percentileRank(values: readonly number[], n: number): number {
  if (values.length < n) return NaN;
  const w = values.slice(values.length - n);
  const last = w[w.length - 1] as number;
  let below = 0;
  for (const v of w) if (v < last) below++;
  return below / (w.length - 1 || 1);
}

export function rsi(values: readonly number[], n: number): number {
  if (values.length < n + 1) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - n; i < values.length; i++) {
    const d = (values[i] as number) - (values[i - 1] as number);
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / n / (loss / n);
  return 100 - 100 / (1 + rs);
}

import { BarSeries, LookAheadError, findGaps, validateBars, type TradeRecord, type EquityPoint } from '@aoc/strategies';
import { describe, expect, it } from 'vitest';
import { computeMetrics, deflatedSharpe, maxDrawdown, probabilisticSharpe, syntheticBars } from '../src';

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const walk = (seed: string, n = 1500, regime: 'random_walk' | 'regime_switching' = 'random_walk') =>
  syntheticBars({ seed, bars: n, intervalMs: H, startTs: T0, startPrice: 60_000, vol: 0.006, regime, avgVolume: 500 });

describe('bar series', () => {
  it('refuses to show the future', () => {
    const s = new BarSeries(walk('a', 50), 10);
    expect(s.length).toBe(11);
    expect(() => s.at(11)).toThrow(LookAheadError);
    expect(s.window(5)).toHaveLength(5);
    expect(s.window(5)[4]).toEqual(s.last());
  });
  it('rejects corrupt bars', () => {
    const bars = walk('b', 10);
    expect(() => validateBars([...bars.slice(0, 5), { ...bars[5]!, high: bars[5]!.low - 1 }])).toThrow();
    expect(() => validateBars([bars[1]!, bars[0]!])).toThrow(/strictly increasing/);
    expect(() => validateBars([{ ...bars[0]!, close: Number.NaN }])).toThrow(/non-finite/);
  });
  it('finds gaps', () => {
    const bars = walk('c', 20);
    const gapped = [...bars.slice(0, 10), ...bars.slice(13)];
    expect(findGaps(gapped)).toHaveLength(1);
  });
});

describe('metrics', () => {
  const curve = (xs: number[]): EquityPoint[] => xs.map((equity, i) => ({ ts: T0 + i * H, equity }));

  it('computes max drawdown and its duration', () => {
    const dd = maxDrawdown(curve([100, 120, 90, 110, 130, 65, 70]));
    expect(dd.pct).toBeCloseTo(0.5, 12);
    expect(dd.durationMs).toBe(2 * H);
  });

  it('reports null — not zero — when statistics are undefined', () => {
    const m = computeMetrics({ equityCurve: curve([100, 101]), trades: [], initialCapital: 100, periodMs: H });
    expect(m.sharpe).toBeNull();
    expect(m.winRate).toBeNull();
    expect(m.profitFactor).toBeNull();
    expect(m.expectancy).toBeNull();
  });

  it('computes trade statistics', () => {
    const t = (net: number): TradeRecord => ({ id: 'x', symbol: 's', direction: 'LONG', entryTs: 0, exitTs: 1, entryPrice: 1, exitPrice: 1, quantity: 1, grossPnl: net, fees: 0, slippage: 0, carry: 0, netPnl: net, returnPct: net / 100, reason: '' });
    const m = computeMetrics({ equityCurve: curve([100, 110]), trades: [t(30), t(-10), t(20), t(-10)], initialCapital: 100, periodMs: H });
    expect(m.winRate).toBe(0.5);
    expect(m.profitFactor).toBe(2.5);
    expect(m.expectancy).toBe(7.5);
  });

  it('PSR is 0.5 at the benchmark and rises with sample size', () => {
    expect(probabilisticSharpe(0, 100, 0, 3)).toBeCloseTo(0.5, 6);
    const small = probabilisticSharpe(0.1, 50, 0, 3)!;
    const large = probabilisticSharpe(0.1, 500, 0, 3)!;
    expect(large).toBeGreaterThan(small);
    // closed form for normal returns (γ3 = 0, γ4 = 3): Φ(0.1·√499 / √1.005) = Φ(2.2283)
    expect(large).toBeCloseTo(0.98707, 4);
  });

  it('DSR deflates for the number of trials', () => {
    const psr = probabilisticSharpe(0.1, 500, 0, 3)!;
    const dsr = deflatedSharpe(0.1, 500, 0, 3, 50, 0.002)!;
    expect(dsr).toBeLessThan(psr);
    expect(deflatedSharpe(0.1, 500, 0, 3, 1, 0)).toBeCloseTo(psr, 12);
  });
});

import type { OutcomeBook } from '@aoc/core';
import { PaperAccount } from '@aoc/paper-engine';
import type { PredictionMarketSnapshot } from '@aoc/strategies';
import { describe, expect, it } from 'vitest';
import {
  PMArbStrategy,
  PMMarketMakingStrategy,
  pmArbMeta,
  pmMarketMakingMeta,
  pmPaperStep,
  predictionMarketModules,
  runPMBacktest,
  syntheticPredictionMarkets,
  DEFAULT_PM_SYNTHETIC,
  valueModule,
} from '../src';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;

function outcome(market: string, name: string, bid: number, ask: number, size = 100, end = T0 + 30 * 24 * 3_600_000): OutcomeBook {
  const tokenId = `${market}-${name}`;
  return {
    marketId: market,
    question: `Q ${market}`,
    outcome: name,
    tokenId,
    book: { venue: 'polymarket', symbol: tokenId, bids: [{ price: bid, size }], asks: [{ price: ask, size }], ts: 0, receivedAt: 0, tickSize: 0.01 },
    feeRate: 0,
    feeModel: 'none',
    endDate: new Date(end).toISOString(),
  };
}

function snap(ts: number, outcomes: OutcomeBook[], resolved: string | null = null): PredictionMarketSnapshot {
  return { ts, markets: [{ marketId: outcomes[0]!.marketId, question: outcomes[0]!.question, negRisk: false, outcomes, resolvedOutcome: resolved }] };
}

describe('complete-set arbitrage', () => {
  it('buys both sides below $1 and locks in the difference at resolution', () => {
    const series = [
      snap(T0, [outcome('m', 'Yes', 0.44, 0.45), outcome('m', 'No', 0.49, 0.5)]),
      snap(T0 + MIN, [outcome('m', 'Yes', 0.44, 0.45), outcome('m', 'No', 0.49, 0.5)]),
      snap(T0 + 2 * MIN, [outcome('m', 'Yes', 0.6, 0.61), outcome('m', 'No', 0.38, 0.39)]),
      snap(T0 + 3 * MIN, [outcome('m', 'Yes', 0.99, 0.99), outcome('m', 'No', 0.01, 0.01)], 'Yes'),
    ];
    const res = runPMBacktest({ strategy: new PMArbStrategy(), params: { ...pmArbMeta.defaultParams, minAnnualizedReturn: 0 }, series, initialCapital: 1000, provenance: 'DEMO', label: 't', executionDelay: 1 });
    // 100 sets (depth) at 0.95 → payout 100 → +5
    expect(res.equityCurve[res.equityCurve.length - 1]!.equity).toBeCloseTo(1005, 6);
    expect(res.trades.reduce((a, t) => a + t.netPnl, 0)).toBeCloseTo(5, 6);
  });

  it('suffers leg risk when the book moves before execution', () => {
    const series = [
      snap(T0, [outcome('m', 'Yes', 0.44, 0.45), outcome('m', 'No', 0.49, 0.5)]),
      snap(T0 + MIN, [outcome('m', 'Yes', 0.44, 0.45), outcome('m', 'No', 0.59, 0.6)]),
      snap(T0 + 2 * MIN, [outcome('m', 'Yes', 0.01, 0.01), outcome('m', 'No', 0.99, 0.99)], 'No'),
    ];
    const res = runPMBacktest({ strategy: new PMArbStrategy(), params: { ...pmArbMeta.defaultParams, minAnnualizedReturn: 0 }, series, initialCapital: 1000, provenance: 'DEMO', label: 't', executionDelay: 1 });
    // Only the Yes leg filled (No moved above its limit); Yes resolved to 0.
    expect(res.equityCurve[res.equityCurve.length - 1]!.equity).toBeCloseTo(1000 - 45, 6);
    expect(res.notes.join()).toMatch(/rejected/);
  });

  it('ignores sets that are not below $1 after fees', () => {
    const series = [snap(T0, [outcome('m', 'Yes', 0.5, 0.51), outcome('m', 'No', 0.48, 0.5)]), snap(T0 + MIN, [outcome('m', 'Yes', 0.5, 0.51), outcome('m', 'No', 0.48, 0.5)])];
    const res = runPMBacktest({ strategy: new PMArbStrategy(), params: pmArbMeta.defaultParams, series, initialCapital: 1000, provenance: 'DEMO', label: 't', executionDelay: 1 });
    expect(res.trades).toHaveLength(0);
    expect(res.equityCurve.every((p) => p.equity === 1000)).toBe(true);
  });
});

describe('market making', () => {
  it('fills a resting bid only when the market trades through it, then quotes inventory', () => {
    const end = T0 + 30 * 24 * 3_600_000;
    const series = [
      snap(T0, [outcome('m', 'Yes', 0.5, 0.52, 100, end), outcome('m', 'No', 0.48, 0.5, 100, end)]),
      snap(T0 + MIN, [outcome('m', 'Yes', 0.5, 0.52, 100, end), outcome('m', 'No', 0.48, 0.5, 100, end)]),
      // ask drops through our 0.50 bid → filled as maker
      snap(T0 + 2 * MIN, [outcome('m', 'Yes', 0.47, 0.49, 100, end), outcome('m', 'No', 0.51, 0.53, 100, end)]),
      snap(T0 + 3 * MIN, [outcome('m', 'Yes', 0.47, 0.49, 100, end), outcome('m', 'No', 0.51, 0.53, 100, end)]),
    ];
    const decisions: string[] = [];
    const res = runPMBacktest({ strategy: new PMMarketMakingStrategy(), params: pmMarketMakingMeta.defaultParams, series, initialCapital: 1000, provenance: 'DEMO', label: 't', executionDelay: 1, onDecision: (d) => decisions.push(d.action) });
    expect(res.equityCurve.length).toBe(4);
    // inventory is marked to the mid (0.48) after buying at 0.50 → small loss = adverse selection
    expect(res.equityCurve[2]!.equity).toBeLessThan(1000);
  });
});

describe('DEMO data and modules', () => {
  it('generates deterministic synthetic markets that resolve', () => {
    const a = syntheticPredictionMarkets({ ...DEFAULT_PM_SYNTHETIC, seed: 'x', snapshots: 100 });
    const b = syntheticPredictionMarkets({ ...DEFAULT_PM_SYNTHETIC, seed: 'x', snapshots: 100 });
    expect(a).toEqual(b);
    expect(a.provenance).toBe('DEMO');
    const resolved = new Set(a.pmSeries!.flatMap((s) => s.markets.filter((m) => m.resolvedOutcome).map((m) => m.marketId)));
    expect(resolved.size).toBeGreaterThan(0);
    for (const s of a.pmSeries!) for (const m of s.markets) for (const o of m.outcomes) expect(o.book.asks[0]!.price).toBeGreaterThan(o.book.bids[0]!.price);
  });

  it('every PM module runs end-to-end on DEMO data and labels it DEMO', () => {
    for (const m of predictionMarketModules) {
      const data = m.syntheticData!(m.meta.defaultParams, 'run');
      const r = m.backtest!({ params: m.meta.defaultParams, data, initialCapital: 5000, seed: 'run' });
      expect(r.provenance, m.meta.id).toBe('DEMO');
      expect(r.equityCurve.length).toBeGreaterThan(10);
      expect(Number.isFinite(r.metrics.netProfit)).toBe(true);
    }
  });

  it('value trading with an oracle as noisy as the market shows no reliable edge (negative control)', () => {
    let significant = 0;
    for (const seed of ['v1', 'v2', 'v3']) {
      const data = valueModule.syntheticData!(valueModule.meta.defaultParams, seed);
      const r = valueModule.backtest!({ params: valueModule.meta.defaultParams, data, initialCapital: 5000, seed });
      if (r.metrics.tStat !== null && r.metrics.tStat > 2.5 && r.trades.length >= 30) significant++;
    }
    expect(significant).toBe(0);
  });
});

describe('paper step', () => {
  it('places orders on a live snapshot and settles on resolution', () => {
    const { account } = PaperAccount.open({ startingCapital: 1000, ts: new Date(T0) });
    const live = { provenance: 'PAPER' as const, label: 'live', pmSeries: [snap(T0, [outcome('m', 'Yes', 0.44, 0.45), outcome('m', 'No', 0.49, 0.5)])] };
    const s1 = pmPaperStep(new PMArbStrategy(), { params: { ...pmArbMeta.defaultParams, minAnnualizedReturn: 0 }, account, now: new Date(T0), live, state: {}, seed: 's', assumptions: [] });
    expect(account.positions()).toHaveLength(2);
    expect(s1.decisions.some((d) => d.action === 'ARB')).toBe(true);
    const resolved = { ...live, pmSeries: [snap(T0 + MIN, [outcome('m', 'Yes', 0.99, 0.99), outcome('m', 'No', 0.01, 0.01)], 'Yes')] };
    const s2 = pmPaperStep(new PMArbStrategy(), { params: pmArbMeta.defaultParams, account, now: new Date(T0 + MIN), live: resolved, state: s1.state, seed: 's', assumptions: [] });
    expect(s2.decisions.some((d) => d.action === 'SETTLED')).toBe(true);
    expect(account.positions()).toHaveLength(0);
    expect(account.snapshot().equity.toNumber()).toBeCloseTo(1005, 6);
    // a second tick on the same resolution does not settle twice
    const s3 = pmPaperStep(new PMArbStrategy(), { params: pmArbMeta.defaultParams, account, now: new Date(T0 + 2 * MIN), live: resolved, state: s2.state, seed: 's', assumptions: [] });
    expect(s3.decisions.some((d) => d.action === 'SETTLED')).toBe(false);
  });

  it('reports NO_DATA instead of trading on nothing', () => {
    const { account } = PaperAccount.open({ startingCapital: 1000, ts: new Date(T0) });
    const out = pmPaperStep(new PMArbStrategy(), { params: pmArbMeta.defaultParams, account, now: new Date(T0), live: { provenance: 'PAPER', label: 'x' }, state: {}, seed: 's', assumptions: [] });
    expect(out.decisions[0]!.action).toBe('NO_DATA');
  });
});

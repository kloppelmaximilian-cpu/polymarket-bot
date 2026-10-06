/**
 * The backtest engine driven by the real trading strategies: causality,
 * negative controls, costs, walk-forward and paper steps.
 */
import { type Bar } from '@aoc/core';
import { PaperAccount } from '@aoc/paper-engine';
import { type AnyStrategyModule, type DecisionLog, type TradeRecord } from '@aoc/strategies';
import {
  MomentumStrategy,
  breakoutModule,
  meanReversionModule,
  momentumMeta,
  momentumModule,
  pairsModule,
  trendModule,
  volatilityModule,
  BINANCE_SPOT_COSTS,
} from '../src';
import { describe, expect, it } from 'vitest';
import {
  blockBootstrapReturns,
  bootstrapTrades,
  costSensitivity,
  gridOf,
  makeFolds,
  neighbours,
  runBarBacktest,
  stitchFolds,
  syntheticBars,
  syntheticPair,
  trainTestBoundary,
} from '@aoc/backtest';

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const walk = (seed: string, n = 1500, regime: 'random_walk' | 'regime_switching' = 'random_walk') =>
  syntheticBars({ seed, bars: n, intervalMs: H, startTs: T0, startPrice: 60_000, vol: 0.006, regime, avgVolume: 500 });

describe('bar backtest', () => {
  it('executes decisions at the next bar open, never on the decision bar', () => {
    const bars = walk('next-open', 300);
    const decisions: DecisionLog[] = [];
    const res = runBarBacktest({
      strategy: new MomentumStrategy(),
      params: { ...momentumMeta.defaultParams, entryThreshold: 0, exitThreshold: -1 },
      bars: { BTCUSDT: bars },
      venue: 'binance',
      instrumentKind: 'SPOT',
      costs: { feeModel: { type: 'none' }, spreadBps: 0, slippageBps: 0, impactBpsPer10k: 0 },
      initialCapital: 10_000,
      provenance: 'DEMO',
      datasetLabel: 'test',
      seed: 's',
      warmupBars: 49,
      onDecision: (d) => decisions.push(d),
    });
    const first = res.trades[0]!;
    const entryBar = bars.find((b) => b.ts === first.entryTs)!;
    expect(first.entryPrice).toBeCloseTo(entryBar.open, 6);
    // The first ORDER decision was taken on the close of the bar before.
    const firstOrder = decisions.find((d) => d.action === 'ORDER')!;
    expect(firstOrder.ts).toBe(first.entryTs);
  });

  it('is causal: changing the future does not change past decisions', () => {
    const bars = walk('causal', 800);
    const cut = 500;
    const future = bars.map((b, i) => (i <= cut ? b : { ...b, open: b.open * 1.5, high: b.high * 1.5, low: b.low * 1.5, close: b.close * 1.5 }));
    const run = (data: Bar[]) => {
      const log: DecisionLog[] = [];
      runBarBacktest({
        strategy: new MomentumStrategy(),
        params: momentumMeta.defaultParams,
        bars: { BTCUSDT: data },
        venue: 'binance',
        instrumentKind: 'SPOT',
        costs: BINANCE_SPOT_COSTS,
        initialCapital: 10_000,
        provenance: 'DEMO',
        datasetLabel: 't',
        seed: 's',
        warmupBars: 49,
        onDecision: (d) => log.push(d),
      });
      return log.filter((d) => d.ts <= bars[cut]!.ts + H);
    };
    expect(run(future)).toEqual(run(bars));
  });

  it('negative control: no strategy shows a reliable edge on a driftless random walk, and costs are always charged', () => {
    const modules: AnyStrategyModule[] = [momentumModule, meanReversionModule, breakoutModule, trendModule, volatilityModule];
    let totalFees = 0;
    let significant = 0;
    for (const m of modules) {
      for (const seed of ['nc1', 'nc2', 'nc3']) {
        const data = m.syntheticData!(m.meta.defaultParams, seed);
        const r = m.backtest!({ params: m.meta.defaultParams, data, initialCapital: 10_000, seed });
        expect(r.provenance).toBe('DEMO');
        totalFees += r.metrics.fees;
        if (r.metrics.tStat !== null && r.metrics.tStat > 2.5 && r.trades.length >= 30) significant++;
      }
    }
    expect(totalFees).toBeGreaterThan(0);
    expect(significant).toBe(0);
  });

  it('engine check: trend following profits on synthetic data that contains persistent trends', () => {
    const bars = syntheticBars({ seed: 'trendy', bars: 3000, intervalMs: H, startTs: T0, startPrice: 60_000, vol: 0.004, regime: 'regime_switching', volClustering: 0 });
    const r = trendModule.backtest!({ params: trendModule.meta.defaultParams, data: { provenance: 'DEMO', label: 'trendy', bars: { BTCUSDT: bars } }, initialCapital: 10_000, seed: 't' });
    expect(r.trades.length).toBeGreaterThan(3);
    expect(r.metrics.grossProfit).toBeGreaterThan(0);
  });

  it('applies the cost multiplier monotonically', () => {
    const data = momentumModule.syntheticData!(momentumModule.meta.defaultParams, 'costs');
    const cs = costSensitivity((m) => {
      const r = momentumModule.backtest!({ params: momentumModule.meta.defaultParams, data, initialCapital: 10_000, seed: 'c', costMultiplier: m });
      return { netProfit: r.metrics.netProfit, trades: r.trades.length };
    });
    for (let i = 1; i < cs.points.length; i++) expect(cs.points[i]!.netProfit).toBeLessThanOrEqual(cs.points[i - 1]!.netProfit + 1e-6);
  });

  it('respects risk limits passed to the engine', () => {
    const data = momentumModule.syntheticData!(momentumModule.meta.defaultParams, 'risk');
    const r = momentumModule.backtest!({ params: momentumModule.meta.defaultParams, data, initialCapital: 10_000, seed: 'r' });
    const limited = runBarBacktest({
      strategy: new MomentumStrategy(),
      params: momentumMeta.defaultParams,
      bars: { BTCUSDT: data.bars!.BTCUSDT! },
      venue: 'binance',
      instrumentKind: 'SPOT',
      costs: BINANCE_SPOT_COSTS,
      initialCapital: 10_000,
      provenance: 'DEMO',
      datasetLabel: 't',
      seed: 's',
      warmupBars: 49,
      riskLimits: { maxCapital: 10_000, maxDailyLoss: 500, maxDrawdownPct: 0.5, maxExposure: 10_000, maxPositions: 1, maxOrdersPerDay: 50, maxOrderNotional: 1_000, maxApiSpend: 0, maxExperimentSpend: 10_000 },
    });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of limited.trades) expect(t.entryPrice * t.quantity).toBeLessThanOrEqual(1_000 * 1.01);
    expect(limited.notes.join()).toMatch(/rejected/);
  });

  it('trades both legs of the pairs strategy on a cointegrated pair', () => {
    const { x, y } = syntheticPair({ seed: 'pair', bars: 1500, intervalMs: H, startTs: T0, startPrice: 60_000, vol: 0.006, beta: 0.05, halfLifeBars: 24, spreadVol: 0.004 });
    const r = pairsModule.backtest!({ params: pairsModule.meta.defaultParams, data: { provenance: 'DEMO', label: 'pair', bars: { ETHUSDT: y, BTCUSDT: x } }, initialCapital: 10_000, seed: 'p' });
    const symbols = new Set(r.trades.map((t) => t.symbol));
    expect(symbols.has('ETHUSDT')).toBe(true);
    expect(symbols.has('BTCUSDT')).toBe(true);
  });
});

describe('validation tooling', () => {
  it('makes disjoint, ordered walk-forward folds', () => {
    const bars = walk('folds', 1000);
    const folds = makeFolds(bars, 100, 5);
    expect(folds).toHaveLength(5);
    for (let i = 1; i < folds.length; i++) expect(folds[i]!.startTs).toBe(folds[i - 1]!.endTs);
    expect(folds[0]!.startTs).toBe(bars[100]!.ts);
    expect(trainTestBoundary(bars, 100, 0.7)).toBe(bars[100 + 630]!.ts);
  });

  it('stitches out-of-sample folds into one record', () => {
    const bars = walk('stitch', 1200);
    const folds = makeFolds(bars, 60, 3);
    const results = folds.map((fold) => ({
      fold,
      result: momentumModule.backtest!({ params: momentumModule.meta.defaultParams, data: { provenance: 'DEMO', label: 'w', bars: { BTCUSDT: bars } }, initialCapital: 10_000, seed: 'w', window: { startTs: fold.startTs, endTs: fold.endTs } }),
    }));
    const wf = stitchFolds(results, 10_000, H);
    expect(wf.oosTrades.length).toBe(results.reduce((a, r) => a + r.result.trades.length, 0));
    for (const r of results) {
      for (const t of r.result.trades) {
        expect(t.entryTs).toBeGreaterThanOrEqual(r.fold.startTs);
        expect(t.exitTs).toBeLessThanOrEqual(r.fold.endTs + H);
      }
    }
  });

  it('Monte Carlo is reproducible per seed and bounded', () => {
    const trades: TradeRecord[] = Array.from({ length: 40 }, (_, i) => ({ id: `${i}`, symbol: 's', direction: 'LONG', entryTs: 0, exitTs: 1, entryPrice: 1, exitPrice: 1, quantity: 1, grossPnl: 0, fees: 0, slippage: 0, carry: 0, netPnl: i % 3 === 0 ? -30 : 20, returnPct: 0, reason: '' }));
    const a = bootstrapTrades(trades, 1000, { seed: 'x', drawdownLimit: 0.1, paths: 500 })!;
    const b = bootstrapTrades(trades, 1000, { seed: 'x', drawdownLimit: 0.1, paths: 500 })!;
    expect(a).toEqual(b);
    expect(a.probLoss).toBeGreaterThanOrEqual(0);
    expect(a.probLoss).toBeLessThanOrEqual(1);
    expect(a.totalReturnP5).toBeLessThanOrEqual(a.totalReturnP95);
    expect(bootstrapTrades(trades.slice(0, 3), 1000, { seed: 'x', drawdownLimit: 0.1 })).toBeNull();
    const rets = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.01 : -0.009));
    expect(blockBootstrapReturns(rets, 1000, { seed: 'y', drawdownLimit: 0.2, paths: 200 })!.method).toBe('block_bootstrap');
  });

  it('keeps the parameter grid small and enumerates neighbours', () => {
    expect(gridOf(momentumMeta.paramSpace)).toHaveLength(12); // 4 lookbacks × 3 thresholds
    expect(() => gridOf({ a: { type: 'int', min: 0, max: 1000, step: 1 } })).toThrow(/narrow/);
    const ns = neighbours({ lookbackBars: 48, entryThreshold: 0.02 }, momentumMeta.paramSpace);
    expect(ns.map((n) => `${n.param}=${n.value}`).sort()).toEqual(['entryThreshold=0.01', 'entryThreshold=0.03', 'lookbackBars=24', 'lookbackBars=72'].sort());
  });
});

describe('paper step for bar strategies', () => {
  it('decides once per closed bar, at live prices, and refuses to trade without a book', () => {
    const bars = walk('paper', 200);
    // Force an entry: last 48h return > threshold.
    const last = bars.length - 1;
    bars[last] = { ...bars[last]!, close: bars[last - 48]!.close * 1.05, high: Math.max(bars[last]!.high, bars[last - 48]!.close * 1.05) };
    const { account } = PaperAccount.open({ startingCapital: 10_000, ts: new Date(bars[last]!.ts) });
    const now = new Date(bars[last]!.ts + H + 5_000);
    const book = { venue: 'binance', symbol: 'BTCUSDT', bids: [{ price: bars[last]!.close - 1, size: 5 }], asks: [{ price: bars[last]!.close + 1, size: 5 }], ts: now.getTime(), receivedAt: now.getTime() };
    const params = momentumModule.meta.defaultParams;

    const noBook = momentumModule.paperStep!({ params, account, now, live: { provenance: 'PAPER', label: 'live', bars: { BTCUSDT: bars } }, state: {}, seed: 's', assumptions: [] });
    expect(noBook.decisions.map((d) => d.action)).toContain('NO_QUOTE');
    expect(account.positions()).toHaveLength(0);

    const step1 = momentumModule.paperStep!({ params, account, now, live: { provenance: 'PAPER', label: 'live', bars: { BTCUSDT: bars }, books: { BTCUSDT: book } }, state: {}, seed: 's', assumptions: [] });
    expect(account.positions()).toHaveLength(1);
    expect(step1.changes.some((c) => c.fills.length > 0)).toBe(true);
    const step2 = momentumModule.paperStep!({ params, account, now, live: { provenance: 'PAPER', label: 'live', bars: { BTCUSDT: bars }, books: { BTCUSDT: book } }, state: step1.state, seed: 's', assumptions: [] });
    expect(step2.changes.flatMap((c) => c.fills)).toHaveLength(0);
  });
});

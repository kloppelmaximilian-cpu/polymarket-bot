import type { Bar, FundingRatePoint, Quote } from '@aoc/core';
import { PaperAccount } from '@aoc/paper-engine';
import type { QuoteSnapshot } from '@aoc/strategies';
import { describe, expect, it } from 'vitest';
import { crossExchangeMeta, crossExchangeModule, fundingMeta, fundingModule, runCrossExchange, runFundingCarry } from '../src';

const T0 = Date.UTC(2026, 0, 1);
const q = (venue: string, bid: number, ask: number, ts: number, size = 1): Quote => ({ venue, symbol: 'BTC-USD', bid, ask, bidSize: size, askSize: size, ts, receivedAt: ts });

describe('cross-exchange arbitrage', () => {
  it('captures a dislocation larger than both taker fees, executing on the next snapshot', () => {
    const series: QuoteSnapshot[] = [
      { ts: T0, quotes: [q('binance', 59_990, 60_000, T0), q('kraken', 59_990, 60_000, T0)] },
      { ts: T0 + 10_000, quotes: [q('binance', 59_990, 60_000, T0 + 10_000), q('kraken', 61_190, 61_200, T0 + 10_000)] },
      { ts: T0 + 20_000, quotes: [q('binance', 59_990, 60_000, T0 + 20_000), q('kraken', 61_190, 61_200, T0 + 20_000)] },
    ];
    const params = { ...crossExchangeMeta.defaultParams, venues: ['binance', 'kraken'], slippageBps: 0, maxTradeNotional: 6000 };
    const r = runCrossExchange(params, series, 100_000, 'DEMO', 't');
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.entryPrice).toBeCloseTo(60_000, 6);
    expect(t.exitPrice).toBeCloseTo(61_190, 6);
    // gross 0.1 × 1190 = 119; fees 6000 × 10bps + 6119 × 40bps = 6 + 24.476
    expect(t.grossPnl).toBeCloseTo(119, 6);
    expect(t.fees).toBeCloseTo(30.476, 3);
    expect(t.netPnl).toBeCloseTo(88.524, 3);
  });

  it('does not trade when the gap is smaller than fees (retail tiers)', () => {
    const series: QuoteSnapshot[] = Array.from({ length: 5 }, (_, i) => ({ ts: T0 + i * 10_000, quotes: [q('binance', 59_990, 60_000, T0), q('kraken', 60_040, 60_060, T0)] }));
    const r = runCrossExchange({ ...crossExchangeMeta.defaultParams, venues: ['binance', 'kraken'] }, series, 100_000, 'DEMO', 't');
    expect(r.trades).toHaveLength(0);
  });

  it('runs on DEMO data and labels it', () => {
    const data = crossExchangeModule.syntheticData!(crossExchangeMeta.defaultParams, 'demo');
    const r = crossExchangeModule.backtest!({ params: crossExchangeMeta.defaultParams, data: { ...data, quoteSeries: data.quoteSeries!.slice(0, 2000) }, initialCapital: 10_000, seed: 'demo' });
    expect(r.provenance).toBe('DEMO');
    expect(r.notes[0]).toMatch(/opportunities seen/);
  });
});

describe('funding-rate carry', () => {
  const bars: Bar[] = Array.from({ length: 24 * 12 }, (_, i) => ({ ts: T0 + i * 3_600_000, open: 60_000, high: 60_010, low: 59_990, close: 60_000, volume: 10 }));
  const funding: FundingRatePoint[] = Array.from({ length: 30 }, (_, i) => ({
    venue: 'binance-futures',
    symbol: 'BTCUSDT',
    fundingTime: T0 + (i + 1) * 8 * 3_600_000,
    rate: i < 20 ? 0.0003 : -0.0002,
    markPrice: 60_000,
  }));

  it('enters after the lookback, collects funding, exits when it fades', () => {
    const r = runFundingCarry({ ...fundingMeta.defaultParams, spreadBps: 0, slippageBps: 0 }, bars, funding, 10_000, 'DEMO', 't');
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.carry).toBeGreaterThan(0);
    // flat prices: basis P&L is zero, so net = carry − 4 taker fees
    expect(t.grossPnl).toBeCloseTo(0, 6);
    expect(t.netPnl).toBeCloseTo(t.carry - t.fees, 6);
    expect(t.fees).toBeGreaterThan(0);
  });

  it('only uses spot prices at or before each funding time', () => {
    // A spike after the last funding time must not affect anything.
    const spiked = bars.map((b) => (b.ts > funding[funding.length - 1]!.fundingTime ? { ...b, open: 1e6, high: 1e6, low: 1e6, close: 1e6 } : b));
    const a = runFundingCarry(fundingMeta.defaultParams, bars, funding, 10_000, 'DEMO', 't');
    const b = runFundingCarry(fundingMeta.defaultParams, spiked, funding, 10_000, 'DEMO', 't');
    expect(b.equityCurve).toEqual(a.equityCurve);
  });

  it('paper mode warms up from history without trading on it', () => {
    const { account } = PaperAccount.open({ startingCapital: 10_000, ts: new Date(T0) });
    const now = new Date(funding[25]!.fundingTime + 1000);
    const live = { provenance: 'PAPER' as const, label: 'live', bars: { BTCUSDT: bars }, funding: { BTCUSDT: funding.slice(0, 26) } };
    const s1 = fundingModule.paperStep!({ params: fundingMeta.defaultParams, account, now, live, state: {}, seed: 's', assumptions: [] });
    expect(s1.decisions[0]!.action).toBe('WARMUP');
    expect(account.positions()).toHaveLength(0);
    const later = new Date(funding[27]!.fundingTime + 1000);
    const s2 = fundingModule.paperStep!({ params: fundingMeta.defaultParams, account, now: later, live: { ...live, funding: { BTCUSDT: funding.slice(0, 28) } }, state: s1.state, seed: 's', assumptions: [] });
    // funding is negative from period 20 on: trailing average below entry → no position
    expect(s2.decisions.every((d) => d.action !== 'ENTER')).toBe(true);
  });

  it('runs on DEMO data', () => {
    const data = fundingModule.syntheticData!(fundingMeta.defaultParams, 'demo');
    const r = fundingModule.backtest!({ params: fundingMeta.defaultParams, data, initialCapital: 10_000, seed: 'demo' });
    expect(r.provenance).toBe('DEMO');
    expect(r.equityCurve.length).toBeGreaterThan(100);
  });
});

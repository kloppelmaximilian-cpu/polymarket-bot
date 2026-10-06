import { DataUnavailableError, type Bar, type Provenance, type RiskLimits } from '@aoc/core';
import { PaperAccount, merge, type EngineChanges, type FeeModel, type Instrument, type MarketSnapshot } from '@aoc/paper-engine';
import { createPreTradeHook } from '@aoc/risk';
import {
  BarSeries,
  inferIntervalMs,
  runTradingStep,
  type BacktestResult,
  type Broker,
  type CommonTradingParams,
  type DecisionLog,
  type EquityPoint,
  type OrderIntent,
  type StrategyContext,
  type TradingStrategy,
} from '@aoc/strategies';
import { computeMetrics } from './metrics';
import { TradeTracker } from './trades';

export interface BarBacktestCosts {
  feeModel: FeeModel;
  /** Full quoted spread in bps; executions pay half of it. */
  spreadBps: number;
  /** Additional slippage in bps per execution. */
  slippageBps: number;
  /** Additional market impact in bps per 10 000 USD notional. */
  impactBpsPer10k: number;
}

export interface BarBacktestOptions<P extends CommonTradingParams> {
  strategy: TradingStrategy<P, unknown>;
  params: P;
  /** Bars per symbol; the first symbol is the primary. */
  bars: Record<string, Bar[]>;
  venue: string;
  instrumentKind: 'SPOT' | 'PERP';
  costs: BarBacktestCosts;
  initialCapital: number;
  provenance: Provenance;
  datasetLabel: string;
  seed: string;
  costMultiplier?: number;
  window?: { startTs: number; endTs: number };
  riskLimits?: RiskLimits;
  /** Bars needed before the first decision. */
  warmupBars: number;
  /** Capacity heuristic: share of average bar dollar-volume we may trade. */
  maxParticipation?: number;
  onDecision?: (d: DecisionLog) => void;
}

/**
 * Event-driven bar backtest without look-ahead:
 *
 *   for each bar t:  1. execute orders decided at the close of t−1 at the
 *                       OPEN of t (half-spread + slippage + fees)
 *                    2. mark positions to the CLOSE of t
 *                    3. let the strategy decide on data up to and including t
 *
 * The strategy only ever sees a BarSeries whose cursor is t, so reading
 * bar t+1 throws. Accounting is done by the same PaperAccount used for paper
 * trading, so backtest and paper P&L are computed identically.
 */
export function runBarBacktest<P extends CommonTradingParams>(opts: BarBacktestOptions<P>): BacktestResult {
  const symbols = Object.keys(opts.bars);
  const primary = symbols[0];
  if (!primary) throw new DataUnavailableError('no bars supplied');
  const aligned = alignBars(opts.bars);
  const primaryBars = aligned[primary] as Bar[];
  if (primaryBars.length < opts.warmupBars + 2) {
    throw new DataUnavailableError(`need at least ${opts.warmupBars + 2} bars, have ${primaryBars.length}`);
  }
  const m = opts.costMultiplier ?? 1;
  const feeModel: FeeModel =
    opts.costs.feeModel.type === 'bps'
      ? { type: 'bps', makerBps: opts.costs.feeModel.makerBps * m, takerBps: opts.costs.feeModel.takerBps * m }
      : opts.costs.feeModel.type === 'polymarket'
        ? { type: 'polymarket', rate: opts.costs.feeModel.rate * m }
        : opts.costs.feeModel;
  const instruments: Record<string, Instrument> = {};
  for (const s of symbols) instruments[s] = { venue: opts.venue, symbol: s, kind: opts.instrumentKind, feeModel };

  const startIdx = opts.window ? Math.max(opts.warmupBars, primaryBars.findIndex((b) => b.ts >= opts.window!.startTs)) : opts.warmupBars;
  const endIdx = opts.window ? lastIndexBefore(primaryBars, opts.window.endTs) : primaryBars.length - 1;
  if (startIdx < 0 || startIdx >= endIdx) throw new DataUnavailableError('backtest window contains no tradable bars');

  const startTs = (primaryBars[startIdx] as Bar).ts;
  const hooks = opts.riskLimits ? [createPreTradeHook(() => ({ limits: opts.riskLimits!, emergencyStop: false, experimentStatus: null }))] : [];
  const { account } = PaperAccount.open(
    { startingCapital: opts.initialCapital, ts: new Date(startTs) },
    { slippage: { fixedBps: opts.costs.slippageBps * m, impactBpsPer10k: opts.costs.impactBpsPer10k * m }, preTradeHooks: hooks, idGen: counter() },
  );
  const series: Record<string, BarSeries> = {};
  for (const s of symbols) series[s] = new BarSeries(aligned[s] as Bar[], startIdx - 1);

  const tracker = new TradeTracker();
  const equityCurve: EquityPoint[] = [];
  const pending: OrderIntent[] = [];
  const state: Record<string, unknown> = {};
  const notes: string[] = [];
  const allChanges: EngineChanges = { orders: [], fills: [], transactions: [], positions: [], closedPositions: [] };
  let barsInMarket = 0;
  let rejected = 0;
  let orderSeq = 0;
  const halfSpread = (opts.costs.spreadBps * m) / 2 / 10_000;

  const broker: Broker = {
    submit(intent) {
      pending.push(intent);
      return { accepted: true };
    },
  };

  const positionView = (symbol?: string) => {
    const s = symbol ?? primary;
    const p = account.position(opts.venue, s);
    return p ? { quantity: p.quantity.toNumber(), avgPrice: p.avgPrice.toNumber() } : { quantity: 0, avgPrice: 0 };
  };

  let decisionTs = startTs;
  const ctx: StrategyContext<P> = {
    params: opts.params,
    primary,
    symbols,
    get now() {
      return decisionTs;
    },
    allowShort: opts.params.allowShort,
    bars: (symbol?: string) => {
      const s = series[symbol ?? primary];
      if (!s) throw new DataUnavailableError(`no bars for ${symbol}`);
      return s;
    },
    position: positionView,
    equity: () => account.snapshot().equity.toNumber(),
    state,
    broker,
    log: (action, detail, data) => opts.onDecision?.({ ts: decisionTs, action, detail, data }),
  };
  opts.strategy.initialize(ctx);

  for (let i = startIdx; i <= endIdx; i++) {
    const bar = primaryBars[i] as Bar;
    const ts = new Date(bar.ts);

    // 1. execute yesterday's decisions at today's open
    while (pending.length > 0) {
      const intent = pending.shift() as OrderIntent;
      const b = (aligned[intent.symbol] as Bar[])[i] as Bar;
      const market: MarketSnapshot = { ts, bid: b.open * (1 - halfSpread), ask: b.open * (1 + halfSpread), assumeInfiniteDepth: true };
      const res = account.submitOrder(
        {
          clientOrderId: `bt-${++orderSeq}`,
          instrument: instruments[intent.symbol] as Instrument,
          side: intent.side,
          type: 'MARKET',
          quantity: intent.quantity.toPrecision(12),
          reduceOnly: intent.reduceOnly,
          reason: intent.reason,
        },
        market,
      );
      merge(allChanges, res.changes);
      if (res.order.status === 'REJECTED') {
        rejected++;
        opts.onDecision?.({ ts: bar.ts, action: 'ORDER_REJECTED', detail: res.order.rejectReason ?? 'rejected' });
      }
      for (const f of res.changes.fills) {
        const closed = tracker.onFill(f, intent.reason);
        if (closed) opts.strategy.recordResult(closed, ctx);
      }
    }

    // 2. mark to the close
    for (const s of symbols) {
      const c = ((aligned[s] as Bar[])[i] as Bar).close;
      account.mark(opts.venue, s, c, new Date(bar.ts));
    }
    const snap = account.snapshot();
    if (snap.openPositions > 0) barsInMarket++;
    const closeTs = i + 1 < primaryBars.length ? (primaryBars[i + 1] as Bar).ts : bar.ts + inferIntervalMs(primaryBars);
    equityCurve.push({ ts: closeTs, equity: snap.equity.toNumber() });
    if (snap.equity.lte(0)) {
      notes.push(`equity exhausted at ${new Date(bar.ts).toISOString()}; backtest stopped`);
      break;
    }

    // 3. decide on data up to and including bar i (orders fill at the next open)
    if (i === endIdx) break;
    for (const s of symbols) (series[s] as BarSeries).setCursor(i);
    decisionTs = closeTs;
    runTradingStep(opts.strategy, ctx);
  }

  // Close what is still open at the last close so every trade is counted.
  const finalBar = primaryBars[Math.min(endIdx, primaryBars.length - 1)] as Bar;
  for (const s of symbols) {
    const p = account.position(opts.venue, s);
    if (!p || p.quantity.isZero()) continue;
    const b = (aligned[s] as Bar[])[Math.min(endIdx, primaryBars.length - 1)] as Bar;
    const res = account.submitOrder(
      {
        clientOrderId: `bt-final-${s}`,
        instrument: instruments[s] as Instrument,
        side: p.quantity.isPositive() ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: p.quantity.abs(),
        reduceOnly: true,
        reason: 'end of backtest',
      },
      { ts: new Date(finalBar.ts), bid: b.close * (1 - halfSpread), ask: b.close * (1 + halfSpread), assumeInfiniteDepth: true },
    );
    for (const f of res.changes.fills) tracker.onFill(f, 'end of backtest');
  }
  if (equityCurve.length > 0) {
    (equityCurve[equityCurve.length - 1] as EquityPoint).equity = account.snapshot().equity.toNumber();
  }
  if (rejected > 0) notes.push(`${rejected} orders were rejected by the paper engine or risk limits`);

  const periodMs = inferIntervalMs(primaryBars);
  const metrics = computeMetrics({
    equityCurve,
    trades: tracker.trades,
    initialCapital: opts.initialCapital,
    periodMs,
    exposurePct: equityCurve.length > 0 ? barsInMarket / equityCurve.length : null,
  });
  const gross = tracker.trades.map((t) => t.grossPnl);

  // Capacity: what share of traded volume could we take before moving the market?
  const participation = opts.maxParticipation ?? 0.01;
  const window = primaryBars.slice(startIdx, endIdx + 1);
  const avgDollarVolume = window.reduce((a, b) => a + b.volume * b.close, 0) / Math.max(1, window.length);
  const capacityUsd = avgDollarVolume > 0 ? avgDollarVolume * participation : null;

  return {
    provenance: opts.provenance,
    datasetLabel: opts.datasetLabel,
    startTs,
    endTs: (primaryBars[endIdx] as Bar).ts,
    initialCapital: opts.initialCapital,
    equityCurve,
    trades: tracker.trades,
    metrics,
    capacityUsd,
    notes,
    grossExpectancy: gross.length > 0 ? gross.reduce((a, b) => a + b, 0) / gross.length : null,
  };
}

/** Keep only timestamps present for every symbol. */
export function alignBars(bars: Record<string, Bar[]>): Record<string, Bar[]> {
  const symbols = Object.keys(bars);
  if (symbols.length <= 1) return bars;
  const common = symbols.map((s) => new Set((bars[s] as Bar[]).map((b) => b.ts))).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
  const out: Record<string, Bar[]> = {};
  for (const s of symbols) out[s] = (bars[s] as Bar[]).filter((b) => common.has(b.ts));
  return out;
}

function lastIndexBefore(bars: Bar[], endTs: number): number {
  for (let i = bars.length - 1; i >= 0; i--) if ((bars[i] as Bar).ts < endTs) return i;
  return -1;
}

function counter(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}


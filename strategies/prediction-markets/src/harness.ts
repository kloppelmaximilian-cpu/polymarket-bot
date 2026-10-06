import { DataUnavailableError, d, type OutcomeBook, type Provenance, type RiskLimits } from '@aoc/core';
import { PaperAccount, merge, type EngineChanges, type FeeModel, type FillState, type Instrument, type MarketSnapshot } from '@aoc/paper-engine';
import { createPreTradeHook } from '@aoc/risk';
import { TradeTracker, computeMetrics } from '@aoc/backtest';
import type { BacktestResult, DataBundle, DecisionLog, EquityPoint, PaperStepInput, PaperStepOutput, PredictionMarketSnapshot } from '@aoc/strategies';

export const VENUE = 'polymarket';

export interface PMIntent {
  tokenId: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  type: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  postOnly?: boolean;
  reason: string;
}

export interface PMContext<P> {
  params: P;
  now: number;
  state: Record<string, unknown>;
  account: PaperAccount;
  /** Shares held of an outcome token. */
  holding(tokenId: string): number;
  openOrders(tokenId?: string): Array<{ id: string; side: 'BUY' | 'SELL'; limitPrice: number | null; remaining: number }>;
  cancel(orderId: string, reason: string): void;
  log(action: string, detail: string, data?: Record<string, unknown>): void;
}

export interface PMStrategy<P> {
  onSnapshot(snap: PredictionMarketSnapshot, ctx: PMContext<P>): PMIntent[];
}

export function feeModelOf(o: OutcomeBook): FeeModel {
  if (o.feeModel === 'polymarket_pq' && o.feeRate > 0) return { type: 'polymarket', rate: o.feeRate };
  if (o.feeModel === 'bps' && o.feeRate > 0) return { type: 'bps', makerBps: 0, takerBps: o.feeRate };
  return { type: 'none' };
}

export function instrumentOf(o: OutcomeBook): Instrument {
  return { venue: VENUE, symbol: o.tokenId, kind: 'OUTCOME', feeModel: feeModelOf(o), tickSize: String(o.book.tickSize ?? 0.01) };
}

export function snapshotOf(o: OutcomeBook, ts: number): MarketSnapshot {
  return { ts: new Date(ts), bids: o.book.bids, asks: o.book.asks };
}

/** Taker fee per share at price p for this outcome (as a number, for edge maths). */
export function takerFeePerShare(o: OutcomeBook, p: number): number {
  if (o.feeModel === 'polymarket_pq') return o.feeRate * p * (1 - p);
  if (o.feeModel === 'bps') return (p * o.feeRate) / 10_000;
  return 0;
}

export function roundTick(p: number, tickSize = 0.01, mode: 'down' | 'up' = 'down'): number {
  const steps = p / tickSize;
  const r = mode === 'down' ? Math.floor(steps + 1e-9) : Math.ceil(steps - 1e-9);
  return Math.round(r * tickSize * 1e6) / 1e6;
}

interface RunOptions<P> {
  strategy: PMStrategy<P>;
  params: P;
  series: PredictionMarketSnapshot[];
  initialCapital: number;
  provenance: Provenance;
  label: string;
  costMultiplier?: number;
  /** Orders decided on snapshot t execute against snapshot t + delay. */
  executionDelay: number;
  riskLimits?: RiskLimits;
  window?: { startTs: number; endTs: number };
  onDecision?: (d: DecisionLog) => void;
}

/**
 * Replay a prediction-market snapshot series through a strategy using the
 * real paper engine: resting orders fill only when the book trades through
 * them, taker orders walk the recorded depth, resolutions settle positions.
 */
export function runPMBacktest<P>(o: RunOptions<P>): BacktestResult {
  const series = o.window ? o.series.filter((s) => s.ts >= o.window!.startTs && s.ts < o.window!.endTs) : o.series;
  if (series.length < 2) throw new DataUnavailableError('prediction-market series has fewer than 2 snapshots');
  const m = o.costMultiplier ?? 1;
  const hooks = o.riskLimits ? [createPreTradeHook(() => ({ limits: o.riskLimits!, emergencyStop: false, experimentStatus: null }))] : [];
  let n = 0;
  const { account } = PaperAccount.open({ startingCapital: o.initialCapital, ts: new Date(series[0]!.ts) }, { preTradeHooks: hooks, idGen: () => `pm-${++n}` });
  const tracker = new TradeTracker();
  const equity: EquityPoint[] = [];
  const state: Record<string, unknown> = {};
  const queue: Array<{ due: number; intents: PMIntent[] }> = [];
  const settled = new Set<string>();
  const books = new Map<string, OutcomeBook>();
  let rejected = 0;
  let seq = 0;

  const ctxFor = (now: number): PMContext<P> => ({
    params: o.params,
    now,
    state,
    account,
    holding: (tokenId) => account.position(VENUE, tokenId)?.quantity.toNumber() ?? 0,
    openOrders: (tokenId) => openOrdersOf(account, tokenId),
    cancel: (id, reason) => {
      account.cancelOrder(id, new Date(now), reason);
    },
    log: (action, detail, data) => o.onDecision?.({ ts: now, action, detail, data }),
  });

  for (let i = 0; i < series.length; i++) {
    const snap = series[i]!;
    const ts = new Date(snap.ts);
    for (const mk of snap.markets) for (const oc of mk.outcomes) books.set(oc.tokenId, scaleFees(oc, m));

    const execute = (intents: PMIntent[]) => {
      for (const intent of intents) {
        const oc = books.get(intent.tokenId);
        if (!oc || settled.has(oc.marketId)) continue;
        const res = account.submitOrder(
          { clientOrderId: `pm-${++seq}`, instrument: instrumentOf(oc), side: intent.side, type: intent.type, quantity: d(intent.quantity), limitPrice: intent.limitPrice, postOnly: intent.postOnly, reason: intent.reason },
          snapshotOf(oc, snap.ts),
        );
        if (res.order.status === 'REJECTED') {
          rejected++;
          o.onDecision?.({ ts: snap.ts, action: 'ORDER_REJECTED', detail: res.order.rejectReason ?? 'rejected' });
        }
        for (const f of res.changes.fills) tracker.onFill(f, intent.reason);
      }
    };

    // 1. orders decided earlier reach the market now
    while (queue.length > 0 && queue[0]!.due <= i) execute(queue.shift()!.intents);
    // 2. book updates fill resting orders and mark positions
    for (const mk of snap.markets) {
      for (const oc of mk.outcomes) {
        const c = account.onMarket(VENUE, oc.tokenId, snapshotOf(books.get(oc.tokenId)!, snap.ts));
        for (const f of c.fills) tracker.onFill(f, 'resting order filled');
      }
      // 3. resolutions settle every outcome of the market
      if (mk.resolvedOutcome && !settled.has(mk.marketId)) {
        settled.add(mk.marketId);
        for (const oc of mk.outcomes) {
          const held = account.position(VENUE, oc.tokenId);
          const payout = oc.outcome === mk.resolvedOutcome ? 1 : 0;
          if (held && held.quantity.gt(0)) tracker.onFill(settlementFill(oc.tokenId, held.quantity.toNumber(), held.avgPrice.toNumber(), payout, ts), 'resolution');
          account.settleOutcome(VENUE, oc.tokenId, payout, ts);
        }
      }
    }
    // 4. decide; with no delay the orders hit this snapshot's book (optimistic)
    const live: PredictionMarketSnapshot = { ...snap, markets: snap.markets.filter((mk) => !settled.has(mk.marketId)) };
    const intents = o.strategy.onSnapshot(live, ctxFor(snap.ts));
    if (intents.length > 0) {
      if (o.executionDelay <= 0) execute(intents);
      else queue.push({ due: i + o.executionDelay, intents });
    }
    equity.push({ ts: snap.ts, equity: account.snapshot().equity.toNumber() });
  }

  const s = account.snapshot();
  const periodMs = series.length > 1 ? series[1]!.ts - series[0]!.ts : 0;
  const notes: string[] = [];
  if (rejected > 0) notes.push(`${rejected} orders rejected (cash, holdings, depth or risk limits)`);
  if (s.openPositions > 0) notes.push(`${s.openPositions} positions still open at the end of the data, marked to mid (unresolved)`);
  const gross = tracker.trades.map((t) => t.grossPnl);
  return {
    provenance: o.provenance,
    datasetLabel: o.label,
    startTs: series[0]!.ts,
    endTs: series[series.length - 1]!.ts,
    initialCapital: o.initialCapital,
    equityCurve: equity,
    trades: tracker.trades,
    metrics: computeMetrics({ equityCurve: equity, trades: tracker.trades, initialCapital: o.initialCapital, periodMs }),
    capacityUsd: null,
    notes,
    grossExpectancy: gross.length > 0 ? gross.reduce((a, b) => a + b, 0) / gross.length : null,
  };
}

/** One live paper tick for a PM strategy. */
export function pmPaperStep<P>(strategy: PMStrategy<P>, input: PaperStepInput<P>): PaperStepOutput {
  const decisions: DecisionLog[] = [];
  const changes: EngineChanges[] = [];
  const state = { ...input.state };
  const snap = input.live.pmSeries?.[input.live.pmSeries.length - 1];
  if (!snap) {
    decisions.push({ ts: input.now.getTime(), action: 'NO_DATA', detail: 'no live prediction-market snapshot' });
    return { changes, state, decisions };
  }
  const settled = new Set<string>((state.settled as string[] | undefined) ?? []);
  for (const mk of snap.markets) {
    for (const oc of mk.outcomes) changes.push(input.account.onMarket(VENUE, oc.tokenId, snapshotOf(oc, input.now.getTime())));
    if (mk.resolvedOutcome && !settled.has(mk.marketId)) {
      settled.add(mk.marketId);
      for (const oc of mk.outcomes) changes.push(input.account.settleOutcome(VENUE, oc.tokenId, oc.outcome === mk.resolvedOutcome ? 1 : 0, input.now));
      decisions.push({ ts: input.now.getTime(), action: 'SETTLED', detail: `${mk.question} resolved: ${mk.resolvedOutcome}` });
    }
  }
  const ctx: PMContext<P> = {
    params: input.params,
    now: input.now.getTime(),
    state,
    account: input.account,
    holding: (t) => input.account.position(VENUE, t)?.quantity.toNumber() ?? 0,
    openOrders: (t) => openOrdersOf(input.account, t),
    cancel: (id, reason) => changes.push(input.account.cancelOrder(id, input.now, reason)),
    log: (action, detail, data) => decisions.push({ ts: input.now.getTime(), action, detail, data }),
  };
  const live: PredictionMarketSnapshot = { ...snap, markets: snap.markets.filter((mk) => !settled.has(mk.marketId)) };
  const intents = strategy.onSnapshot(live, ctx);
  const byToken = new Map<string, OutcomeBook>();
  for (const mk of live.markets) for (const oc of mk.outcomes) byToken.set(oc.tokenId, oc);
  let k = 0;
  for (const intent of intents) {
    const oc = byToken.get(intent.tokenId);
    if (!oc) continue;
    const res = input.account.submitOrder(
      { clientOrderId: `pm-${input.now.getTime()}-${++k}`, instrument: instrumentOf(oc), side: intent.side, type: intent.type, quantity: d(intent.quantity), limitPrice: intent.limitPrice, postOnly: intent.postOnly, reason: intent.reason },
      snapshotOf(oc, input.now.getTime()),
    );
    changes.push(res.changes);
    decisions.push({ ts: input.now.getTime(), action: res.order.status === 'REJECTED' ? 'ORDER_REJECTED' : 'ORDER', detail: `${intent.side} ${intent.quantity} ${oc.outcome} (${oc.question}): ${intent.reason}${res.order.rejectReason ? ` — ${res.order.rejectReason}` : ''}` });
  }
  state.settled = [...settled];
  return { changes, state, decisions };
}

function openOrdersOf(account: PaperAccount, tokenId?: string) {
  return account
    .openOrders()
    .filter((x) => !tokenId || x.instrument.symbol === tokenId)
    .map((x) => ({ id: x.id, side: x.side, limitPrice: x.limitPrice?.toNumber() ?? null, remaining: x.quantity.minus(x.filledQuantity).toNumber() }));
}

export function requirePM(data: DataBundle): PredictionMarketSnapshot[] {
  if (!data.pmSeries || data.pmSeries.length === 0) throw new DataUnavailableError('prediction-market snapshots required');
  return data.pmSeries;
}

function scaleFees(o: OutcomeBook, m: number): OutcomeBook {
  return m === 1 ? o : { ...o, feeRate: o.feeRate * m };
}

/** A resolution expressed as a fill so round-trip trades include it. */
function settlementFill(tokenId: string, qty: number, avgPrice: number, payout: number, ts: Date): FillState {
  return {
    id: `settle-${tokenId}-${ts.getTime()}`,
    orderId: 'settlement',
    venue: VENUE,
    symbol: tokenId,
    side: 'SELL',
    quantity: d(qty),
    price: d(payout),
    fee: d(0),
    slippageCost: d(0),
    liquidity: 'TAKER',
    realizedPnl: d((payout - avgPrice) * qty),
    ts,
  };
}

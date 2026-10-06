import { z } from 'zod';
import { DataUnavailableError, Rng, d, mean, type Bar, type FundingRatePoint } from '@aoc/core';
import { PaperAccount, type EngineChanges, type Instrument, type MarketSnapshot } from '@aoc/paper-engine';
import { computeMetrics, syntheticBars } from '@aoc/backtest';
import { VENUE_COSTS, type BacktestResult, type DataBundle, type DecisionLog, type EquityPoint, type PaperStepOutput, type StrategyMeta, type StrategyModule, type TradeRecord } from '@aoc/strategies';

export interface FundingParams {
  symbol: string;
  /** Trailing funding periods averaged for the decision. */
  lookback: number;
  /** Enter when the trailing average rate per period is at least this. */
  entryRate: number;
  /** Exit when it falls to this or below. */
  exitRate: number;
  /** Share of equity per leg (two legs, fully collateralised). */
  legFraction: number;
  spreadBps: number;
  slippageBps: number;
}

export const fundingMeta: StrategyMeta<FundingParams> = {
  id: 'arb.funding-rate',
  name: 'Funding-Rate Arbitrage (Cash and Carry)',
  kind: 'ARBITRAGE',
  category: 'FUNDING_ARBITRAGE',
  version: '1.0.0',
  description: 'When perpetual funding has been persistently positive, holds long spot BTC and an equal short BTC perpetual (delta-neutral) to collect funding; unwinds when funding fades.',
  hypothesis: 'Positive funding on BTC perpetuals persists long enough that the carry collected exceeds the four taker fees and the basis risk of entering and exiting.',
  edgeRationale: 'Funding transfers from leveraged longs to shorts when perps trade above spot. It is a risk premium for providing short exposure; it shrinks as more capital does this trade and can turn negative quickly.',
  knownRisks: ['Funding turns negative', 'Basis widens against the position at exit', 'Exchange/counterparty risk on the perp venue', 'Liquidation of the short leg in a squeeze if under-collateralised (paper model is fully collateralised)'],
  defaultParams: { symbol: 'BTCUSDT', lookback: 3, entryRate: 0.0001, exitRate: 0.00002, legFraction: 0.45, spreadBps: 2, slippageBps: 2 },
  paramsSchema: z.object({
    symbol: z.string().min(1),
    lookback: z.number().int().min(1).max(100),
    entryRate: z.number(),
    exitRate: z.number(),
    legFraction: z.number().gt(0).lte(0.5),
    spreadBps: z.number().min(0),
    slippageBps: z.number().min(0),
  }),
  paramSpace: { entryRate: { type: 'float', min: 0.00005, max: 0.00015, step: 0.00005 }, lookback: { type: 'int', min: 3, max: 9, step: 3 } },
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: true, walkForward: true, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: { automation: 90, scalability: 75, operationalSimplicity: 65, recurringRevenue: 55, competition: 30, dependencySafety: 45, dataAvailability: 90, executionSafety: 65, timeToRevenueDays: 14 },
};

const SPOT_VENUE = 'binance';
const PERP_VENUE = 'binance-futures';

function instruments(symbol: string): { spot: Instrument; perp: Instrument } {
  return {
    spot: { venue: SPOT_VENUE, symbol, kind: 'SPOT', feeModel: VENUE_COSTS[SPOT_VENUE]!.feeModel },
    perp: { venue: PERP_VENUE, symbol: `${symbol}-PERP`, kind: 'PERP', feeModel: VENUE_COSTS[PERP_VENUE]!.feeModel },
  };
}

function market(price: number, spreadBps: number, ts: number): MarketSnapshot {
  const half = (spreadBps / 2) * 1e-4 * price;
  return { ts: new Date(ts), bid: price - half, ask: price + half, assumeInfiniteDepth: true };
}

/** Spot close at or before `ts` (never after: no look-ahead). */
function spotAt(bars: Bar[], ts: number, from = 0): { price: number; idx: number } | null {
  let idx = -1;
  for (let i = from; i < bars.length; i++) {
    if ((bars[i] as Bar).ts + 0 <= ts) idx = i;
    else break;
  }
  return idx >= 0 ? { price: (bars[idx] as Bar).close, idx } : null;
}

interface CarryState {
  open: boolean;
  qty: number;
  entryTs: number;
  entrySpot: number;
  entryPerp: number;
  fees: number;
  carry: number;
  history: number[];
}

function step(
  account: PaperAccount,
  p: FundingParams,
  f: FundingRatePoint,
  spot: number,
  st: CarryState,
  inst: ReturnType<typeof instruments>,
  changes: EngineChanges[],
  log: (dl: DecisionLog) => void,
  costMultiplier: number,
): TradeRecord | null {
  const perpPrice = f.markPrice && f.markPrice > 0 ? f.markPrice : spot;
  const spread = p.spreadBps * costMultiplier;
  // 1. funding for the period that just ended is paid to/by the open short
  if (st.open) {
    const c = account.applyFunding(PERP_VENUE, inst.perp.symbol, f.rate, perpPrice, new Date(f.fundingTime));
    changes.push(c);
    const received = c.transactions.reduce((a, t) => a + t.amount.toNumber(), 0);
    st.carry += received;
  }
  st.history.push(f.rate);
  if (st.history.length > p.lookback) st.history.shift();
  const avg = mean(st.history);
  account.mark(SPOT_VENUE, inst.spot.symbol, spot, new Date(f.fundingTime));
  account.mark(PERP_VENUE, inst.perp.symbol, perpPrice, new Date(f.fundingTime));

  // 2. decide on information up to and including this funding print
  if (!st.open && st.history.length >= p.lookback && avg >= p.entryRate) {
    const equity = account.snapshot().equity.toNumber();
    const qty = Math.floor(((equity * p.legFraction) / spot) * 1e6) / 1e6;
    if (qty <= 0) return null;
    const ts = f.fundingTime;
    const a = account.submitOrder({ clientOrderId: `carry-spot-${ts}`, instrument: inst.spot, side: 'BUY', type: 'MARKET', quantity: d(qty), reason: 'carry entry' }, market(spot, spread, ts));
    const b = account.submitOrder({ clientOrderId: `carry-perp-${ts}`, instrument: inst.perp, side: 'SELL', type: 'MARKET', quantity: d(qty), reason: 'carry entry' }, market(perpPrice, spread, ts));
    changes.push(a.changes, b.changes);
    if (a.order.status !== 'FILLED' || b.order.status !== 'FILLED') {
      log({ ts, action: 'ENTRY_FAILED', detail: `${a.order.rejectReason ?? ''} ${b.order.rejectReason ?? ''}`.trim() });
      return null;
    }
    st.open = true;
    st.qty = qty;
    st.entryTs = ts;
    st.entrySpot = a.order.avgFillPrice!.toNumber();
    st.entryPerp = b.order.avgFillPrice!.toNumber();
    st.fees = [...a.changes.fills, ...b.changes.fills].reduce((x, fl) => x + fl.fee.toNumber(), 0);
    st.carry = 0;
    log({ ts, action: 'ENTER', detail: `trailing funding ${(avg * 100).toFixed(4)}%/period ≥ ${(p.entryRate * 100).toFixed(4)}%: long ${qty} spot / short perp` });
    return null;
  }
  if (st.open && avg <= p.exitRate) {
    const ts = f.fundingTime;
    const a = account.submitOrder({ clientOrderId: `carry-spot-exit-${ts}`, instrument: inst.spot, side: 'SELL', type: 'MARKET', quantity: d(st.qty), reduceOnly: true, reason: 'carry exit' }, market(spot, spread, ts));
    const b = account.submitOrder({ clientOrderId: `carry-perp-exit-${ts}`, instrument: inst.perp, side: 'BUY', type: 'MARKET', quantity: d(st.qty), reduceOnly: true, reason: 'carry exit' }, market(perpPrice, spread, ts));
    changes.push(a.changes, b.changes);
    const exitSpot = a.order.avgFillPrice?.toNumber() ?? spot;
    const exitPerp = b.order.avgFillPrice?.toNumber() ?? perpPrice;
    const fees = st.fees + [...a.changes.fills, ...b.changes.fills].reduce((x, fl) => x + fl.fee.toNumber(), 0);
    const gross = st.qty * (exitSpot - st.entrySpot) + st.qty * (st.entryPerp - exitPerp);
    const net = gross - fees + st.carry;
    const t: TradeRecord = { id: `carry-${st.entryTs}`, symbol: p.symbol, direction: 'LONG', entryTs: st.entryTs, exitTs: ts, entryPrice: st.entrySpot, exitPrice: exitSpot, quantity: st.qty, grossPnl: gross, fees, slippage: 0, carry: st.carry, netPnl: net, returnPct: net / (st.qty * st.entrySpot * 2), reason: 'funding carry' };
    log({ ts, action: 'EXIT', detail: `trailing funding ${(avg * 100).toFixed(4)}% ≤ exit ${(p.exitRate * 100).toFixed(4)}%: carry ${st.carry.toFixed(2)}, fees ${fees.toFixed(2)}, basis P&L ${gross.toFixed(2)}` });
    st.open = false;
    return t;
  }
  return null;
}

export function runFundingCarry(p: FundingParams, bars: Bar[], funding: FundingRatePoint[], initialCapital: number, provenance: BacktestResult['provenance'], label: string, costMultiplier = 1, window?: { startTs: number; endTs: number }): BacktestResult {
  const pts = funding.filter((f) => !window || (f.fundingTime >= window.startTs && f.fundingTime < window.endTs)).sort((a, b) => a.fundingTime - b.fundingTime);
  if (pts.length < p.lookback + 2) throw new DataUnavailableError(`need at least ${p.lookback + 2} funding points, have ${pts.length}`);
  const inst = instruments(p.symbol);
  const { account } = PaperAccount.open({ startingCapital: initialCapital, ts: new Date(pts[0]!.fundingTime) }, { slippage: { fixedBps: p.slippageBps * costMultiplier, impactBpsPer10k: 0 } });
  const st: CarryState = { open: false, qty: 0, entryTs: 0, entrySpot: 0, entryPerp: 0, fees: 0, carry: 0, history: [] };
  const trades: TradeRecord[] = [];
  const equity: EquityPoint[] = [];
  const changes: EngineChanges[] = [];
  let from = 0;
  let skipped = 0;
  for (const f of pts) {
    const s = spotAt(bars, f.fundingTime, from);
    if (!s) {
      skipped++;
      continue;
    }
    from = s.idx;
    const t = step(account, p, f, s.price, st, inst, changes, () => undefined, costMultiplier);
    if (t) trades.push(t);
    equity.push({ ts: f.fundingTime, equity: account.snapshot().equity.toNumber() });
  }
  const notes = [`${pts.length} funding periods evaluated${skipped ? `, ${skipped} skipped for missing spot prices` : ''}`];
  if (st.open) notes.push('a carry position is still open at the end of the data (included at mark-to-market)');
  if (!pts.some((f) => f.markPrice)) notes.push('no perp mark prices in the data: perp assumed to trade at spot (basis risk not captured)');
  const metrics = computeMetrics({ equityCurve: equity, trades, initialCapital, periodMs: 8 * 3_600_000 });
  return {
    provenance,
    datasetLabel: label,
    startTs: pts[0]!.fundingTime,
    endTs: pts[pts.length - 1]!.fundingTime,
    initialCapital,
    equityCurve: equity,
    trades,
    metrics,
    capacityUsd: null,
    notes,
    grossExpectancy: trades.length > 0 ? trades.reduce((a, t) => a + t.grossPnl + t.carry, 0) / trades.length : null,
  };
}

/**
 * DEMO funding: an AR(1) process around 0.01% per 8h — the default interest
 * component of Binance's funding formula, i.e. what funding is when the
 * premium is near zero — with noise that regularly turns it negative.
 */
export function syntheticFunding(seed: string, symbol: string, periods = 1095): { bars: Bar[]; funding: FundingRatePoint[] } {
  const rng = new Rng(`synthetic-funding/${seed}`);
  const t0 = Date.UTC(2025, 0, 1);
  const bars = syntheticBars({ seed: `${seed}/spot`, bars: periods * 8 + 8, intervalMs: 3_600_000, startTs: t0, startPrice: 60_000, vol: 0.006, avgVolume: 500 });
  const funding: FundingRatePoint[] = [];
  let r = 0.0001;
  for (let i = 1; i <= periods; i++) {
    r = 0.0001 + 0.85 * (r - 0.0001) + rng.normal(0, 0.00008);
    const ts = t0 + i * 8 * 3_600_000;
    const spot = bars[i * 8 - 1]!.close;
    funding.push({ venue: PERP_VENUE, symbol, fundingTime: ts, rate: r, markPrice: spot * (1 + r * 3 + rng.normal(0, 0.0002)) });
  }
  return { bars, funding };
}

export const fundingModule: StrategyModule<FundingParams> = {
  meta: fundingMeta,
  dataRequirements: (p) => [
    { kind: 'BARS', venue: SPOT_VENUE, symbol: p.symbol, interval: '1h', minBars: 24 * 90 },
    { kind: 'FUNDING', venue: PERP_VENUE, symbol: p.symbol, minPoints: 90 },
  ],
  syntheticData: (p, seed): DataBundle => {
    const s = syntheticFunding(seed, p.symbol);
    return { provenance: 'DEMO', label: `DEMO synthetic funding (AR(1) around 0.01%/8h) + random-walk spot (seed ${seed})`, bars: { [p.symbol]: s.bars }, funding: { [p.symbol]: s.funding } };
  },
  backtest: (input) => {
    const bars = input.data.bars?.[input.params.symbol];
    const funding = input.data.funding?.[input.params.symbol];
    if (!bars || !funding) throw new DataUnavailableError('spot bars and funding history required');
    return runFundingCarry(input.params, bars, funding, input.initialCapital, input.data.provenance === 'HISTORICAL' ? 'HISTORICAL' : 'DEMO', input.data.label, input.costMultiplier ?? 1, input.window);
  },
  paperStep: (input): PaperStepOutput => {
    const decisions: DecisionLog[] = [];
    const changes: EngineChanges[] = [];
    const state = { ...input.state };
    const p = input.params;
    const funding = (input.live.funding?.[p.symbol] ?? []).slice().sort((a, b) => a.fundingTime - b.fundingTime);
    const bars = input.live.bars?.[p.symbol] ?? [];
    const st: CarryState = (state.carry as CarryState | undefined) ?? { open: false, qty: 0, entryTs: 0, entrySpot: 0, entryPerp: 0, fees: 0, carry: 0, history: [] };
    const lastSeen = state.lastFundingTime as number | undefined;
    if (lastSeen === undefined) {
      // First tick: warm the trailing window from history, but never trade on the past.
      const past = funding.filter((f) => f.fundingTime <= input.now.getTime());
      st.history = past.slice(-p.lookback).map((f) => f.rate);
      state.lastFundingTime = past.length > 0 ? past[past.length - 1]!.fundingTime : input.now.getTime();
      state.carry = st;
      decisions.push({ ts: input.now.getTime(), action: 'WARMUP', detail: `trailing window initialised from ${st.history.length} past funding prints` });
      return { changes, state, decisions };
    }
    const fresh = funding.filter((f) => f.fundingTime > lastSeen && f.fundingTime <= input.now.getTime());
    if (fresh.length === 0) {
      decisions.push({ ts: input.now.getTime(), action: 'WAIT', detail: 'no new funding print since the last tick' });
      state.carry = st;
      return { changes, state, decisions };
    }
    const inst = instruments(p.symbol);
    for (const f of fresh) {
      const s = spotAt(bars, f.fundingTime);
      if (!s) {
        decisions.push({ ts: f.fundingTime, action: 'NO_DATA', detail: 'no spot price at the funding time' });
        continue;
      }
      step(input.account, p, f, s.price, st, inst, changes, (dl) => decisions.push(dl), 1);
      state.lastFundingTime = f.fundingTime;
    }
    state.carry = st;
    return { changes, state, decisions };
  },
};

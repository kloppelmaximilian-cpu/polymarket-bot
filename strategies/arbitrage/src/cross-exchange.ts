import { z } from 'zod';
import { DataUnavailableError, Rng, d, type Quote } from '@aoc/core';
import { PaperAccount, type EngineChanges, type Instrument, type MarketSnapshot } from '@aoc/paper-engine';
import { computeMetrics } from '@aoc/backtest';
import {
  VENUE_COSTS,
  type BacktestResult,
  type DataBundle,
  type DecisionLog,
  type EquityPoint,
  type PaperStepOutput,
  type QuoteSnapshot,
  type StrategyMeta,
  type StrategyModule,
  type TradeRecord,
} from '@aoc/strategies';

export interface CrossExchangeParams {
  venues: string[];
  /** Net edge after both taker fees and slippage, in bps of the buy price. */
  minEdgeBps: number;
  maxTradeNotional: number;
  /** Share of capital held as BTC inventory, split across venues. */
  inventoryFraction: number;
  slippageBps: number;
  /** Cost of moving inventory between venues (network/withdrawal fee), USD per transfer. */
  transferCostUsd: number;
  /** Rebalance when a venue's BTC or USD falls below this share of its target. */
  rebalanceBelow: number;
}

export const crossExchangeMeta: StrategyMeta<CrossExchangeParams> = {
  id: 'arb.cross-exchange',
  name: 'Crypto Cross-Exchange Arbitrage',
  kind: 'ARBITRAGE',
  category: 'ARBITRAGE',
  version: '1.0.0',
  description: 'Holds BTC and USD on several exchanges; when one venue’s bid exceeds another’s ask by more than both taker fees and slippage, buys on the cheap venue and sells on the expensive one simultaneously. Rebalances inventory when it drifts.',
  hypothesis: 'Price dislocations between major BTC venues exceed round-trip taker costs often enough, and with enough size, to earn more than inventory rebalancing costs.',
  edgeRationale: 'Pure spatial arbitrage. At retail fee tiers the round trip costs tens of basis points while major-venue dislocations are usually a few basis points and are competed away in milliseconds by colocated firms — so the expected result is "no edge" unless fees are much lower.',
  knownRisks: ['Leg risk (one side fills, the other moves)', 'Latency vs professional arbitrageurs', 'Inventory price risk while holding BTC on venues', 'Transfer delays and withdrawal limits', 'Counterparty risk of each exchange'],
  defaultParams: { venues: ['binance', 'coinbase', 'kraken'], minEdgeBps: 5, maxTradeNotional: 1000, inventoryFraction: 0.5, slippageBps: 2, transferCostUsd: 10, rebalanceBelow: 0.25 },
  paramsSchema: z.object({
    venues: z.array(z.string()).min(2),
    minEdgeBps: z.number().min(0),
    maxTradeNotional: z.number().gt(0),
    inventoryFraction: z.number().gt(0).lt(1),
    slippageBps: z.number().min(0),
    transferCostUsd: z.number().min(0),
    rebalanceBelow: z.number().min(0).max(1),
  }),
  paramSpace: { minEdgeBps: { type: 'float', min: 0, max: 10, step: 5 } },
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: true, walkForward: false, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: { automation: 90, scalability: 30, operationalSimplicity: 45, recurringRevenue: 20, competition: 10, dependencySafety: 35, dataAvailability: 85, executionSafety: 40, timeToRevenueDays: 30 },
};

const SYMBOL = 'BTC-USD';
const inst = (venue: string): Instrument => {
  const c = VENUE_COSTS[venue];
  if (!c) throw new DataUnavailableError(`no cost model for venue ${venue}`);
  return { venue, symbol: `BTC@${venue}`, kind: 'SPOT', feeModel: c.feeModel };
};
const feeRate = (venue: string): number => {
  const f = VENUE_COSTS[venue]?.feeModel;
  return f && f.type === 'bps' ? f.takerBps / 10_000 : 0;
};
const snapshotOf = (q: Quote, ts: number): MarketSnapshot => ({ ts: new Date(ts), bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize });

interface ArbState {
  usd: Record<string, number>;
  btcTarget: number;
  usdTarget: number;
  rebalances: number;
  initialized: boolean;
}

interface Opportunity {
  buy: Quote;
  sell: Quote;
  qty: number;
  edgeBps: number;
}

function findOpportunity(quotes: Quote[], p: CrossExchangeParams, st: ArbState, account: PaperAccount, costMultiplier: number): Opportunity | null {
  let best: Opportunity | null = null;
  for (const a of quotes) {
    for (const b of quotes) {
      if (a.venue === b.venue) continue;
      const costs = (feeRate(a.venue) + feeRate(b.venue) + (2 * p.slippageBps) / 10_000) * costMultiplier;
      const edge = (b.bid * (1 - costs / 2) - a.ask * (1 + costs / 2)) / a.ask;
      const edgeBps = edge * 10_000;
      if (edgeBps < p.minEdgeBps) continue;
      const btcOnB = account.position(b.venue, `BTC@${b.venue}`)?.quantity.toNumber() ?? 0;
      const usdOnA = st.usd[a.venue] ?? 0;
      const qty = Math.min(a.askSize ?? Infinity, b.bidSize ?? Infinity, (usdOnA * 0.98) / a.ask, btcOnB, p.maxTradeNotional / a.ask);
      if (!(qty * a.ask >= 10)) continue;
      if (!best || edgeBps > best.edgeBps) best = { buy: a, sell: b, qty: Math.floor(qty * 1e6) / 1e6, edgeBps };
    }
  }
  return best;
}

function setup(account: PaperAccount, quotes: Quote[], p: CrossExchangeParams, ts: number, changes: EngineChanges[]): ArbState {
  const capital = account.snapshot().equity.toNumber();
  const venues = p.venues.filter((v) => quotes.some((q) => q.venue === v));
  const perVenueUsd = (capital * (1 - p.inventoryFraction)) / venues.length;
  const perVenueBtcUsd = (capital * p.inventoryFraction) / venues.length;
  const usd: Record<string, number> = {};
  let btcTarget = 0;
  for (const v of venues) {
    const q = quotes.find((x) => x.venue === v)!;
    const qty = Math.floor((perVenueBtcUsd / (q.ask * (1 + feeRate(v)))) * 1e6) / 1e6;
    const res = account.submitOrder({ clientOrderId: `inv-${v}-${ts}`, instrument: inst(v), side: 'BUY', type: 'MARKET', quantity: d(qty), reason: 'initial inventory' }, { ...snapshotOf(q, ts), assumeInfiniteDepth: true });
    changes.push(res.changes);
    usd[v] = perVenueUsd;
    btcTarget = qty;
  }
  return { usd, btcTarget, usdTarget: perVenueUsd, rebalances: 0, initialized: true };
}

/** Execute one opportunity against (possibly newer) quotes; returns a trade record if both legs filled. */
function execute(account: PaperAccount, opp: Opportunity, buyQ: Quote, sellQ: Quote, ts: number, st: ArbState, id: string, changes: EngineChanges[], log: (d: DecisionLog) => void): TradeRecord | null {
  const tolerance = 0.0005;
  const buy = account.submitOrder({ clientOrderId: `${id}-buy`, instrument: inst(opp.buy.venue), side: 'BUY', type: 'MARKET', quantity: d(opp.qty), limitPrice: opp.buy.ask * (1 + tolerance), reason: `arb buy (${opp.edgeBps.toFixed(1)} bps)` }, snapshotOf(buyQ, ts));
  changes.push(buy.changes);
  const bought = buy.order.filledQuantity.toNumber();
  if (bought <= 0) {
    log({ ts, action: 'ARB_MISSED', detail: `buy leg on ${opp.buy.venue} did not fill: ${buy.order.rejectReason}` });
    return null;
  }
  const sell = account.submitOrder({ clientOrderId: `${id}-sell`, instrument: inst(opp.sell.venue), side: 'SELL', type: 'MARKET', quantity: d(bought), limitPrice: opp.sell.bid * (1 - tolerance), reason: 'arb sell' }, snapshotOf(sellQ, ts));
  changes.push(sell.changes);
  const sold = sell.order.filledQuantity.toNumber();
  const buyPx = buy.order.avgFillPrice!.toNumber();
  const buyFees = buy.changes.fills.reduce((a, f) => a + f.fee.toNumber(), 0);
  st.usd[opp.buy.venue] = (st.usd[opp.buy.venue] ?? 0) - bought * buyPx - buyFees;
  if (sold <= 0) {
    log({ ts, action: 'LEG_RISK', detail: `sell leg on ${opp.sell.venue} failed (${sell.order.rejectReason}); holding ${bought} BTC unhedged on ${opp.buy.venue}` });
    return null;
  }
  const sellPx = sell.order.avgFillPrice!.toNumber();
  const sellFees = sell.changes.fills.reduce((a, f) => a + f.fee.toNumber(), 0);
  st.usd[opp.sell.venue] = (st.usd[opp.sell.venue] ?? 0) + sold * sellPx - sellFees;
  const gross = sold * (sellPx - buyPx);
  const fees = buyFees + sellFees;
  const slip = [...buy.changes.fills, ...sell.changes.fills].reduce((a, f) => a + f.slippageCost.toNumber(), 0);
  log({ ts, action: 'ARB', detail: `bought ${bought} on ${opp.buy.venue} @ ${buyPx.toFixed(2)}, sold ${sold} on ${opp.sell.venue} @ ${sellPx.toFixed(2)}, net ${(gross - fees).toFixed(2)}` });
  return { id, symbol: SYMBOL, direction: 'LONG', entryTs: ts, exitTs: ts, entryPrice: buyPx, exitPrice: sellPx, quantity: sold, grossPnl: gross, fees, slippage: slip, carry: 0, netPnl: gross - fees, returnPct: (gross - fees) / (sold * buyPx), reason: `${opp.buy.venue}→${opp.sell.venue}` };
}

function maybeRebalance(account: PaperAccount, st: ArbState, p: CrossExchangeParams, ts: number, changes: EngineChanges[], log: (d: DecisionLog) => void): void {
  for (const v of Object.keys(st.usd)) {
    const btc = account.position(v, `BTC@${v}`)?.quantity.toNumber() ?? 0;
    const usd = st.usd[v] ?? 0;
    if (btc < st.btcTarget * p.rebalanceBelow || usd < st.usdTarget * p.rebalanceBelow) {
      // Inventory is moved between venues; the cost is the transfer fee. Holdings are
      // re-pooled across venues, which in reality takes minutes to hours.
      changes.push(account.recordOperating('COST', p.transferCostUsd, new Date(ts), { category: 'transfer', description: `rebalance inventory (${v})` }));
      const venues = Object.keys(st.usd);
      const totalUsd = venues.reduce((a, x) => a + (st.usd[x] ?? 0), 0) - p.transferCostUsd;
      for (const x of venues) st.usd[x] = totalUsd / venues.length;
      st.rebalances++;
      log({ ts, action: 'REBALANCE', detail: `inventory on ${v} below ${(p.rebalanceBelow * 100).toFixed(0)}% of target; transfer cost ${p.transferCostUsd}` });
      return;
    }
  }
}

export function runCrossExchange(params: CrossExchangeParams, series: QuoteSnapshot[], initialCapital: number, provenance: BacktestResult['provenance'], label: string, costMultiplier = 1): BacktestResult {
  if (series.length < 3) throw new DataUnavailableError('need at least 3 quote snapshots');
  const filter = (s: QuoteSnapshot) => s.quotes.filter((q) => params.venues.includes(q.venue) && q.bid > 0 && q.ask > q.bid);
  const { account } = PaperAccount.open({ startingCapital: initialCapital, ts: new Date(series[0]!.ts) }, { slippage: { fixedBps: params.slippageBps * costMultiplier, impactBpsPer10k: 0 } });
  const changes: EngineChanges[] = [];
  const st = setup(account, filter(series[0]!), params, series[0]!.ts, changes);
  const trades: TradeRecord[] = [];
  const equity: EquityPoint[] = [];
  const notes: string[] = [];
  let missed = 0;
  let legRisk = 0;
  let opportunities = 0;
  const log = (dl: DecisionLog) => {
    if (dl.action === 'ARB_MISSED') missed++;
    if (dl.action === 'LEG_RISK') legRisk++;
  };
  for (let i = 1; i < series.length; i++) {
    const prev = filter(series[i - 1]!);
    const cur = filter(series[i]!);
    const ts = series[i]!.ts;
    for (const q of cur) account.onMarket(q.venue, `BTC@${q.venue}`, snapshotOf(q, ts));
    // Decided on the previous snapshot, executed on this one (latency).
    const opp = findOpportunity(prev, params, st, account, costMultiplier);
    if (opp) {
      opportunities++;
      const bq = cur.find((q) => q.venue === opp.buy.venue);
      const sq = cur.find((q) => q.venue === opp.sell.venue);
      if (bq && sq) {
        const t = execute(account, opp, bq, sq, ts, st, `arb-${i}`, changes, log);
        if (t) trades.push(t);
      }
    }
    maybeRebalance(account, st, params, ts, changes, log);
    equity.push({ ts, equity: account.snapshot().equity.toNumber() });
  }
  notes.push(`${opportunities} opportunities seen, ${trades.length} completed, ${missed} missed, ${legRisk} with leg risk, ${st.rebalances} rebalances`);
  notes.push('Equity includes the mark-to-market of the BTC inventory held on venues; spread capture alone is the sum of trade P&L.');
  const periodMs = series[1]!.ts - series[0]!.ts;
  const metrics = computeMetrics({ equityCurve: equity, trades, initialCapital, periodMs });
  const days = Math.max(1 / 24, (series[series.length - 1]!.ts - series[0]!.ts) / 86_400_000);
  const avgTrade = trades.length > 0 ? trades.reduce((a, t) => a + t.quantity * t.entryPrice, 0) / trades.length : 0;
  return {
    provenance,
    datasetLabel: label,
    startTs: series[0]!.ts,
    endTs: series[series.length - 1]!.ts,
    initialCapital,
    equityCurve: equity,
    trades,
    metrics,
    capacityUsd: trades.length > 0 ? (avgTrade * trades.length) / days : 0,
    notes,
    grossExpectancy: trades.length > 0 ? trades.reduce((a, t) => a + t.grossPnl, 0) / trades.length : null,
  };
}

/** DEMO quotes: one efficient price, venue-specific basis (OU) and spreads, rare dislocations. */
export function syntheticCrossExchange(seed: string, venues: string[], snapshots = 8640, intervalMs = 10_000): QuoteSnapshot[] {
  const rng = new Rng(`synthetic-xex/${seed}`);
  const basis: Record<string, number> = Object.fromEntries(venues.map((v) => [v, 0]));
  const spreadBps: Record<string, number> = { binance: 1, coinbase: 2, kraken: 2 };
  let logP = Math.log(60_000);
  const out: QuoteSnapshot[] = [];
  const t0 = Date.UTC(2025, 3, 1);
  for (let i = 0; i < snapshots; i++) {
    logP += rng.normal(0, 0.0002);
    const quotes: Quote[] = venues.map((v) => {
      let b = basis[v]! * 0.9 + rng.normal(0, 0.00003);
      if (rng.next() < 0.002) b += rng.normal(0, 0.0015); // rare dislocation
      basis[v] = b;
      const mid = Math.exp(logP + b);
      const half = ((spreadBps[v] ?? 2) / 2) * 1e-4 * mid;
      return { venue: v, symbol: SYMBOL, bid: mid - half, ask: mid + half, bidSize: rng.uniform(0.05, 2), askSize: rng.uniform(0.05, 2), ts: t0 + i * intervalMs, receivedAt: t0 + i * intervalMs };
    });
    out.push({ ts: t0 + i * intervalMs, quotes });
  }
  return out;
}

export const crossExchangeModule: StrategyModule<CrossExchangeParams> = {
  meta: crossExchangeMeta,
  dataRequirements: (p) => [{ kind: 'QUOTES', venues: p.venues, symbol: SYMBOL }],
  syntheticData: (p, seed): DataBundle => ({ provenance: 'DEMO', label: `DEMO synthetic cross-venue quotes (seed ${seed})`, quoteSeries: syntheticCrossExchange(seed, p.venues) }),
  backtest: (input) => {
    if (!input.data.quoteSeries) throw new DataUnavailableError('cross-venue quote snapshots required');
    const series = input.window ? input.data.quoteSeries.filter((s) => s.ts >= input.window!.startTs && s.ts < input.window!.endTs) : input.data.quoteSeries;
    return runCrossExchange(input.params, series, input.initialCapital, input.data.provenance === 'HISTORICAL' ? 'HISTORICAL' : 'DEMO', input.data.label, input.costMultiplier ?? 1);
  },
  paperStep: (input): PaperStepOutput => {
    const decisions: DecisionLog[] = [];
    const changes: EngineChanges[] = [];
    const state = { ...input.state };
    const series = input.live.quoteSeries ?? [];
    const latest = series[series.length - 1];
    if (!latest) return { changes, state, decisions: [{ ts: input.now.getTime(), action: 'NO_DATA', detail: 'no live cross-venue quotes' }] };
    const quotes = latest.quotes.filter((q) => input.params.venues.includes(q.venue) && q.bid > 0 && q.ask > q.bid);
    if (quotes.length < 2) return { changes, state, decisions: [{ ts: input.now.getTime(), action: 'NO_DATA', detail: `live quotes from ${quotes.length} venue(s); need 2+` }] };
    const ts = input.now.getTime();
    for (const q of quotes) changes.push(input.account.onMarket(q.venue, `BTC@${q.venue}`, snapshotOf(q, ts)));
    let st = state.arb as ArbState | undefined;
    if (!st?.initialized) {
      st = setup(input.account, quotes, input.params, ts, changes);
      decisions.push({ ts, action: 'SETUP', detail: `bought initial BTC inventory on ${Object.keys(st.usd).join(', ')}` });
    }
    // Live: decide on the previous tick's quotes, execute on this tick's (same latency model as the backtest).
    const prev = (state.prevQuotes as Quote[] | undefined) ?? null;
    if (prev) {
      const opp = findOpportunity(prev, input.params, st, input.account, 1);
      if (opp) {
        const bq = quotes.find((q) => q.venue === opp.buy.venue);
        const sq = quotes.find((q) => q.venue === opp.sell.venue);
        if (bq && sq) execute(input.account, opp, bq, sq, ts, st, `arb-${ts}`, changes, (dl) => decisions.push(dl));
      } else {
        decisions.push({ ts, action: 'SCAN', detail: 'no dislocation above costs' });
      }
    }
    maybeRebalance(input.account, st, input.params, ts, changes, (dl) => decisions.push(dl));
    state.arb = st;
    state.prevQuotes = quotes;
    return { changes, state, decisions };
  },
};

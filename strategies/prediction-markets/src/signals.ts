import { z } from 'zod';
import type { PredictionMarketSnapshot, StrategyMeta } from '@aoc/strategies';
import { takerFeePerShare, type PMContext, type PMIntent, type PMStrategy } from './harness';
import { PM_PROFILE, createPMModule } from './module';

// ─────────────────────────────────────────── mispricing (consistency) ──

export interface MispricingParams {
  minEdge: number;
  stakePerTrade: number;
}

export const mispricingMeta: StrategyMeta<MispricingParams> = {
  id: 'pm.mispricing',
  name: 'Multi-Outcome Mispricing Detection',
  kind: 'PREDICTION_MARKET',
  category: 'PREDICTION_MARKET',
  version: '1.0.0',
  description: 'In multi-outcome events, normalises the outcome mids to sum to 1 and buys outcomes whose ask is below that consistent probability by more than fees and a margin; exits when the bid reaches it.',
  hypothesis: 'Outcome prices within one event drift out of mutual consistency, and the cheap outcomes revert toward the normalised probability before resolution.',
  edgeRationale: 'Relative-value: the event as a whole is priced, individual legs are not always updated together. The normalised mid is itself noisy, so the edge threshold must exceed that noise.',
  knownRisks: ['The normalised mid is only an estimate', 'Thin books', 'Holding to resolution when no reversion happens'],
  defaultParams: { minEdge: 0.03, stakePerTrade: 50 },
  paramsSchema: z.object({ minEdge: z.number().min(0).max(0.5), stakePerTrade: z.number().gt(0) }),
  paramSpace: { minEdge: { type: 'float', min: 0.02, max: 0.05, step: 0.01 } },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: false, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: PM_PROFILE,
};

export class MispricingStrategy implements PMStrategy<MispricingParams> {
  onSnapshot(snap: PredictionMarketSnapshot, ctx: PMContext<MispricingParams>): PMIntent[] {
    const out: PMIntent[] = [];
    for (const mk of snap.markets) {
      if (mk.outcomes.length < 3) continue;
      const mids = mk.outcomes.map((o) => {
        const b = o.book.bids[0]?.price;
        const a = o.book.asks[0]?.price;
        return b !== undefined && a !== undefined ? (a + b) / 2 : NaN;
      });
      if (mids.some((m) => !Number.isFinite(m))) continue;
      const total = mids.reduce((a, b) => a + b, 0);
      mk.outcomes.forEach((o, i) => {
        const fair = (mids[i] as number) / total;
        const held = ctx.holding(o.tokenId);
        const bid = o.book.bids[0]?.price ?? 0;
        if (held > 0 && bid >= fair) {
          out.push({ tokenId: o.tokenId, side: 'SELL', type: 'MARKET', quantity: held, limitPrice: bid, reason: `reverted to consistent price ${fair.toFixed(3)}` });
          return;
        }
        const ask = o.book.asks[0]?.price;
        if (held > 0 || ask === undefined) return;
        const edge = fair - ask - takerFeePerShare(o, ask);
        if (edge >= ctx.params.minEdge) {
          const qty = Math.floor(ctx.params.stakePerTrade / ask);
          if (qty >= 1) out.push({ tokenId: o.tokenId, side: 'BUY', type: 'MARKET', quantity: qty, limitPrice: ask, reason: `ask ${ask.toFixed(2)} below consistent ${fair.toFixed(3)} (edge ${(edge * 100).toFixed(1)}c)` });
        }
      });
    }
    return out;
  }
}

export const mispricingModule = createPMModule<MispricingParams>({ meta: mispricingMeta, create: () => new MispricingStrategy(), executionDelay: 1, query: 'neg-risk multi-outcome events' });

// ───────────────────────────────────────────────── value (external model) ──

export interface ValueParams {
  minEdge: number;
  kellyFraction: number;
  maxStake: number;
  exitWhenEdgeGone: boolean;
}

export const valueMeta: StrategyMeta<ValueParams> = {
  id: 'pm.value',
  name: 'Probability / Value Trading (fractional Kelly)',
  kind: 'PREDICTION_MARKET',
  category: 'PREDICTION_MARKET',
  version: '1.0.0',
  description: 'Buys outcomes whose ask is below an external probability estimate by more than fees and a margin, sized by fractional Kelly; optionally exits when the edge disappears.',
  hypothesis: 'An external probability model is better calibrated than the market price on a subset of markets, by enough to beat the spread and fees.',
  edgeRationale: 'Entirely dependent on the quality of the probability model. The Kelly sizing is fractional because model probabilities are estimates; full Kelly on an overconfident model is ruinous.',
  knownRisks: ['Model overconfidence turns a winning strategy into a losing one', 'Selection bias: the largest disagreements are most often model errors', 'Requires a validated model per market type'],
  defaultParams: { minEdge: 0.04, kellyFraction: 0.25, maxStake: 100, exitWhenEdgeGone: true },
  paramsSchema: z.object({ minEdge: z.number().min(0).max(0.5), kellyFraction: z.number().gt(0).max(1), maxStake: z.number().gt(0), exitWhenEdgeGone: z.boolean() }),
  paramSpace: { minEdge: { type: 'float', min: 0.02, max: 0.06, step: 0.02 }, kellyFraction: { type: 'float', min: 0.1, max: 0.3, step: 0.1 } },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: false, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: { ...PM_PROFILE, dataAvailability: 50 },
};

export class ValueStrategy implements PMStrategy<ValueParams> {
  onSnapshot(snap: PredictionMarketSnapshot, ctx: PMContext<ValueParams>): PMIntent[] {
    const out: PMIntent[] = [];
    if (!snap.fair) return out;
    const equity = ctx.account.snapshot().equity.toNumber();
    for (const mk of snap.markets) {
      for (const o of mk.outcomes) {
        const fair = snap.fair[o.tokenId];
        if (fair === undefined) continue;
        const held = ctx.holding(o.tokenId);
        const bid = o.book.bids[0]?.price;
        if (held > 0) {
          if (ctx.params.exitWhenEdgeGone && bid !== undefined && bid >= fair) out.push({ tokenId: o.tokenId, side: 'SELL', type: 'MARKET', quantity: held, limitPrice: bid, reason: `edge gone (bid ${bid.toFixed(2)} ≥ model ${fair.toFixed(3)})` });
          continue;
        }
        const ask = o.book.asks[0]?.price;
        if (ask === undefined) continue;
        const cost = ask + takerFeePerShare(o, ask);
        const edge = fair - cost;
        if (edge < ctx.params.minEdge) continue;
        const kelly = (fair - cost) / (1 - cost); // binary payoff of 1 bought at `cost`
        const stake = Math.min(ctx.params.maxStake, Math.max(0, kelly * ctx.params.kellyFraction * equity));
        const qty = Math.floor(stake / ask);
        if (qty >= 1) out.push({ tokenId: o.tokenId, side: 'BUY', type: 'MARKET', quantity: qty, limitPrice: ask, reason: `model ${fair.toFixed(3)} vs ask ${ask.toFixed(2)}: edge ${(edge * 100).toFixed(1)}c, Kelly ${(kelly * 100).toFixed(1)}%` });
      }
    }
    return out;
  }
}

export const valueModule = createPMModule<ValueParams>({ meta: valueMeta, create: () => new ValueStrategy(), executionDelay: 1, query: 'markets covered by a validated probability model' });

// ─────────────────────────────────────────────────── order-book imbalance ──

export interface ImbalanceParams {
  levels: number;
  threshold: number;
  holdSnapshots: number;
  stake: number;
}

export const imbalanceMeta: StrategyMeta<ImbalanceParams> = {
  id: 'pm.orderbook-imbalance',
  name: 'Order-Book Imbalance Signals',
  kind: 'PREDICTION_MARKET',
  category: 'PREDICTION_MARKET',
  version: '1.0.0',
  description: 'Buys an outcome when resting bid depth heavily outweighs ask depth on the top levels, and exits after a fixed holding time or when the imbalance flips.',
  hypothesis: 'Depth imbalance on prediction-market books predicts the direction of the next price move by enough to beat crossing the spread twice.',
  edgeRationale: 'Order-flow imbalance predicts short-term moves in many markets (Cont, Kukanov & Stoikov 2014), but crossing the spread twice is expensive at 1–2 cent ticks.',
  knownRisks: ['Spoofed or stale depth', 'Two spread crossings per trade', 'Signal decays within seconds on active markets'],
  defaultParams: { levels: 2, threshold: 0.6, holdSnapshots: 6, stake: 50 },
  paramsSchema: z.object({ levels: z.number().int().min(1).max(10), threshold: z.number().gt(0).lt(1), holdSnapshots: z.number().int().min(1).max(1000), stake: z.number().gt(0) }),
  paramSpace: { threshold: { type: 'float', min: 0.4, max: 0.8, step: 0.2 }, holdSnapshots: { type: 'int', min: 3, max: 9, step: 3 } },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: false, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: { ...PM_PROFILE, executionSafety: 45 },
};

export class ImbalanceStrategy implements PMStrategy<ImbalanceParams> {
  onSnapshot(snap: PredictionMarketSnapshot, ctx: PMContext<ImbalanceParams>): PMIntent[] {
    const out: PMIntent[] = [];
    const opened = (ctx.state.opened as Record<string, number> | undefined) ?? {};
    const step = ((ctx.state.step as number | undefined) ?? 0) + 1;
    ctx.state.step = step;
    for (const mk of snap.markets) {
      for (const o of mk.outcomes) {
        const bids = o.book.bids.slice(0, ctx.params.levels).reduce((a, l) => a + l.size, 0);
        const asks = o.book.asks.slice(0, ctx.params.levels).reduce((a, l) => a + l.size, 0);
        const imb = bids + asks > 0 ? (bids - asks) / (bids + asks) : 0;
        const held = ctx.holding(o.tokenId);
        if (held > 0) {
          const age = step - (opened[o.tokenId] ?? step);
          const bid = o.book.bids[0]?.price;
          if ((age >= ctx.params.holdSnapshots || imb < 0) && bid !== undefined) {
            out.push({ tokenId: o.tokenId, side: 'SELL', type: 'MARKET', quantity: held, limitPrice: bid, reason: age >= ctx.params.holdSnapshots ? 'holding time reached' : 'imbalance flipped' });
            delete opened[o.tokenId];
          }
          continue;
        }
        const ask = o.book.asks[0]?.price;
        if (imb >= ctx.params.threshold && ask !== undefined && ask < 0.95) {
          const qty = Math.floor(ctx.params.stake / ask);
          if (qty >= 1) {
            out.push({ tokenId: o.tokenId, side: 'BUY', type: 'MARKET', quantity: qty, limitPrice: ask, reason: `bid-heavy book (imbalance ${imb.toFixed(2)})` });
            opened[o.tokenId] = step;
          }
        }
      }
    }
    ctx.state.opened = opened;
    return out;
  }
}

export const imbalanceModule = createPMModule<ImbalanceParams>({ meta: imbalanceMeta, create: () => new ImbalanceStrategy(), executionDelay: 1, query: 'active markets with depth' });

// ───────────────────────────────────────────── near-resolution favourites ──

export interface ResolutionParams {
  minPrice: number;
  maxPrice: number;
  maxHoursToEnd: number;
  stakePerMarket: number;
}

export const resolutionMeta: StrategyMeta<ResolutionParams> = {
  id: 'pm.near-resolution',
  name: 'Resolution / Near-Certainty Harvesting',
  kind: 'PREDICTION_MARKET',
  category: 'PREDICTION_MARKET',
  version: '1.0.0',
  description: 'Buys heavy favourites (e.g. 93–98c) shortly before resolution and holds to settlement.',
  hypothesis: 'Near-certain outcomes trade at a discount to their true probability shortly before resolution (capital lock-up and impatience), so buying them earns more than the occasional total loss costs.',
  edgeRationale: 'Many small wins, rare total losses. Win rate is nearly meaningless here; only the expectancy over a large sample matters, and one upset can erase dozens of wins.',
  knownRisks: ['Rare total losses dominate the result (negative skew)', 'Resolution disputes', 'Capital lock-up near large events'],
  defaultParams: { minPrice: 0.93, maxPrice: 0.98, maxHoursToEnd: 24, stakePerMarket: 100 },
  paramsSchema: z.object({ minPrice: z.number().gt(0).lt(1), maxPrice: z.number().gt(0).lt(1), maxHoursToEnd: z.number().gt(0), stakePerMarket: z.number().gt(0) }),
  paramSpace: { minPrice: { type: 'float', min: 0.9, max: 0.96, step: 0.03 } },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: false, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: { ...PM_PROFILE, executionSafety: 65 },
};

export class ResolutionStrategy implements PMStrategy<ResolutionParams> {
  onSnapshot(snap: PredictionMarketSnapshot, ctx: PMContext<ResolutionParams>): PMIntent[] {
    const out: PMIntent[] = [];
    const bought = new Set<string>((ctx.state.bought as string[] | undefined) ?? []);
    for (const mk of snap.markets) {
      if (bought.has(mk.marketId)) continue;
      for (const o of mk.outcomes) {
        const end = o.endDate ? Date.parse(o.endDate) : NaN;
        if (!Number.isFinite(end)) continue;
        const hours = (end - ctx.now) / 3_600_000;
        if (hours <= 0 || hours > ctx.params.maxHoursToEnd) continue;
        const ask = o.book.asks[0]?.price;
        if (ask === undefined || ask < ctx.params.minPrice || ask > ctx.params.maxPrice) continue;
        const qty = Math.floor(ctx.params.stakePerMarket / ask);
        if (qty < 1) continue;
        out.push({ tokenId: o.tokenId, side: 'BUY', type: 'MARKET', quantity: qty, limitPrice: ask, reason: `favourite at ${ask.toFixed(2)} with ${hours.toFixed(1)}h to resolution` });
        bought.add(mk.marketId);
        break;
      }
    }
    ctx.state.bought = [...bought];
    return out;
  }
}

export const resolutionModule = createPMModule<ResolutionParams>({ meta: resolutionMeta, create: () => new ResolutionStrategy(), executionDelay: 1, query: 'markets resolving within 24h' });

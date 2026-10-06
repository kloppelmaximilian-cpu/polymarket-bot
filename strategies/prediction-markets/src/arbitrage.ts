import { z } from 'zod';
import type { StrategyMeta } from '@aoc/strategies';
import { takerFeePerShare, type PMContext, type PMIntent, type PMStrategy } from './harness';
import { PM_PROFILE, createPMModule } from './module';
import type { PredictionMarketSnapshot } from '@aoc/strategies';

export interface PMArbParams {
  /** Minimum locked-in profit per $1 payout after fees (e.g. 0.01 = 1 cent). */
  minEdge: number;
  /** Minimum annualised return on the capital locked until resolution. */
  minAnnualizedReturn: number;
  maxSetNotional: number;
  includeMultiOutcome: boolean;
}

export const pmArbMeta: StrategyMeta<PMArbParams> = {
  id: 'pm.arbitrage',
  name: 'Prediction-Market Complete-Set Arbitrage',
  kind: 'PREDICTION_MARKET',
  category: 'PREDICTION_MARKET',
  version: '1.0.0',
  description: 'Buys one share of every outcome of a market when the asks (plus fees) sum to less than $1, locking in the difference at resolution.',
  hypothesis: 'Order books on prediction markets occasionally price a complete set of outcomes below its guaranteed $1 payout by more than fees, for long enough and with enough depth to capture it.',
  edgeRationale: 'A true arbitrage if every leg fills: exactly one outcome pays $1. The risks are execution (legs that do not fill → unhedged exposure), capital locked until resolution, competition from faster bots and resolution disputes.',
  knownRisks: ['Leg risk: partial fills leave a directional position', 'Capital locked until resolution', 'Fast competitors take the depth first', 'Resolution/oracle disputes', 'Multi-outcome markets must be exhaustive for the arbitrage to hold'],
  defaultParams: { minEdge: 0.01, minAnnualizedReturn: 0.1, maxSetNotional: 200, includeMultiOutcome: true },
  paramsSchema: z.object({ minEdge: z.number().min(0).max(0.5), minAnnualizedReturn: z.number().min(0).max(100), maxSetNotional: z.number().gt(0), includeMultiOutcome: z.boolean() }),
  paramSpace: { minEdge: { type: 'float', min: 0.005, max: 0.02, step: 0.005 } },
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: true, walkForward: false, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: { ...PM_PROFILE, competition: 15, executionSafety: 50 },
};

export class PMArbStrategy implements PMStrategy<PMArbParams> {
  onSnapshot(snap: PredictionMarketSnapshot, ctx: PMContext<PMArbParams>): PMIntent[] {
    const p = ctx.params;
    const out: PMIntent[] = [];
    const held = new Set<string>((ctx.state.heldMarkets as string[] | undefined) ?? []);
    for (const mk of snap.markets) {
      if (held.has(mk.marketId) || mk.resolvedOutcome) continue;
      if (mk.outcomes.length > 2 && !p.includeMultiOutcome) continue;
      if (mk.outcomes.length < 2) continue;
      let cost = 0;
      let depth = Number.POSITIVE_INFINITY;
      let ok = true;
      for (const oc of mk.outcomes) {
        const ask = oc.book.asks[0];
        if (!ask) {
          ok = false;
          break;
        }
        cost += ask.price + takerFeePerShare(oc, ask.price);
        depth = Math.min(depth, ask.size);
      }
      if (!ok) continue;
      const edge = 1 - cost;
      if (edge < p.minEdge) continue;
      const end = mk.outcomes[0]?.endDate ? Date.parse(mk.outcomes[0].endDate) : NaN;
      const days = Number.isFinite(end) ? Math.max(1 / 24, (end - ctx.now) / 86_400_000) : 30;
      const annualized = (edge / cost) * (365 / days);
      if (annualized < p.minAnnualizedReturn) {
        ctx.log('ARB_SKIPPED', `${mk.question}: edge ${(edge * 100).toFixed(2)}c but only ${(annualized * 100).toFixed(1)}% annualised`);
        continue;
      }
      const cash = ctx.account.snapshot().availableCash.toNumber();
      const sets = Math.floor(Math.min(depth, p.maxSetNotional / cost, (cash * 0.95) / cost));
      if (sets < 1) continue;
      for (const oc of mk.outcomes) {
        out.push({ tokenId: oc.tokenId, side: 'BUY', type: 'MARKET', quantity: sets, limitPrice: oc.book.asks[0]!.price, reason: `complete set at ${cost.toFixed(4)} < 1 (edge ${(edge * 100).toFixed(2)}c)` });
      }
      held.add(mk.marketId);
      ctx.log('ARB', `${mk.question}: buying ${sets} sets, cost ${cost.toFixed(4)}, edge ${(edge * 100).toFixed(2)}c, ${(annualized * 100).toFixed(1)}% annualised`);
    }
    ctx.state.heldMarkets = [...held];
    return out;
  }
}

export const pmArbModule = createPMModule<PMArbParams>({ meta: pmArbMeta, create: () => new PMArbStrategy(), executionDelay: 1, query: 'active markets with order books (binary and neg-risk events)' });

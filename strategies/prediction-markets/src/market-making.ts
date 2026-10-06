import { z } from 'zod';
import type { PredictionMarketSnapshot, StrategyMeta } from '@aoc/strategies';
import { roundTick, type PMContext, type PMIntent, type PMStrategy } from './harness';
import { PM_PROFILE, createPMModule } from './module';

export interface PMMarketMakingParams {
  halfSpreadTicks: number;
  quoteSize: number;
  maxInventory: number;
  /** Ticks the quotes shift per full maxInventory held (inventory skew). */
  skewTicks: number;
  /** Stop quoting this long before the market's end (adverse selection peaks there). */
  stopBeforeEndMs: number;
  maxMarkets: number;
}

export const pmMarketMakingMeta: StrategyMeta<PMMarketMakingParams> = {
  id: 'pm.market-making',
  name: 'Prediction-Market Market Making',
  kind: 'PREDICTION_MARKET',
  category: 'MARKET_MAKING',
  version: '1.0.0',
  description: 'Rests post-only bids (and asks against held inventory) around the mid of binary markets, skewing quotes against inventory and stopping before resolution.',
  hypothesis: 'Resting liquidity on prediction markets earns the bid-ask spread (and pays no taker fee) at a rate that exceeds losses to informed traders and resolution jumps.',
  edgeRationale: 'Classic inventory-aware market making (Avellaneda & Stoikov 2008). Venues may add liquidity rewards, which are not modelled here. Adverse selection around news and resolution is the main cost.',
  knownRisks: ['Adverse selection by informed traders', 'Inventory held through resolution can go to 0', 'Queue position: fills are modelled conservatively (only when the market trades through the quote)', 'Selling requires holding inventory (no short selling of outcome tokens)'],
  defaultParams: { halfSpreadTicks: 1, quoteSize: 50, maxInventory: 300, skewTicks: 2, stopBeforeEndMs: 6 * 3_600_000, maxMarkets: 5 },
  paramsSchema: z.object({
    halfSpreadTicks: z.number().int().min(1).max(20),
    quoteSize: z.number().gt(0),
    maxInventory: z.number().gt(0),
    skewTicks: z.number().min(0).max(20),
    stopBeforeEndMs: z.number().min(0),
    maxMarkets: z.number().int().min(1).max(100),
  }),
  paramSpace: { halfSpreadTicks: { type: 'int', min: 1, max: 3, step: 1 }, skewTicks: { type: 'int', min: 0, max: 4, step: 2 } },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: false, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: { ...PM_PROFILE, recurringRevenue: 30, executionSafety: 45 },
};

export class PMMarketMakingStrategy implements PMStrategy<PMMarketMakingParams> {
  onSnapshot(snap: PredictionMarketSnapshot, ctx: PMContext<PMMarketMakingParams>): PMIntent[] {
    const p = ctx.params;
    const out: PMIntent[] = [];
    const binaries = snap.markets.filter((m) => m.outcomes.length === 2).slice(0, p.maxMarkets);
    for (const mk of binaries) {
      const yes = mk.outcomes[0]!;
      const tick = yes.book.tickSize ?? 0.01;
      const resting = ctx.openOrders(yes.tokenId);
      const bestBid = yes.book.bids[0]?.price;
      const bestAsk = yes.book.asks[0]?.price;
      if (bestBid === undefined || bestAsk === undefined) continue;
      const end = yes.endDate ? Date.parse(yes.endDate) : NaN;
      if (Number.isFinite(end) && end - ctx.now < p.stopBeforeEndMs) {
        for (const o of resting) ctx.cancel(o.id, 'stop quoting before resolution');
        ctx.log('MM_STOP', `${mk.question}: too close to resolution, not quoting`);
        continue;
      }
      const inv = ctx.holding(yes.tokenId);
      const mid = (bestBid + bestAsk) / 2;
      const reservation = mid - (p.skewTicks * tick * inv) / p.maxInventory;
      let bid = roundTick(reservation - p.halfSpreadTicks * tick, tick, 'down');
      let ask = roundTick(reservation + p.halfSpreadTicks * tick, tick, 'up');
      bid = Math.min(bid, roundTick(bestAsk - tick, tick, 'down')); // stay passive
      ask = Math.max(ask, roundTick(bestBid + tick, tick, 'up'));
      const wantBid = inv < p.maxInventory && bid > 0 && bid < 1 ? { price: bid, qty: Math.min(p.quoteSize, p.maxInventory - inv) } : null;
      const wantAsk = inv > 0 && ask > 0 && ask < 1 ? { price: ask, qty: Math.min(p.quoteSize, inv) } : null;
      // Keep a resting quote that is already where we want it: replacing it would lose queue position.
      const keep = (side: 'BUY' | 'SELL', want: { price: number } | null) => {
        let kept = false;
        for (const o of resting.filter((r) => r.side === side)) {
          if (!kept && want && o.limitPrice !== null && Math.abs(o.limitPrice - want.price) < 1e-9) kept = true;
          else ctx.cancel(o.id, 'requote');
        }
        return kept;
      };
      if (!keep('BUY', wantBid) && wantBid) {
        out.push({ tokenId: yes.tokenId, side: 'BUY', type: 'LIMIT', postOnly: true, limitPrice: wantBid.price, quantity: wantBid.qty, reason: `quote bid ${wantBid.price.toFixed(2)} (mid ${mid.toFixed(3)}, inv ${inv})` });
      }
      if (!keep('SELL', wantAsk) && wantAsk) {
        out.push({ tokenId: yes.tokenId, side: 'SELL', type: 'LIMIT', postOnly: true, limitPrice: wantAsk.price, quantity: wantAsk.qty, reason: `quote ask ${wantAsk.price.toFixed(2)} against inventory ${inv}` });
      }
    }
    return out;
  }
}

export const pmMarketMakingModule = createPMModule<PMMarketMakingParams>({ meta: pmMarketMakingMeta, create: () => new PMMarketMakingStrategy(), executionDelay: 1, query: 'liquid binary markets' });

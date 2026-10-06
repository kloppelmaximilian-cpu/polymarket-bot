import { z } from 'zod';
import { createBarStrategyModule } from '@aoc/backtest';
import { BaseTradingStrategy, sma, zScore, type CommonTradingParams, type Signal, type StrategyContext, type StrategyMeta } from '@aoc/strategies';
import { BINANCE_SPOT_COSTS, COMMON, DIRECTIONAL_CRYPTO_PROFILE, HOUR_MS, commonShape } from './common';

export interface MeanReversionParams extends CommonTradingParams {
  window: number;
  entryZ: number;
  exitZ: number;
  /** Skip longs when the slow trend falls faster than this per bar (fraction). */
  trendWindow: number;
  maxTrendSlope: number;
}

interface MRAnalysis {
  z: number;
  slope: number;
}

export const meanReversionMeta: StrategyMeta<MeanReversionParams> = {
  id: 'trading.mean-reversion',
  name: 'Crypto Mean Reversion (z-score)',
  kind: 'TRADING',
  category: 'CRYPTO_TRADING',
  version: '1.0.0',
  description: 'Buys BTC when the close is stretched below its rolling mean (z-score) and exits as it reverts; skips entries in steep downtrends.',
  hypothesis: 'Short-horizon overreactions in BTC partially revert within hours, so buying statistically stretched dips and selling the reversion earns more than its costs.',
  edgeRationale: 'Liquidity-provision style edge: buyers of temporary dislocations are paid for absorbing order-flow imbalance. It fails in trending sell-offs, which is why a trend filter and a stop loss are part of the design.',
  knownRisks: ['Catching a falling knife in trend regimes', 'Many small wins, rare large losses', 'Edge is small relative to taker fees'],
  defaultParams: { ...COMMON, stopLossPct: 0.04, window: 48, entryZ: 2, exitZ: 0.25, trendWindow: 168, maxTrendSlope: 0.0015 },
  paramsSchema: z.object({
    ...commonShape,
    window: z.number().int().min(5).max(2000),
    entryZ: z.number().gt(0).max(10),
    exitZ: z.number().min(-5).max(5),
    trendWindow: z.number().int().min(5).max(5000),
    maxTrendSlope: z.number().min(0).max(1),
  }),
  paramSpace: {
    window: { type: 'int', min: 24, max: 96, step: 24 },
    entryZ: { type: 'float', min: 1.5, max: 2.5, step: 0.5 },
  },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: true, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: DIRECTIONAL_CRYPTO_PROFILE,
};

export class MeanReversionStrategy extends BaseTradingStrategy<MeanReversionParams, MRAnalysis> {
  readonly meta = meanReversionMeta;

  analyze(ctx: StrategyContext<MeanReversionParams>): MRAnalysis | null {
    const p = ctx.params;
    const closes = ctx.bars().closes(Math.max(p.window, p.trendWindow) + 2);
    const z = zScore(closes, p.window);
    const now = sma(closes, p.trendWindow);
    const before = sma(closes.slice(0, -1), p.trendWindow);
    if (!Number.isFinite(z) || !Number.isFinite(now) || !Number.isFinite(before)) return null;
    return { z, slope: now / before - 1 };
  }

  generateSignal(a: MRAnalysis, ctx: StrategyContext<MeanReversionParams>): Signal {
    const p = ctx.params;
    const holding = ctx.position().quantity;
    if (holding > 0) {
      return a.z < -p.exitZ ? { direction: 'LONG', strength: 1, reason: `waiting for reversion (z=${a.z.toFixed(2)})` } : { direction: 'FLAT', strength: 0, reason: `reverted (z=${a.z.toFixed(2)})` };
    }
    if (a.z <= -p.entryZ) {
      if (a.slope < -p.maxTrendSlope) return { direction: 'FLAT', strength: 0, reason: `dip in a steep downtrend (slope ${(a.slope * 100).toFixed(3)}%/bar) — skipped` };
      return { direction: 'LONG', strength: 1, reason: `stretched below mean (z=${a.z.toFixed(2)})` };
    }
    return { direction: 'FLAT', strength: 0, reason: `no dislocation (z=${a.z.toFixed(2)})` };
  }
}

export const meanReversionModule = createBarStrategyModule<MeanReversionParams>({
  meta: meanReversionMeta,
  create: () => new MeanReversionStrategy(),
  symbols: () => ['BTCUSDT'],
  venue: 'binance',
  interval: '1h',
  intervalMs: HOUR_MS,
  instrumentKind: 'SPOT',
  costs: BINANCE_SPOT_COSTS,
  warmupBars: (p) => Math.max(p.window, p.trendWindow) + 2,
});

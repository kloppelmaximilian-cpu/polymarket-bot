import { z } from 'zod';
import { createBarStrategyModule } from '@aoc/backtest';
import { BaseTradingStrategy, percentileRank, rollingStd, sma, type CommonTradingParams, type Signal, type StrategyContext, type StrategyMeta } from '@aoc/strategies';
import { BINANCE_SPOT_COSTS, COMMON, DIRECTIONAL_CRYPTO_PROFILE, HOUR_MS, commonShape } from './common';

export interface VolatilityParams extends CommonTradingParams {
  bandWindow: number;
  bandWidthStd: number;
  squeezeLookback: number;
  /** Bandwidth percentile below which the market counts as compressed. */
  squeezePercentile: number;
}

interface VolAnalysis {
  close: number;
  mid: number;
  upper: number;
  squeezed: boolean;
  rank: number;
}

export const volatilityMeta: StrategyMeta<VolatilityParams> = {
  id: 'trading.volatility-breakout',
  name: 'Volatility Compression Breakout',
  kind: 'TRADING',
  category: 'CRYPTO_TRADING',
  version: '1.0.0',
  description: 'Waits for Bollinger bandwidth to compress to a low percentile, then enters on a close above the upper band; exits below the middle band.',
  hypothesis: 'Periods of unusually low realised volatility in BTC tend to end in directional expansions, and the first close outside the band after compression predicts the direction better than chance.',
  edgeRationale: 'Volatility clustering is well established; whether the breakout direction is predictable is the weak part of the hypothesis and the thing this experiment tests.',
  knownRisks: ['Direction of the expansion may be a coin flip', 'Few signals → small samples', 'Fake-outs right after entries'],
  defaultParams: { ...COMMON, stopLossPct: 0.03, bandWindow: 24, bandWidthStd: 2, squeezeLookback: 240, squeezePercentile: 0.2 },
  paramsSchema: z.object({
    ...commonShape,
    bandWindow: z.number().int().min(5).max(1000),
    bandWidthStd: z.number().gt(0).max(5),
    squeezeLookback: z.number().int().min(20).max(5000),
    squeezePercentile: z.number().gt(0).lt(1),
  }),
  paramSpace: {
    bandWindow: { type: 'int', min: 12, max: 36, step: 12 },
    squeezePercentile: { type: 'float', min: 0.1, max: 0.3, step: 0.1 },
  },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: true, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: DIRECTIONAL_CRYPTO_PROFILE,
};

export class VolatilityBreakoutStrategy extends BaseTradingStrategy<VolatilityParams, VolAnalysis> {
  readonly meta = volatilityMeta;

  analyze(ctx: StrategyContext<VolatilityParams>): VolAnalysis | null {
    const p = ctx.params;
    const closes = ctx.bars().closes(p.squeezeLookback + p.bandWindow + 1);
    if (closes.length < p.squeezeLookback + p.bandWindow) return null;
    const widths: number[] = [];
    for (let i = p.bandWindow; i <= closes.length; i++) {
      const w = closes.slice(i - p.bandWindow, i);
      const m = sma(w, p.bandWindow);
      widths.push((2 * p.bandWidthStd * rollingStd(w, p.bandWindow)) / m);
    }
    const rank = percentileRank(widths.slice(0, -1), Math.min(p.squeezeLookback, widths.length - 1));
    const mid = sma(closes, p.bandWindow);
    const sd = rollingStd(closes, p.bandWindow);
    const close = closes[closes.length - 1] as number;
    if (!Number.isFinite(rank) || !Number.isFinite(mid) || !Number.isFinite(sd)) return null;
    return { close, mid, upper: mid + p.bandWidthStd * sd, squeezed: rank <= p.squeezePercentile, rank };
  }

  generateSignal(a: VolAnalysis, ctx: StrategyContext<VolatilityParams>): Signal {
    const holding = ctx.position().quantity;
    if (holding > 0) {
      return a.close < a.mid ? { direction: 'FLAT', strength: 0, reason: 'closed below the middle band' } : { direction: 'LONG', strength: 1, reason: 'expansion continues' };
    }
    if (a.squeezed && a.close > a.upper) return { direction: 'LONG', strength: 1, reason: `breakout after compression (bandwidth rank ${(a.rank * 100).toFixed(0)}%)` };
    return { direction: 'FLAT', strength: 0, reason: a.squeezed ? 'compressed, waiting for a breakout' : 'no compression' };
  }
}

export const volatilityModule = createBarStrategyModule<VolatilityParams>({
  meta: volatilityMeta,
  create: () => new VolatilityBreakoutStrategy(),
  symbols: () => ['BTCUSDT'],
  venue: 'binance',
  interval: '1h',
  intervalMs: HOUR_MS,
  instrumentKind: 'SPOT',
  costs: BINANCE_SPOT_COSTS,
  warmupBars: (p) => p.squeezeLookback + p.bandWindow + 1,
});

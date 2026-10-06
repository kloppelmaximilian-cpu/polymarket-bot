import { z } from 'zod';
import { createBarStrategyModule } from '@aoc/backtest';
import { BaseTradingStrategy, ema, realizedVol, type CommonTradingParams, type Signal, type StrategyContext, type StrategyMeta, type TargetPositions } from '@aoc/strategies';
import { BINANCE_SPOT_COSTS, COMMON, DIRECTIONAL_CRYPTO_PROFILE, HOUR_MS, commonShape } from './common';

export interface TrendParams extends CommonTradingParams {
  fast: number;
  slow: number;
  volWindow: number;
  /** Target annualised volatility of the position; 0 disables vol targeting. */
  targetAnnualVol: number;
}

interface TrendAnalysis {
  fast: number;
  slow: number;
  vol: number;
}

export const trendMeta: StrategyMeta<TrendParams> = {
  id: 'trading.trend-following',
  name: 'EMA Trend Following (vol-targeted)',
  kind: 'TRADING',
  category: 'CRYPTO_TRADING',
  version: '1.0.0',
  description: 'Long while the fast EMA is above the slow EMA; position size scaled to a target volatility.',
  hypothesis: 'Persistent trends in BTC can be captured with a slow moving-average filter, and volatility targeting improves risk-adjusted returns by cutting exposure in turbulent periods.',
  edgeRationale: 'Combines trend persistence with volatility scaling (Moreira & Muir 2017 for vol-managed portfolios). Slow signals trade rarely, which keeps costs low.',
  knownRisks: ['Late entries and exits', 'Long drawdowns in sideways markets', 'Vol targeting levers up into calm periods before crashes'],
  defaultParams: { ...COMMON, fast: 24, slow: 120, volWindow: 72, targetAnnualVol: 0.5 },
  paramsSchema: z.object({
    ...commonShape,
    fast: z.number().int().min(2).max(1000),
    slow: z.number().int().min(3).max(5000),
    volWindow: z.number().int().min(5).max(2000),
    targetAnnualVol: z.number().min(0).max(5),
  }),
  paramSpace: {
    fast: { type: 'int', min: 12, max: 36, step: 12 },
    slow: { type: 'int', min: 96, max: 168, step: 36 },
  },
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: true, walkForward: true, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: { ...DIRECTIONAL_CRYPTO_PROFILE, operationalSimplicity: 85 },
};

const HOURS_PER_YEAR = 24 * 365.25;

export class TrendFollowingStrategy extends BaseTradingStrategy<TrendParams, TrendAnalysis> {
  readonly meta = trendMeta;

  analyze(ctx: StrategyContext<TrendParams>): TrendAnalysis | null {
    const p = ctx.params;
    if (p.fast >= p.slow) return null;
    const closes = ctx.bars().closes(p.slow * 3);
    const fast = ema(closes, p.fast);
    const slow = ema(closes, p.slow);
    const vol = realizedVol(closes, p.volWindow);
    if (!Number.isFinite(fast) || !Number.isFinite(slow) || !Number.isFinite(vol)) return null;
    return { fast, slow, vol };
  }

  generateSignal(a: TrendAnalysis): Signal {
    if (a.fast > a.slow) return { direction: 'LONG', strength: 1, reason: `uptrend (fast ${a.fast.toFixed(2)} > slow ${a.slow.toFixed(2)})` };
    return { direction: 'FLAT', strength: 0, reason: 'no uptrend' };
  }

  override calculatePositionSize(signal: Signal, a: TrendAnalysis, ctx: StrategyContext<TrendParams>): TargetPositions {
    const base = super.calculatePositionSize(signal, a, ctx);
    const target = ctx.params.targetAnnualVol;
    if (target <= 0 || signal.direction === 'FLAT') return base;
    const annual = a.vol * Math.sqrt(HOURS_PER_YEAR);
    const scale = annual > 0 ? Math.min(1, target / annual) : 1;
    return { [ctx.primary]: (base[ctx.primary] ?? 0) * scale };
  }
}

export const trendModule = createBarStrategyModule<TrendParams>({
  meta: trendMeta,
  create: () => new TrendFollowingStrategy(),
  symbols: () => ['BTCUSDT'],
  venue: 'binance',
  interval: '1h',
  intervalMs: HOUR_MS,
  instrumentKind: 'SPOT',
  costs: BINANCE_SPOT_COSTS,
  warmupBars: (p) => p.slow * 3,
});

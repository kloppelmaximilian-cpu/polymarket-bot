import { z } from 'zod';
import { createBarStrategyModule } from '@aoc/backtest';
import { BaseTradingStrategy, rateOfChange, type CommonTradingParams, type Signal, type StrategyContext, type StrategyMeta } from '@aoc/strategies';
import { BINANCE_SPOT_COSTS, COMMON, DIRECTIONAL_CRYPTO_PROFILE, HOUR_MS, commonShape } from './common';

export interface MomentumParams extends CommonTradingParams {
  lookbackBars: number;
  entryThreshold: number;
  exitThreshold: number;
}

interface MomentumAnalysis {
  roc: number;
}

export const momentumMeta: StrategyMeta<MomentumParams> = {
  id: 'trading.momentum',
  name: 'Crypto Time-Series Momentum',
  kind: 'TRADING',
  category: 'CRYPTO_TRADING',
  version: '1.0.0',
  description: 'Holds BTC while its trailing return over the lookback exceeds a threshold, flat otherwise (long-only by default).',
  hypothesis: 'Hourly BTC returns over the past ~2 days carry a small positive autocorrelation, so being long after strong past returns earns more than buy-and-hold per unit of exposure after costs.',
  edgeRationale: 'Time-series momentum has been documented across asset classes (Moskowitz, Ooi & Pedersen 2012). In crypto it is widely traded, so any edge is likely thin and regime-dependent; costs from frequent re-entries can erase it.',
  knownRisks: ['Whipsaw losses in ranging markets', 'Crowded signal; edge may have decayed', 'Sharp reversals gap through exits', 'Results are sensitive to the lookback'],
  defaultParams: { ...COMMON, lookbackBars: 48, entryThreshold: 0.015, exitThreshold: 0 },
  paramsSchema: z.object({ ...commonShape, lookbackBars: z.number().int().min(2).max(2000), entryThreshold: z.number().min(0).max(1), exitThreshold: z.number().min(-1).max(1) }),
  paramSpace: {
    lookbackBars: { type: 'int', min: 24, max: 96, step: 24 },
    entryThreshold: { type: 'float', min: 0.01, max: 0.03, step: 0.01 },
  },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: true, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: DIRECTIONAL_CRYPTO_PROFILE,
};

export class MomentumStrategy extends BaseTradingStrategy<MomentumParams, MomentumAnalysis> {
  readonly meta = momentumMeta;

  analyze(ctx: StrategyContext<MomentumParams>): MomentumAnalysis | null {
    const closes = ctx.bars().closes(ctx.params.lookbackBars + 1);
    const roc = rateOfChange(closes, ctx.params.lookbackBars);
    return Number.isFinite(roc) ? { roc } : null;
  }

  generateSignal(a: MomentumAnalysis, ctx: StrategyContext<MomentumParams>): Signal {
    const p = ctx.params;
    const holding = ctx.position().quantity;
    const pct = (a.roc * 100).toFixed(2);
    if (holding > 0 && a.roc > p.exitThreshold) return { direction: 'LONG', strength: 1, reason: `momentum holds (${pct}% over ${p.lookbackBars} bars)` };
    if (holding < 0 && a.roc < -p.exitThreshold) return { direction: 'SHORT', strength: 1, reason: `negative momentum holds (${pct}%)` };
    if (a.roc >= p.entryThreshold) return { direction: 'LONG', strength: 1, reason: `momentum entry: ${pct}% ≥ ${(p.entryThreshold * 100).toFixed(2)}%` };
    if (a.roc <= -p.entryThreshold && p.allowShort) return { direction: 'SHORT', strength: 1, reason: `negative momentum entry: ${pct}%` };
    return { direction: 'FLAT', strength: 0, reason: `no momentum (${pct}%)` };
  }
}

export const momentumModule = createBarStrategyModule<MomentumParams>({
  meta: momentumMeta,
  create: () => new MomentumStrategy(),
  symbols: () => ['BTCUSDT'],
  venue: 'binance',
  interval: '1h',
  intervalMs: HOUR_MS,
  instrumentKind: 'SPOT',
  costs: BINANCE_SPOT_COSTS,
  warmupBars: (p) => p.lookbackBars + 1,
});

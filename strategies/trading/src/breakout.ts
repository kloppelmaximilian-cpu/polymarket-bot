import { z } from 'zod';
import { createBarStrategyModule } from '@aoc/backtest';
import { BaseTradingStrategy, atr, donchian, type CommonTradingParams, type OrderIntent, type Signal, type StrategyContext, type StrategyMeta } from '@aoc/strategies';
import { BINANCE_SPOT_COSTS, COMMON, DIRECTIONAL_CRYPTO_PROFILE, HOUR_MS, commonShape } from './common';

export interface BreakoutParams extends CommonTradingParams {
  entryChannel: number;
  exitChannel: number;
  atrWindow: number;
  atrStopMultiple: number;
}

interface BreakoutAnalysis {
  close: number;
  upper: number;
  exitLower: number;
  atr: number;
}

export const breakoutMeta: StrategyMeta<BreakoutParams> = {
  id: 'trading.breakout',
  name: 'Donchian Channel Breakout',
  kind: 'TRADING',
  category: 'CRYPTO_TRADING',
  version: '1.0.0',
  description: 'Enters when the close breaks the highest high of the entry channel; exits on a break of the shorter exit channel or an ATR trailing stop.',
  hypothesis: 'Range breakouts in BTC are followed by continuation often enough that the payoff asymmetry (small stops, large trends) beats the false breakouts after costs.',
  edgeRationale: 'Classic trend-following entry (the "Turtle" rules). Edge depends on fat-tailed trends; most trades lose small amounts.',
  knownRisks: ['Low win rate is psychologically and statistically hard to validate', 'False breakouts in chop', 'Long flat periods'],
  defaultParams: { ...COMMON, entryChannel: 55, exitChannel: 20, atrWindow: 24, atrStopMultiple: 3 },
  paramsSchema: z.object({
    ...commonShape,
    entryChannel: z.number().int().min(5).max(2000),
    exitChannel: z.number().int().min(2).max(2000),
    atrWindow: z.number().int().min(2).max(500),
    atrStopMultiple: z.number().gt(0).max(20),
  }),
  paramSpace: {
    entryChannel: { type: 'int', min: 35, max: 75, step: 20 },
    exitChannel: { type: 'int', min: 10, max: 30, step: 10 },
  },
  defaultRiskLevel: 'HIGH',
  capabilities: { backtest: true, walkForward: true, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: DIRECTIONAL_CRYPTO_PROFILE,
};

export class BreakoutStrategy extends BaseTradingStrategy<BreakoutParams, BreakoutAnalysis> {
  readonly meta = breakoutMeta;

  analyze(ctx: StrategyContext<BreakoutParams>): BreakoutAnalysis | null {
    const p = ctx.params;
    const w = ctx.bars().window(Math.max(p.entryChannel, p.exitChannel, p.atrWindow) + 2);
    const entry = donchian(w, p.entryChannel);
    const exit = donchian(w, p.exitChannel);
    const a = atr(w, p.atrWindow);
    const last = w[w.length - 1];
    if (!last || !Number.isFinite(entry.upper) || !Number.isFinite(exit.lower) || !Number.isFinite(a)) return null;
    return { close: last.close, upper: entry.upper, exitLower: exit.lower, atr: a };
  }

  generateSignal(a: BreakoutAnalysis, ctx: StrategyContext<BreakoutParams>): Signal {
    const holding = ctx.position().quantity;
    if (holding > 0) {
      if (a.close < a.exitLower) return { direction: 'FLAT', strength: 0, reason: `exit channel broken (${a.close.toFixed(2)} < ${a.exitLower.toFixed(2)})` };
      return { direction: 'LONG', strength: 1, reason: 'trend intact' };
    }
    if (a.close > a.upper) return { direction: 'LONG', strength: 1, reason: `breakout above ${a.upper.toFixed(2)}` };
    return { direction: 'FLAT', strength: 0, reason: 'inside channel' };
  }

  /** ATR trailing stop on top of the fixed stop. */
  override managePosition(a: BreakoutAnalysis, ctx: StrategyContext<BreakoutParams>): OrderIntent[] {
    const base = super.managePosition(a, ctx);
    if (base.length > 0) return base;
    const pos = ctx.position();
    if (pos.quantity <= 0) {
      delete ctx.state.trailHigh;
      return [];
    }
    const high = Math.max((ctx.state.trailHigh as number | undefined) ?? a.close, a.close);
    ctx.state.trailHigh = high;
    const stop = high - ctx.params.atrStopMultiple * a.atr;
    if (a.close < stop) {
      delete ctx.state.trailHigh;
      return [{ symbol: ctx.primary, side: 'SELL', quantity: pos.quantity, type: 'MARKET', reason: `ATR trailing stop (${stop.toFixed(2)})`, reduceOnly: true }];
    }
    return [];
  }
}

export const breakoutModule = createBarStrategyModule<BreakoutParams>({
  meta: breakoutMeta,
  create: () => new BreakoutStrategy(),
  symbols: () => ['BTCUSDT'],
  venue: 'binance',
  interval: '1h',
  intervalMs: HOUR_MS,
  instrumentKind: 'SPOT',
  costs: BINANCE_SPOT_COSTS,
  warmupBars: (p) => Math.max(p.entryChannel, p.exitChannel, p.atrWindow) + 2,
});

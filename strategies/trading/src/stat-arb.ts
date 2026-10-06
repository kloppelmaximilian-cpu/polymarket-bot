import { z } from 'zod';
import { createBarStrategyModule } from '@aoc/backtest';
import { mean, ols, stdev } from '@aoc/core';
import { BaseTradingStrategy, type CommonTradingParams, type Signal, type StrategyContext, type StrategyMeta, type TargetPositions } from '@aoc/strategies';
import { BINANCE_PERP_COSTS, COMMON, HOUR_MS, commonShape } from './common';

export interface PairsParams extends CommonTradingParams {
  lookback: number;
  entryZ: number;
  exitZ: number;
  maxHoldBars: number;
}

interface PairsAnalysis {
  beta: number;
  z: number;
  priceX: number;
  priceY: number;
}

const X = 'BTCUSDT';
const Y = 'ETHUSDT';

export const pairsMeta: StrategyMeta<PairsParams> = {
  id: 'trading.stat-arb-pairs',
  name: 'Statistical Arbitrage: BTC/ETH Pairs',
  kind: 'TRADING',
  category: 'CRYPTO_TRADING',
  version: '1.0.0',
  description: 'Trades the log-price spread ETH − β·BTC (β from rolling OLS) when its z-score is stretched; beta-hedged, using perpetual futures for both legs.',
  hypothesis: 'The BTC/ETH log-price spread is mean-reverting over days, so a beta-hedged position against extreme z-scores earns the reversion with little market exposure.',
  edgeRationale: 'Pairs trading (Gatev, Goetzmann & Rouwenhorst 2006) relies on a stable relationship. Crypto pairs are highly correlated but cointegration is fragile; structural breaks are the main risk.',
  knownRisks: ['Relationship breaks (one asset re-rates)', 'Funding costs on perpetual legs', 'Hedge ratio estimation error', 'Two legs double the costs'],
  defaultParams: { ...COMMON, allowShort: true, positionFraction: 0.45, lookback: 168, entryZ: 2, exitZ: 0.5, maxHoldBars: 240 },
  paramsSchema: z.object({
    ...commonShape,
    lookback: z.number().int().min(20).max(5000),
    entryZ: z.number().gt(0).max(10),
    exitZ: z.number().min(0).max(5),
    maxHoldBars: z.number().int().min(1).max(10_000),
  }),
  paramSpace: {
    lookback: { type: 'int', min: 120, max: 216, step: 48 },
    entryZ: { type: 'float', min: 1.5, max: 2.5, step: 0.5 },
  },
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: true, walkForward: true, paper: true, monteCarlo: true, requiresRealData: true },
  qualitative: {
    automation: 85,
    scalability: 55,
    operationalSimplicity: 60,
    recurringRevenue: 15,
    competition: 30,
    dependencySafety: 50,
    dataAvailability: 90,
    executionSafety: 60,
    timeToRevenueDays: 45,
  },
};

export class PairsStrategy extends BaseTradingStrategy<PairsParams, PairsAnalysis> {
  readonly meta = pairsMeta;

  analyze(ctx: StrategyContext<PairsParams>): PairsAnalysis | null {
    const n = ctx.params.lookback;
    const lx = ctx.bars(X).closes(n).map(Math.log);
    const ly = ctx.bars(Y).closes(n).map(Math.log);
    if (lx.length < n || ly.length < n) return null;
    const { alpha, beta } = ols(lx, ly);
    if (!Number.isFinite(beta)) return null;
    const spread = ly.map((y, i) => y - alpha - beta * (lx[i] as number));
    const sd = stdev(spread);
    if (!(sd > 0)) return null;
    const z = ((spread[spread.length - 1] as number) - mean(spread)) / sd;
    return { beta, z, priceX: Math.exp(lx[lx.length - 1] as number), priceY: Math.exp(ly[ly.length - 1] as number) };
  }

  generateSignal(a: PairsAnalysis, ctx: StrategyContext<PairsParams>): Signal {
    const p = ctx.params;
    const yPos = ctx.position(Y).quantity;
    const openedAt = ctx.state.openedAt as number | undefined;
    if (yPos !== 0) {
      const held = openedAt !== undefined ? (ctx.now - openedAt) / HOUR_MS : 0;
      if (Math.abs(a.z) <= p.exitZ) return { direction: 'FLAT', strength: 0, reason: `spread reverted (z=${a.z.toFixed(2)})` };
      if (held >= p.maxHoldBars) return { direction: 'FLAT', strength: 0, reason: `max holding time reached (${held.toFixed(0)}h)` };
      return { direction: yPos > 0 ? 'LONG' : 'SHORT', strength: 1, reason: `holding spread (z=${a.z.toFixed(2)})` };
    }
    // Spread high → ETH rich vs BTC → short ETH (SHORT), long BTC.
    if (a.z >= p.entryZ) return { direction: 'SHORT', strength: 1, reason: `spread rich (z=${a.z.toFixed(2)})` };
    if (a.z <= -p.entryZ) return { direction: 'LONG', strength: 1, reason: `spread cheap (z=${a.z.toFixed(2)})` };
    return { direction: 'FLAT', strength: 0, reason: `spread normal (z=${a.z.toFixed(2)})` };
  }

  /** Beta-hedged: `direction` refers to the ETH leg; BTC is the hedge. */
  override calculatePositionSize(signal: Signal, a: PairsAnalysis, ctx: StrategyContext<PairsParams>): TargetPositions {
    if (signal.direction === 'FLAT') {
      delete ctx.state.openedAt;
      return { [Y]: 0, [X]: 0 };
    }
    const legNotional = Math.max(0, ctx.equity()) * ctx.params.positionFraction;
    const sign = signal.direction === 'LONG' ? 1 : -1;
    if (ctx.position(Y).quantity === 0) ctx.state.openedAt = ctx.now;
    // Hedge in return space: the BTC leg's notional is β times the ETH leg's.
    const hedge = Math.min(2, Math.max(0.2, a.beta));
    return { [Y]: (sign * legNotional) / a.priceY, [X]: (-sign * legNotional * hedge) / a.priceX };
  }
}

export const pairsModule = createBarStrategyModule<PairsParams>({
  meta: pairsMeta,
  create: () => new PairsStrategy(),
  symbols: () => [Y, X],
  venue: 'binance-futures',
  interval: '1h',
  intervalMs: HOUR_MS,
  instrumentKind: 'PERP',
  costs: BINANCE_PERP_COSTS,
  warmupBars: (p) => p.lookback + 1,
});

import { z } from 'zod';
import { COMMON_DEFAULTS, VENUE_COSTS, type QualitativeProfile } from '@aoc/strategies';
import type { BarBacktestCosts } from '@aoc/backtest';

export const commonShape = {
  positionFraction: z.number().gt(0).lte(1),
  allowShort: z.boolean(),
  stopLossPct: z.number().min(0).max(0.5),
  takeProfitPct: z.number().min(0).max(2),
  rebalanceThreshold: z.number().min(0).max(1),
  minTradeNotional: z.number().min(0),
};

export const COMMON = COMMON_DEFAULTS;

/** Binance spot, base tier, plus explicit spread/slippage/impact assumptions. */
export const BINANCE_SPOT_COSTS: BarBacktestCosts = {
  feeModel: VENUE_COSTS.binance!.feeModel,
  spreadBps: 2,
  slippageBps: 2,
  impactBpsPer10k: 1,
};

export const BINANCE_PERP_COSTS: BarBacktestCosts = {
  feeModel: VENUE_COSTS['binance-futures']!.feeModel,
  spreadBps: 2,
  slippageBps: 2,
  impactBpsPer10k: 1,
};

export const HOUR_MS = 3_600_000;

/** Directional crypto strategies share most of their operating profile. */
export const DIRECTIONAL_CRYPTO_PROFILE: QualitativeProfile = {
  automation: 90,
  scalability: 60,
  operationalSimplicity: 75,
  recurringRevenue: 15,
  competition: 25,
  dependencySafety: 55,
  dataAvailability: 95,
  executionSafety: 70,
  timeToRevenueDays: 30,
};

import type { DataRequirement, StrategyMeta, StrategyModule } from '@aoc/strategies';
import { pmPaperStep, requirePM, runPMBacktest, type PMStrategy } from './harness';
import { DEFAULT_PM_SYNTHETIC, syntheticPredictionMarkets } from './synthetic';

export interface PMModuleDef<P> {
  meta: StrategyMeta<P>;
  create: () => PMStrategy<P>;
  /** Snapshots between decision and execution in backtests. */
  executionDelay: number;
  query: string;
  syntheticOverrides?: Partial<typeof DEFAULT_PM_SYNTHETIC>;
}

export function createPMModule<P>(def: PMModuleDef<P>): StrategyModule<P> {
  return {
    meta: def.meta,
    dataRequirements(): DataRequirement[] {
      return [{ kind: 'PM_MARKETS', query: def.query, maxMarkets: 50 }];
    },
    syntheticData(_params, seed) {
      return syntheticPredictionMarkets({ ...DEFAULT_PM_SYNTHETIC, ...def.syntheticOverrides, seed });
    },
    backtest(input) {
      return runPMBacktest({
        strategy: def.create(),
        params: input.params,
        series: requirePM(input.data),
        initialCapital: input.initialCapital,
        provenance: input.data.provenance === 'HISTORICAL' ? 'HISTORICAL' : 'DEMO',
        label: input.data.label,
        costMultiplier: input.costMultiplier,
        executionDelay: def.executionDelay,
        window: input.window,
      });
    },
    paperStep(input) {
      return pmPaperStep(def.create(), input);
    },
  };
}

export const PM_PROFILE = {
  automation: 85,
  scalability: 35,
  operationalSimplicity: 60,
  recurringRevenue: 10,
  competition: 30,
  dependencySafety: 40,
  dataAvailability: 75,
  executionSafety: 55,
  timeToRevenueDays: 30,
};

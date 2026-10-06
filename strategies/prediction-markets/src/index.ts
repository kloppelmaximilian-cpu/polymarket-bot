import type { AnyStrategyModule } from '@aoc/strategies';
import { pmArbModule } from './arbitrage';
import { pmMarketMakingModule } from './market-making';
import { imbalanceModule, mispricingModule, resolutionModule, valueModule } from './signals';

export * from './harness';
export * from './synthetic';
export * from './module';
export * from './arbitrage';
export * from './market-making';
export * from './signals';

export const predictionMarketModules: AnyStrategyModule[] = [pmArbModule, pmMarketMakingModule, mispricingModule, valueModule, imbalanceModule, resolutionModule];

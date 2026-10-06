import type { AnyStrategyModule } from '@aoc/strategies';
import { crossExchangeModule } from './cross-exchange';
import { fundingModule } from './funding';

export * from './cross-exchange';
export * from './funding';

export const arbitrageModules: AnyStrategyModule[] = [crossExchangeModule, fundingModule];

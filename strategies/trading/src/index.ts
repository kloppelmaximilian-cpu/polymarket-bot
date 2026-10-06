import type { AnyStrategyModule } from '@aoc/strategies';
import { breakoutModule } from './breakout';
import { meanReversionModule } from './mean-reversion';
import { momentumModule } from './momentum';
import { pairsModule } from './stat-arb';
import { trendModule } from './trend-following';
import { volatilityModule } from './volatility';

export * from './momentum';
export * from './mean-reversion';
export * from './breakout';
export * from './trend-following';
export * from './volatility';
export * from './stat-arb';
export * from './common';

export const tradingModules: AnyStrategyModule[] = [momentumModule, meanReversionModule, breakoutModule, trendModule, volatilityModule, pairsModule];

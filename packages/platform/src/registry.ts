import { StrategyRegistry } from '@aoc/strategies';
import { arbitrageModules } from '@aoc/strategies-arbitrage';
import { businessModules } from '@aoc/strategies-business';
import { leadGenerationModules } from '@aoc/strategies-lead-generation';
import { predictionMarketModules } from '@aoc/strategies-prediction-markets';
import { saasModules } from '@aoc/strategies-saas';
import { tradingModules } from '@aoc/strategies-trading';

/** Every strategy and business module in this build. */
export function buildRegistry(): StrategyRegistry {
  const r = new StrategyRegistry();
  for (const m of [...tradingModules, ...predictionMarketModules, ...arbitrageModules, ...businessModules, ...saasModules, ...leadGenerationModules]) r.register(m);
  return r;
}

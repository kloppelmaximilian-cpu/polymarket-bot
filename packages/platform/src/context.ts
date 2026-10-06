import { systemClock, type AppConfig, type Clock, type Logger } from '@aoc/core';
import { MarketDataService, type BinanceStreams } from '@aoc/connectors';
import type { Database } from '@aoc/database';
import type { StrategyRegistry } from '@aoc/strategies';
import { buildRegistry } from './registry';

export interface PlatformContext {
  db: Database;
  config: AppConfig;
  logger: Logger;
  registry: StrategyRegistry;
  marketData: MarketDataService;
  clock: Clock;
  /** Overridable for tests (webhook delivery). */
  fetch: typeof fetch;
}

export interface CreateContextOptions {
  db: Database;
  config: AppConfig;
  logger: Logger;
  clock?: Clock;
  fetch?: typeof fetch;
  streams?: BinanceStreams | null;
  registry?: StrategyRegistry;
}

export function createContext(o: CreateContextOptions): PlatformContext {
  const fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    db: o.db,
    config: o.config,
    logger: o.logger,
    registry: o.registry ?? buildRegistry(),
    clock: o.clock ?? systemClock,
    fetch: fetchImpl,
    marketData: new MarketDataService({
      fetch: fetchImpl,
      timeoutMs: o.config.HTTP_TIMEOUT_MS,
      staleAfterMs: o.config.DATA_STALE_AFTER_MS,
      enabled: o.config.MARKET_DATA_ENABLED,
      streams: o.streams ?? null,
    }),
  };
}

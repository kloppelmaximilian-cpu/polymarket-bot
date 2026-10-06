import { DataUnavailableError, d, type Bar } from '@aoc/core';
import type { Instrument, MarketSnapshot } from '@aoc/paper-engine';
import {
  BarSeries,
  PaperAccountBroker,
  runTradingStep,
  type CommonTradingParams,
  type DataBundle,
  type DecisionLog,
  type StrategyContext,
  type StrategyMeta,
  type StrategyModule,
  type TradingStrategy,
} from '@aoc/strategies';
import { runBarBacktest, type BarBacktestCosts } from './engine';
import { syntheticBars } from './synthetic';

export interface BarStrategyModuleDef<P extends CommonTradingParams> {
  meta: StrategyMeta<P>;
  create: () => TradingStrategy<P, unknown>;
  symbols: (params: P) => string[];
  venue: string;
  interval: string;
  intervalMs: number;
  instrumentKind: 'SPOT' | 'PERP';
  costs: BarBacktestCosts;
  warmupBars: (params: P) => number;
  /** DEMO data generator; defaults to a driftless random walk per symbol. */
  synthetic?: (params: P, seed: string) => Record<string, Bar[]>;
}

/** Wrap a bar-based TradingStrategy into a pipeline module (backtest + paper). */
export function createBarStrategyModule<P extends CommonTradingParams>(def: BarStrategyModuleDef<P>): StrategyModule<P> {
  return {
    meta: def.meta,

    dataRequirements(params) {
      return def.symbols(params).map((symbol) => ({ kind: 'BARS' as const, venue: def.venue, symbol, interval: def.interval, minBars: def.warmupBars(params) + 200 }));
    },

    syntheticData(params, seed): DataBundle {
      const gen =
        def.synthetic ??
        ((p: P, s: string) => {
          const out: Record<string, Bar[]> = {};
          def.symbols(p).forEach((sym, i) => {
            out[sym] = syntheticBars({ seed: `${s}/${sym}`, bars: 3000, intervalMs: def.intervalMs, startTs: Date.UTC(2025, 0, 1), startPrice: i === 0 ? 60_000 : 3_000, vol: 0.006, avgVolume: 500 });
          });
          return out;
        });
      return { provenance: 'DEMO', label: `DEMO synthetic ${def.interval} bars (driftless random walk, seed ${seed})`, bars: gen(params, seed) };
    },

    backtest(input) {
      const bars = input.data.bars;
      if (!bars) throw new DataUnavailableError('bar data required');
      const ordered: Record<string, Bar[]> = {};
      for (const s of def.symbols(input.params)) {
        const b = bars[s];
        if (!b || b.length === 0) throw new DataUnavailableError(`no bars for ${s}`);
        ordered[s] = b;
      }
      return runBarBacktest({
        strategy: def.create(),
        params: input.params,
        bars: ordered,
        venue: def.venue,
        instrumentKind: def.instrumentKind,
        costs: def.costs,
        initialCapital: input.initialCapital,
        provenance: input.data.provenance === 'HISTORICAL' ? 'HISTORICAL' : 'DEMO',
        datasetLabel: input.data.label,
        seed: input.seed,
        costMultiplier: input.costMultiplier,
        window: input.window,
        warmupBars: def.warmupBars(input.params),
      });
    },

    paperStep(input) {
      const decisions: DecisionLog[] = [];
      const state = { ...input.state };
      const symbols = def.symbols(input.params);
      const bars = input.live.bars ?? {};
      const books = input.live.books ?? {};
      const instruments: Record<string, Instrument> = {};
      const markets: Record<string, MarketSnapshot> = {};
      for (const s of symbols) {
        instruments[s] = { venue: def.venue, symbol: s, kind: def.instrumentKind, feeModel: def.costs.feeModel };
        const book = books[s];
        if (book && (book.bids.length > 0 || book.asks.length > 0)) {
          markets[s] = { ts: input.now, bids: book.bids, asks: book.asks };
        }
      }
      // Mark existing positions to live mids first.
      const changes = [];
      for (const s of symbols) {
        const m = markets[s];
        if (m) changes.push(input.account.onMarket(def.venue, s, m));
      }
      const primary = symbols[0] as string;
      const primaryBars = bars[primary];
      if (!primaryBars || primaryBars.length < def.warmupBars(input.params) + 1) {
        decisions.push({ ts: input.now.getTime(), action: 'WAIT', detail: `not enough closed bars for ${primary} (${primaryBars?.length ?? 0})` });
        return { changes, state, decisions };
      }
      const lastClosed = primaryBars[primaryBars.length - 1] as Bar;
      if (state.lastBarTs === lastClosed.ts) {
        return { changes, state, decisions }; // already decided on this bar
      }
      const missing = symbols.filter((s) => !markets[s]);
      if (missing.length > 0) {
        decisions.push({ ts: input.now.getTime(), action: 'NO_QUOTE', detail: `no live order book for ${missing.join(', ')}; not trading this bar` });
        return { changes, state, decisions };
      }
      const series: Record<string, BarSeries> = {};
      for (const s of symbols) series[s] = new BarSeries(bars[s] as Bar[]);
      const broker = new PaperAccountBroker(input.account, instruments, markets, `paper-${lastClosed.ts}`);
      const strategy = def.create();
      const scratch = (state.strategy as Record<string, unknown> | undefined) ?? {};
      const ctx: StrategyContext<P> = {
        params: input.params,
        primary,
        symbols,
        now: lastClosed.ts,
        allowShort: input.params.allowShort,
        bars: (s?: string) => {
          const b = series[s ?? primary];
          if (!b) throw new DataUnavailableError(`no bars for ${s}`);
          return b;
        },
        position: (s?: string) => broker.position(s ?? primary),
        equity: () => input.account.snapshot().equity.toNumber(),
        state: scratch,
        broker,
        log: (action, detail, data) => decisions.push({ ts: input.now.getTime(), action, detail, data }),
      };
      if (!state.initialized) {
        strategy.initialize(ctx);
        state.initialized = true;
      }
      runTradingStep(strategy, ctx);
      changes.push(...broker.changes);
      state.strategy = scratch;
      state.lastBarTs = lastClosed.ts;
      decisions.push({ ts: input.now.getTime(), action: 'DECIDED', detail: `evaluated bar ${new Date(lastClosed.ts).toISOString()} (close ${d(lastClosed.close).toSignificantDigits(8).toString()})` });
      return { changes, state, decisions };
    },
  };
}

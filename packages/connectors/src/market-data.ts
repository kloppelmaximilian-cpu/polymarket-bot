import { DataUnavailableError, ExternalApiError, describeError, type Bar, type FundingRatePoint, type OrderBook, type Quote } from '@aoc/core';
import type { DataBundle, DataRequirement, PredictionMarketSnapshot, QuoteSnapshot } from '@aoc/strategies';
import { HealthTracker } from './health';
import { HttpClient, type RequestInfo } from './http';
import { PolymarketConnector } from './polymarket';
import { ALLOWED_HOSTS, DATA_SOURCES, rateLimitsByHost } from './sources';
import type { BinanceStreams } from './streams';
import { BinanceConnector, CoinbaseConnector, KrakenConnector, intervalMs } from './venues';

/** Venue-specific symbols for a generic pair. */
export const SYMBOL_MAP: Record<string, Record<string, string>> = {
  'BTC-USD': { binance: 'BTCUSDT', coinbase: 'BTC-USD', kraken: 'XBTUSD' },
  'ETH-USD': { binance: 'ETHUSDT', coinbase: 'ETH-USD', kraken: 'ETHUSD' },
};

export interface MarketDataOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  staleAfterMs: number;
  enabled: boolean;
  onRequest?: (info: RequestInfo) => void;
  streams?: BinanceStreams | null;
}

/**
 * Single entry point for market data. Every request updates the per-source
 * health; when market data is disabled every call fails with
 * DATA_UNAVAILABLE instead of silently returning nothing.
 */
export class MarketDataService {
  readonly http: HttpClient;
  readonly health: HealthTracker;
  readonly binance: BinanceConnector;
  readonly coinbase: CoinbaseConnector;
  readonly kraken: KrakenConnector;
  readonly polymarket: PolymarketConnector;

  constructor(private readonly o: MarketDataOptions) {
    this.health = new HealthTracker(o.staleAfterMs);
    for (const d of DATA_SOURCES) this.health.configure(d.id, d.staleAfterMs);
    this.http = new HttpClient({
      fetch: o.fetch,
      timeoutMs: o.timeoutMs,
      allowedHosts: ALLOWED_HOSTS,
      rateLimits: rateLimitsByHost(),
      onRequest: (info) => {
        const now = Date.now();
        if (info.ok) this.health.success(info.source, now, info.latencyMs);
        else this.health.failure(info.source, now, info.error?.message ?? `HTTP ${info.status}`, info.error?.kind === 'MALFORMED');
        o.onRequest?.(info);
      },
    });
    this.binance = new BinanceConnector(this.http);
    this.coinbase = new CoinbaseConnector(this.http);
    this.kraken = new KrakenConnector(this.http);
    this.polymarket = new PolymarketConnector(this.http);
  }

  private guard(): void {
    if (!this.o.enabled) throw new DataUnavailableError('market data is disabled (MARKET_DATA_ENABLED=false)');
  }

  async bars(venue: string, symbol: string, interval: string, count: number): Promise<Bar[]> {
    this.guard();
    if (venue === 'binance' || venue === 'binance-futures') return this.binance.history(symbol, interval, count);
    if (venue === 'coinbase') return this.coinbase.candles(symbol, intervalMs(interval) / 1000);
    if (venue === 'kraken') return this.kraken.ohlc(symbol, intervalMs(interval) / 60_000);
    throw new DataUnavailableError(`no bar source for venue ${venue}`);
  }

  async funding(symbol: string, sinceMs: number): Promise<FundingRatePoint[]> {
    this.guard();
    return this.binance.fundingSince(symbol, sinceMs);
  }

  async book(venue: string, symbol: string): Promise<OrderBook> {
    this.guard();
    const streamed = venue === 'binance' ? this.o.streams?.quote(symbol) : undefined;
    if (streamed && Date.now() - streamed.receivedAt < 10_000) return streamed;
    if (venue === 'binance' || venue === 'binance-futures') return this.binance.book(symbol);
    if (venue === 'coinbase') return this.coinbase.book(symbol);
    if (venue === 'kraken') return this.kraken.book(symbol);
    throw new DataUnavailableError(`no book source for venue ${venue}`);
  }

  /** Top-of-book quotes for a generic pair across venues; failures are reported, not hidden. */
  async quotes(pair: string, venues: string[]): Promise<{ quotes: Quote[]; errors: string[] }> {
    this.guard();
    const errors: string[] = [];
    const quotes: Quote[] = [];
    await Promise.all(
      venues.map(async (v) => {
        const sym = SYMBOL_MAP[pair]?.[v];
        if (!sym) {
          errors.push(`${v}: no symbol mapping for ${pair}`);
          return;
        }
        try {
          const b = await this.book(v, sym);
          const bid = b.bids[0];
          const ask = b.asks[0];
          if (!bid || !ask) throw new ExternalApiError('MALFORMED', `${v}: empty book`);
          quotes.push({ venue: v, symbol: pair, bid: bid.price, ask: ask.price, bidSize: bid.size, askSize: ask.size, ts: b.ts, receivedAt: b.receivedAt });
        } catch (e) {
          errors.push(`${v}: ${describeError(e).message}`);
        }
      }),
    );
    return { quotes, errors };
  }

  async pmSnapshot(limit: number): Promise<{ snapshot: PredictionMarketSnapshot; notes: string[] }> {
    this.guard();
    const s = await this.polymarket.snapshot(limit);
    return { snapshot: { ts: s.ts, markets: s.markets.map((m) => ({ ...m, resolvedOutcome: null })) }, notes: s.notes };
  }

  /**
   * Live data for a paper tick. Each requirement is fetched independently;
   * one failing venue does not blank the others, and every failure is
   * returned so the caller can log it and degrade the source.
   */
  async liveBundle(reqs: DataRequirement[]): Promise<{ bundle: DataBundle; problems: string[] }> {
    const bundle: DataBundle = { provenance: 'PAPER', label: `live ${new Date().toISOString()}`, bars: {}, books: {}, funding: {} };
    const problems: string[] = [];
    if (!this.o.enabled) return { bundle, problems: ['market data is disabled (MARKET_DATA_ENABLED=false)'] };
    for (const r of reqs) {
      try {
        if (r.kind === 'BARS') {
          const streamed = r.venue === 'binance' ? this.o.streams?.bars(r.symbol) ?? [] : [];
          const bars = streamed.length >= r.minBars ? streamed : await this.bars(r.venue, r.symbol, r.interval, Math.min(r.minBars, 1500));
          bundle.bars![r.symbol] = bars;
          bundle.books![r.symbol] = await this.book(r.venue, r.symbol);
        } else if (r.kind === 'FUNDING') {
          bundle.funding![r.symbol] = await this.funding(r.symbol, Date.now() - 30 * 86_400_000);
        } else if (r.kind === 'QUOTES') {
          const { quotes, errors } = await this.quotes(r.symbol, r.venues);
          problems.push(...errors);
          const snap: QuoteSnapshot = { ts: Date.now(), quotes };
          bundle.quoteSeries = [...(bundle.quoteSeries ?? []), snap];
        } else if (r.kind === 'PM_MARKETS') {
          const { snapshot, notes } = await this.pmSnapshot(r.maxMarkets);
          problems.push(...notes.slice(0, 5));
          bundle.pmSeries = [snapshot];
        }
      } catch (e) {
        problems.push(`${r.kind}${'symbol' in r ? ` ${r.symbol}` : ''}: ${describeError(e).message}`);
      }
    }
    return { bundle, problems };
  }

  /** Cheap probes for the health job. */
  async probe(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (!this.o.enabled) return { all: 'disabled' };
    const probes: Array<[string, () => Promise<unknown>]> = [
      ['binance.spot.rest', () => this.binance.book('BTCUSDT', 5)],
      ['binance.futures.rest', () => this.binance.fundingHistory('BTCUSDT', { limit: 1 })],
      ['coinbase.exchange.rest', () => this.coinbase.book('BTC-USD', 5)],
      ['kraken.spot.rest', () => this.kraken.book('XBTUSD', 5)],
      ['polymarket.gamma', () => this.polymarket.activeMarkets(1)],
    ];
    await Promise.all(
      probes.map(async ([id, fn]) => {
        try {
          await fn();
          out[id] = 'ok';
        } catch (e) {
          out[id] = describeError(e).message;
        }
      }),
    );
    return out;
  }
}

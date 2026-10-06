import { ExternalApiError, type Bar, type FundingRatePoint, type OrderBook } from '@aoc/core';
import { z } from 'zod';
import type { HttpClient } from './http';

// ────────────────────────────────────────────────────────────── helpers ──

const num = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: `not a number: ${v}` });
    return z.NEVER;
  }
  return n;
});

function sortBook(bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>) {
  const b = bids.filter((l) => l.size > 0 && l.price > 0).sort((x, y) => y.price - x.price);
  const a = asks.filter((l) => l.size > 0 && l.price > 0).sort((x, y) => x.price - y.price);
  return { bids: b, asks: a };
}

/** A crossed or empty book is not usable data. */
export function validateBook(book: OrderBook): void {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (bid !== undefined && ask !== undefined && bid >= ask) {
    throw new ExternalApiError('MALFORMED', `${book.venue} ${book.symbol}: crossed book (bid ${bid} ≥ ask ${ask})`, { source: book.venue });
  }
}

const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
export function intervalMs(interval: string): number {
  const v = INTERVAL_MS[interval];
  if (!v) throw new RangeError(`unsupported interval ${interval}`);
  return v;
}

// ─────────────────────────────────────────────────────────────── Binance ──

const binanceKline = z.tuple([z.number(), num, num, num, num, num, z.number()]).rest(z.unknown());
const binanceKlines = z.array(binanceKline);
const binanceDepth = z.object({ lastUpdateId: z.number(), bids: z.array(z.tuple([num, num])), asks: z.array(z.tuple([num, num])) });
const binanceFunding = z.array(z.object({ symbol: z.string(), fundingRate: num, fundingTime: z.number(), markPrice: num.optional().or(z.literal('').transform(() => undefined)) }));

export class BinanceConnector {
  constructor(
    private readonly http: HttpClient,
    private readonly spotBase = 'https://data-api.binance.vision',
    private readonly futuresBase = 'https://fapi.binance.com',
  ) {}

  private async rawKlines(symbol: string, interval: string, opts: { startTime?: number; endTime?: number; limit?: number }) {
    return this.http.json(`${this.spotBase}/api/v3/klines`, binanceKlines, {
      source: 'binance.spot.rest',
      query: { symbol, interval, startTime: opts.startTime, endTime: opts.endTime, limit: opts.limit ?? 1000 },
      weight: 2,
    });
  }

  /**
   * Closed klines only: the bar still forming (closeTime in the future) is
   * dropped, so a backtest or paper decision never sees a partial bar.
   */
  async klines(symbol: string, interval: string, opts: { startTime?: number; endTime?: number; limit?: number; now?: number } = {}): Promise<Bar[]> {
    const rows = await this.rawKlines(symbol, interval, opts);
    const now = opts.now ?? Date.now();
    return rows.filter((r) => r[6] < now).map((r) => ({ ts: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
  }

  /** Page backwards until `count` closed bars are collected. */
  async history(symbol: string, interval: string, count: number, now = Date.now()): Promise<Bar[]> {
    const out = new Map<number, Bar>();
    let end = now;
    for (let guard = 0; guard < 50 && out.size < count; guard++) {
      const rows = await this.rawKlines(symbol, interval, { endTime: end, limit: 1000 });
      if (rows.length === 0) break;
      for (const r of rows) if (r[6] < now) out.set(r[0], { ts: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] });
      const first = rows[0]![0];
      if (first >= end) break;
      end = first - 1;
      // Paging decisions use the raw page size: filtering the forming bar must not end the paging early.
      if (rows.length < 1000) break;
    }
    return [...out.values()].sort((a, b) => a.ts - b.ts).slice(-count);
  }

  async book(symbol: string, limit = 20): Promise<OrderBook> {
    const now = Date.now();
    const d = await this.http.json(`${this.spotBase}/api/v3/depth`, binanceDepth, { source: 'binance.spot.rest', query: { symbol, limit }, weight: 5 });
    const { bids, asks } = sortBook(
      d.bids.map(([price, size]) => ({ price, size })),
      d.asks.map(([price, size]) => ({ price, size })),
    );
    const book: OrderBook = { venue: 'binance', symbol, bids, asks, ts: now, receivedAt: Date.now() };
    validateBook(book);
    return book;
  }

  async fundingHistory(symbol: string, opts: { startTime?: number; endTime?: number; limit?: number } = {}): Promise<FundingRatePoint[]> {
    const rows = await this.http.json(`${this.futuresBase}/fapi/v1/fundingRate`, binanceFunding, {
      source: 'binance.futures.rest',
      query: { symbol, startTime: opts.startTime, endTime: opts.endTime, limit: opts.limit ?? 1000 },
    });
    return rows
      .map((r) => ({ venue: 'binance-futures', symbol: r.symbol, fundingTime: r.fundingTime, rate: r.fundingRate, markPrice: r.markPrice && r.markPrice > 0 ? r.markPrice : undefined }))
      .sort((a, b) => a.fundingTime - b.fundingTime);
  }

  /** Page forwards from `startTime` to now. */
  async fundingSince(symbol: string, startTime: number): Promise<FundingRatePoint[]> {
    const out = new Map<number, FundingRatePoint>();
    let start = startTime;
    for (let guard = 0; guard < 30; guard++) {
      const batch = await this.fundingHistory(symbol, { startTime: start, limit: 1000 });
      for (const f of batch) out.set(f.fundingTime, f);
      if (batch.length < 1000) break;
      start = batch[batch.length - 1]!.fundingTime + 1;
    }
    return [...out.values()].sort((a, b) => a.fundingTime - b.fundingTime);
  }
}

// ────────────────────────────────────────────────────────────── Coinbase ──

const coinbaseBook = z.object({ bids: z.array(z.tuple([num, num]).rest(z.unknown())), asks: z.array(z.tuple([num, num]).rest(z.unknown())) });
const coinbaseCandles = z.array(z.tuple([z.number(), num, num, num, num, num]));

export class CoinbaseConnector {
  constructor(
    private readonly http: HttpClient,
    private readonly base = 'https://api.exchange.coinbase.com',
  ) {}

  async book(productId: string, depth = 20): Promise<OrderBook> {
    const d = await this.http.json(`${this.base}/products/${encodeURIComponent(productId)}/book`, coinbaseBook, { source: 'coinbase.exchange.rest', query: { level: 2 } });
    const { bids, asks } = sortBook(
      d.bids.slice(0, depth).map((r) => ({ price: r[0], size: r[1] })),
      d.asks.slice(0, depth).map((r) => ({ price: r[0], size: r[1] })),
    );
    const now = Date.now();
    const book: OrderBook = { venue: 'coinbase', symbol: productId, bids, asks, ts: now, receivedAt: now };
    validateBook(book);
    return book;
  }

  /** Rows are [time(s), low, high, open, close, volume], newest first — note the order. */
  async candles(productId: string, granularitySeconds: number, start?: number, end?: number): Promise<Bar[]> {
    const rows = await this.http.json(`${this.base}/products/${encodeURIComponent(productId)}/candles`, coinbaseCandles, {
      source: 'coinbase.exchange.rest',
      query: { granularity: granularitySeconds, start: start ? new Date(start).toISOString() : undefined, end: end ? new Date(end).toISOString() : undefined },
    });
    return rows.map(([t, low, high, open, close, volume]) => ({ ts: t * 1000, open, high, low, close, volume })).sort((a, b) => a.ts - b.ts);
  }
}

// ──────────────────────────────────────────────────────────────── Kraken ──

const krakenEnvelope = <T extends z.ZodTypeAny>(result: T) => z.object({ error: z.array(z.string()), result: result.optional() });
const krakenDepth = krakenEnvelope(z.record(z.string(), z.object({ bids: z.array(z.tuple([num, num]).rest(z.unknown())), asks: z.array(z.tuple([num, num]).rest(z.unknown())) })));
const krakenOhlc = krakenEnvelope(z.record(z.string(), z.unknown()));
const krakenOhlcRow = z.tuple([z.number(), num, num, num, num, num, num, z.number()]);

export class KrakenConnector {
  constructor(
    private readonly http: HttpClient,
    private readonly base = 'https://api.kraken.com',
  ) {}

  private unwrap<T>(res: { error: string[]; result?: T | undefined }): T {
    if (res.error.length > 0) throw new ExternalApiError('HTTP', `kraken: ${res.error.join('; ')}`, { source: 'kraken.spot.rest' });
    if (res.result === undefined) throw new ExternalApiError('MALFORMED', 'kraken: missing result', { source: 'kraken.spot.rest' });
    return res.result;
  }

  async book(pair: string, count = 20): Promise<OrderBook> {
    const result = this.unwrap(await this.http.json(`${this.base}/0/public/Depth`, krakenDepth, { source: 'kraken.spot.rest', query: { pair, count } }));
    const entry = Object.values(result)[0];
    if (!entry) throw new ExternalApiError('MALFORMED', `kraken: no book for ${pair}`, { source: 'kraken.spot.rest' });
    const { bids, asks } = sortBook(
      entry.bids.map((r) => ({ price: r[0], size: r[1] })),
      entry.asks.map((r) => ({ price: r[0], size: r[1] })),
    );
    const now = Date.now();
    const book: OrderBook = { venue: 'kraken', symbol: pair, bids, asks, ts: now, receivedAt: now };
    validateBook(book);
    return book;
  }

  /** Rows are [time(s), open, high, low, close, vwap, volume, count]; the last row is the unfinished bar and is dropped. */
  async ohlc(pair: string, intervalMinutes: number, since?: number): Promise<Bar[]> {
    const result = this.unwrap(await this.http.json(`${this.base}/0/public/OHLC`, krakenOhlc, { source: 'kraken.spot.rest', query: { pair, interval: intervalMinutes, since } }));
    const key = Object.keys(result).find((k) => k !== 'last');
    const rows = z.array(krakenOhlcRow).safeParse(key ? result[key] : undefined);
    if (!rows.success) throw new ExternalApiError('MALFORMED', 'kraken: unexpected OHLC rows', { source: 'kraken.spot.rest' });
    return rows.data.slice(0, -1).map(([t, open, high, low, close, , volume]) => ({ ts: t * 1000, open, high, low, close, volume }));
  }
}

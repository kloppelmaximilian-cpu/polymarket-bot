import { ExternalApiError } from '@aoc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ALLOWED_HOSTS,
  BINANCE_WS_SOURCE,
  BinanceConnector,
  BinanceStreams,
  CoinbaseConnector,
  HealthTracker,
  HttpClient,
  KrakenConnector,
  MarketDataService,
  PolymarketConnector,
  ResilientSocket,
  TokenBucket,
  deriveHealth,
  type RequestInfo,
  type WebSocketLike,
} from '../src';

/*
 * Fixtures below follow the response formats in each venue's public API
 * documentation. They were written by hand from the docs (the build sandbox
 * cannot reach the venues), so they test the parsers' handling of the
 * documented shapes, not a captured live response.
 */

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init ?? {})) as typeof fetch;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const noSleep = async () => undefined;
const client = (handler: Handler, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) =>
  new HttpClient({ fetch: mockFetch(handler), allowedHosts: ALLOWED_HOSTS, sleep: noSleep, ...extra });

describe('HttpClient', () => {
  it('refuses hosts outside the allowlist', async () => {
    const http = client(() => json({}));
    await expect(http.request('https://evil.example.com/x', { source: 't' })).rejects.toMatchObject({ kind: 'BLOCKED' });
    await expect(http.request('file:///etc/passwd', { source: 't' })).rejects.toBeInstanceOf(ExternalApiError);
  });

  it('retries server errors and succeeds', async () => {
    let calls = 0;
    const http = client(() => (++calls < 3 ? json({ msg: 'boom' }, 503) : json({ ok: true })));
    expect(await http.json('https://api.kraken.com/x', z.object({ ok: z.boolean() }), { source: 't' })).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('honours Retry-After on 429 and gives up after the retry budget', async () => {
    const waits: number[] = [];
    const http = client(() => json({}, 429, { 'retry-after': '7' }), { sleep: async (ms) => void waits.push(ms), retries: 2 });
    await expect(http.request('https://api.kraken.com/x', { source: 't' })).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    expect(waits).toEqual([7000, 7000]);
  });

  it('does not retry client errors and classifies geo blocks', async () => {
    let calls = 0;
    const http = client(() => {
      calls++;
      return new Response('Service unavailable from a restricted location', { status: 451 });
    });
    await expect(http.request('https://data-api.binance.vision/api/v3/depth', { source: 't' })).rejects.toMatchObject({ kind: 'BLOCKED' });
    expect(calls).toBe(1);
  });

  it('classifies timeouts and network errors', async () => {
    const timeout = client(() => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    }, { retries: 0 });
    await expect(timeout.request('https://api.kraken.com/x', { source: 't' })).rejects.toMatchObject({ kind: 'TIMEOUT' });
    const net = client(() => {
      throw new TypeError('fetch failed');
    }, { retries: 0 });
    await expect(net.request('https://api.kraken.com/x', { source: 't' })).rejects.toMatchObject({ kind: 'NETWORK' });
  });

  it('rejects non-JSON and schema-violating responses as MALFORMED and reports them', async () => {
    const seen: RequestInfo[] = [];
    const bad = client(() => new Response('<html>', { status: 200 }), { onRequest: (i) => seen.push(i) });
    await expect(bad.request('https://api.kraken.com/x', { source: 't' })).rejects.toMatchObject({ kind: 'MALFORMED' });
    const wrong = client(() => json({ price: 'abc' }), { onRequest: (i) => seen.push(i) });
    await expect(wrong.json('https://api.kraken.com/x', z.object({ price: z.number() }), { source: 't' })).rejects.toMatchObject({ kind: 'MALFORMED' });
    expect(seen.filter((s) => !s.ok)).toHaveLength(2);
  });
});

describe('TokenBucket', () => {
  it('throttles and refills', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const b = new TokenBucket(2, 1, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    await b.take();
    expect(sleeps.length).toBeGreaterThan(0);
    t += 10_000;
    expect(b.available()).toBe(2);
  });
});

describe('data health', () => {
  const base = { id: 's', lastErrorAt: null, lastError: null, consecutiveFailures: 0, latencyMs: 100, successCount: 1, errorCount: 0, malformedCount: 0, staleAfterMs: 60_000 };
  it('derives CONNECTED, DEGRADED, STALE and OFFLINE', () => {
    expect(deriveHealth({ ...base, lastSuccessAt: null }, 0)).toBe('OFFLINE');
    expect(deriveHealth({ ...base, lastSuccessAt: 1000 }, 2000)).toBe('CONNECTED');
    expect(deriveHealth({ ...base, lastSuccessAt: 1000, consecutiveFailures: 1 }, 2000)).toBe('DEGRADED');
    expect(deriveHealth({ ...base, lastSuccessAt: 1000, latencyMs: 9000 }, 2000)).toBe('DEGRADED');
    expect(deriveHealth({ ...base, lastSuccessAt: 1000 }, 120_000)).toBe('STALE');
    expect(deriveHealth({ ...base, lastSuccessAt: 1000, consecutiveFailures: 5 }, 120_000)).toBe('OFFLINE');
  });
  it('tracks successes and failures', () => {
    const h = new HealthTracker(60_000);
    h.success('a', 1000, 50);
    h.failure('a', 1500, 'x');
    expect(h.status('a', 1600)).toBe('DEGRADED');
    h.success('a', 1700, 50);
    expect(h.status('a', 1800)).toBe('CONNECTED');
  });
});

describe('Binance', () => {
  // GET /api/v3/klines rows: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBase, takerQuote, ignore]
  const row = (t: number, c: string) => [t, '100.0', '101.0', '99.0', c, '12.5', t + 3_599_999, '1250', 42, '6', '600', '0'];

  it('parses klines and drops the still-forming bar', async () => {
    const now = 3 * 3_600_000 + 10;
    const http = client(() => json([row(0, '100.5'), row(3_600_000, '100.7'), row(7_200_000, '100.9'), row(10_800_000, '101.0')]));
    const bars = await new BinanceConnector(http).klines('BTCUSDT', '1h', { now });
    expect(bars).toHaveLength(3);
    expect(bars[0]).toEqual({ ts: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 12.5 });
  });

  it('pages history backwards without duplicates', async () => {
    const H = 3_600_000;
    const now = 3000 * H;
    const http = client((url) => {
      // Binance returns klines whose openTime lies in [startTime, endTime]
      const end = Number(url.searchParams.get('endTime'));
      const lastOpen = Math.floor(end / H) * H;
      const rows = [];
      for (let t = lastOpen - 999 * H; t <= lastOpen; t += H) if (t >= 0) rows.push(row(t, '100'));
      return json(rows);
    });
    const bars = await new BinanceConnector(http).history('BTCUSDT', '1h', 1500, now);
    expect(bars).toHaveLength(1500);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.ts - bars[i - 1]!.ts).toBe(H);
    expect(bars[bars.length - 1]!.ts).toBe(now - H);
  });

  it('rejects a crossed order book', async () => {
    const http = client(() => json({ lastUpdateId: 1, bids: [['101', '1']], asks: [['100', '1']] }));
    await expect(new BinanceConnector(http).book('BTCUSDT')).rejects.toMatchObject({ kind: 'MALFORMED' });
  });

  it('parses funding history (fundingRate and markPrice are strings)', async () => {
    const http = client(() => json([{ symbol: 'BTCUSDT', fundingRate: '0.00010000', fundingTime: 1_700_000_000_000, markPrice: '35000.1' }]));
    const f = await new BinanceConnector(http).fundingHistory('BTCUSDT');
    expect(f[0]).toEqual({ venue: 'binance-futures', symbol: 'BTCUSDT', fundingTime: 1_700_000_000_000, rate: 0.0001, markPrice: 35000.1 });
  });
});

describe('Coinbase and Kraken', () => {
  it('maps Coinbase candles [time, low, high, open, close, volume] correctly', async () => {
    const http = client(() => json([[1_700_003_600, 95, 105, 100, 102, 7], [1_700_000_000, 90, 110, 99, 100, 5]]));
    const bars = await new CoinbaseConnector(http).candles('BTC-USD', 3600);
    expect(bars[0]).toEqual({ ts: 1_700_000_000_000, open: 99, high: 110, low: 90, close: 100, volume: 5 });
    expect(bars[1]!.open).toBe(100);
  });

  it('parses a Coinbase level-2 book', async () => {
    const http = client(() => json({ sequence: 1, bids: [['99.5', '2', 3]], asks: [['100.5', '1', 1]] }));
    const b = await new CoinbaseConnector(http).book('BTC-USD');
    expect(b.bids[0]).toEqual({ price: 99.5, size: 2 });
  });

  it('drops Kraken’s unfinished OHLC row and surfaces API errors', async () => {
    const http = client(() => json({ error: [], result: { XXBTZUSD: [[1_700_000_000, '1', '2', '0.5', '1.5', '1.2', '10', 5], [1_700_003_600, '1.5', '2', '1', '1.8', '1.6', '3', 2]], last: 1_700_003_600 } }));
    const bars = await new KrakenConnector(http).ohlc('XBTUSD', 60);
    expect(bars).toEqual([{ ts: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
    const err = client(() => json({ error: ['EQuery:Unknown asset pair'] }));
    await expect(new KrakenConnector(err).book('NOPE')).rejects.toThrow(/Unknown asset pair/);
  });
});

describe('Polymarket', () => {
  const gamma = [
    { id: '1', question: 'Will A happen?', outcomes: '["Yes","No"]', clobTokenIds: '["tY","tN"]', active: true, closed: false, enableOrderBook: true, endDate: '2026-12-31T00:00:00Z', negRisk: false },
    { id: '2', question: 'No book', outcomes: '["Yes","No"]', clobTokenIds: '["x","y"]', enableOrderBook: false },
    { id: '3', question: 'Malformed', outcomes: 'not json' },
  ];
  // /books returns bids ascending and asks descending (documented quirk); strings for numbers
  const books = [
    { asset_id: 'tY', bids: [{ price: '0.40', size: '10' }, { price: '0.44', size: '5' }], asks: [{ price: '0.50', size: '7' }, { price: '0.46', size: '3' }], timestamp: '1700000000000', tick_size: '0.01' },
    { asset_id: 'tN', bids: [{ price: '0.52', size: '4' }], asks: [{ price: '0.55', size: '9' }] },
  ];

  it('parses stringified arrays, skips unusable markets and normalises book order', async () => {
    const http = client((url) => (url.hostname === 'gamma-api.polymarket.com' ? json(gamma) : json(books)));
    const snap = await new PolymarketConnector(http).snapshot(10);
    expect(snap.markets).toHaveLength(1);
    const yes = snap.markets[0]!.outcomes[0]!;
    expect(yes.book.bids.map((l) => l.price)).toEqual([0.44, 0.4]);
    expect(yes.book.asks.map((l) => l.price)).toEqual([0.46, 0.5]);
    expect(yes.feeModel).toBe('none');
    expect(snap.notes.join()).toMatch(/no fee schedule/);
  });

  it('fails loudly when nothing matches the schema', async () => {
    const http = client(() => json([{ nonsense: true }]));
    await expect(new PolymarketConnector(http).activeMarkets(5)).rejects.toMatchObject({ kind: 'MALFORMED' });
  });
});

describe('MarketDataService', () => {
  it('reports one failing venue without blanking the others, and updates health', async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.hostname === 'api.kraken.com') return new Response('down', { status: 503 });
      if (url.hostname === 'api.exchange.coinbase.com') return json({ bids: [['99', '1']], asks: [['101', '1']] });
      return json({ lastUpdateId: 1, bids: [['100', '1']], asks: [['100.1', '1']] });
    });
    const md = new MarketDataService({ fetch: fetchImpl, staleAfterMs: 60_000, enabled: true });
    const { quotes, errors } = await md.quotes('BTC-USD', ['binance', 'coinbase', 'kraken']);
    expect(quotes.map((q) => q.venue).sort()).toEqual(['binance', 'coinbase']);
    expect(errors.join()).toMatch(/kraken/);
    expect(md.health.status('kraken.spot.rest', Date.now())).toBe('OFFLINE');
    expect(md.health.status('binance.spot.rest', Date.now())).toBe('CONNECTED');
  }, 20_000);

  it('refuses to fetch when market data is disabled', async () => {
    const md = new MarketDataService({ fetch: mockFetch(() => json({})), staleAfterMs: 60_000, enabled: false });
    await expect(md.book('binance', 'BTCUSDT')).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    const live = await md.liveBundle([{ kind: 'NONE' }]);
    expect(live.problems.join()).toMatch(/disabled/);
  });
});

describe('websockets', () => {
  class FakeSocket implements WebSocketLike {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    closed = false;
    on(event: string, l: (...a: unknown[]) => void) {
      (this.handlers[event] ??= []).push(l);
      return this;
    }
    emit(event: string, ...a: unknown[]) {
      for (const l of this.handlers[event] ?? []) l(...a);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.closed = true;
      this.emit('close');
    }
    terminate() {
      this.close();
    }
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('subscribes on open, counts malformed frames, reconnects after close and after silence', () => {
    const sockets: FakeSocket[] = [];
    const got: unknown[] = [];
    const s = new ResilientSocket({
      url: 'wss://example',
      name: 't',
      staleAfterMs: 3000,
      onMessage: (m) => got.push(m),
      onOpen: (send) => send('{"subscribe":true}'),
      createSocket: () => {
        const f = new FakeSocket();
        sockets.push(f);
        return f;
      },
    });
    s.start();
    sockets[0]!.emit('open');
    expect(sockets[0]!.sent).toEqual(['{"subscribe":true}']);
    sockets[0]!.emit('message', Buffer.from('{"a":1}'));
    sockets[0]!.emit('message', 'not json');
    expect(got).toEqual([{ a: 1 }]);
    expect(s.malformed).toBe(1);
    sockets[0]!.close();
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit('open');
    vi.advanceTimersByTime(5000); // silent for longer than staleAfterMs
    vi.advanceTimersByTime(3000);
    expect(sockets.length).toBeGreaterThanOrEqual(3);
    s.stop();
  });

  it('decodes Binance bookTicker and closed klines from the combined stream', () => {
    const st = new BinanceStreams(['BTCUSDT'], '1h');
    st.handle({ stream: 'btcusdt@bookTicker', data: { u: 1, s: 'BTCUSDT', b: '100.0', B: '2', a: '100.1', A: '3' } });
    expect(st.quote('BTCUSDT')!.asks[0]).toEqual({ price: 100.1, size: 3 });
    st.handle({ stream: 'btcusdt@kline_1h', data: { e: 'kline', E: 1, s: 'BTCUSDT', k: { t: 0, T: 3_599_999, o: '1', h: '2', l: '0.5', c: '1.5', v: '9', x: false } } });
    expect(st.bars('BTCUSDT')).toHaveLength(0); // not closed yet
    st.handle({ stream: 'btcusdt@kline_1h', data: { e: 'kline', E: 2, s: 'BTCUSDT', k: { t: 0, T: 3_599_999, o: '1', h: '2', l: '0.5', c: '1.5', v: '9', x: true } } });
    expect(st.bars('BTCUSDT')).toHaveLength(1);
    st.handle({ garbage: true });
    st.handle({ stream: 'btcusdt@bookTicker', data: { s: 'BTCUSDT', b: '101', B: '1', a: '100', A: '1' } }); // crossed → ignored
    expect(st.quote('BTCUSDT')!.bids[0]!.price).toBe(100);
  });

  it('reports the stream to the health table: messages connect it, disconnects count as failures', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const md = new MarketDataService({ staleAfterMs: 60_000, enabled: true, fetch: (async () => new Response('[]')) as typeof fetch });
    const st = new BinanceStreams(['BTCUSDT'], '1h');
    expect(md.health.status(BINANCE_WS_SOURCE, Date.now())).toBe('OFFLINE');
    md.attachStreams(st);
    const tick = { stream: 'btcusdt@bookTicker', data: { u: 1, s: 'BTCUSDT', b: '100', B: '1', a: '101', A: '1' } };
    st.handle(tick);
    expect(md.health.status(BINANCE_WS_SOURCE, Date.now())).toBe('CONNECTED');
    // Many messages per second are sampled, not counted one by one.
    for (let i = 0; i < 50; i++) st.handle(tick);
    expect(md.health.state(BINANCE_WS_SOURCE).successCount).toBe(1);
    vi.advanceTimersByTime(6_000);
    st.handle(tick);
    expect(md.health.state(BINANCE_WS_SOURCE).successCount).toBe(2);
    st.onSocketState('CLOSED', 'stale: no messages');
    expect(md.health.state(BINANCE_WS_SOURCE).lastError).toMatch(/stale/);
    expect(md.health.status(BINANCE_WS_SOURCE, Date.now())).toBe('DEGRADED');
    // An error followed by a close counts once, with the error as the reason.
    st.onSocketState('OPEN', 'error: getaddrinfo ENOTFOUND');
    st.onSocketState('CLOSED', 'closed');
    expect(md.health.state(BINANCE_WS_SOURCE).lastError).toBe('websocket closed (error: getaddrinfo ENOTFOUND)');
    expect(md.health.state(BINANCE_WS_SOURCE).consecutiveFailures).toBe(2);
    // A deliberate stop is not a failure; a detached stream reports nothing.
    st.onSocketState('CLOSED', 'stopped');
    md.attachStreams(null);
    st.onSocketState('CLOSED', 'closed');
    expect(md.health.state(BINANCE_WS_SOURCE).consecutiveFailures).toBe(2);
    vi.useRealTimers();
  });
});

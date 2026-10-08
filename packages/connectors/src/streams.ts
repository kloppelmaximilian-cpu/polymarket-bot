import type { Bar, OrderBook } from '@aoc/core';
import { z } from 'zod';
import { ResilientSocket, type SocketState } from './ws';

const num = z.union([z.string(), z.number()]).transform(Number);
const bookTicker = z.object({ s: z.string(), b: num, B: num, a: num, A: num });
const kline = z.object({ e: z.literal('kline'), s: z.string(), k: z.object({ t: z.number(), T: z.number(), o: num, h: num, l: num, c: num, v: num, x: z.boolean() }) });
const combined = z.object({ stream: z.string(), data: z.unknown() });

/** Data-source id of the stream in the health table. */
export const BINANCE_WS_SOURCE = 'binance.spot.ws';

/** Where the stream reports its health (the market data service's tracker). */
export interface StreamHealthSink {
  success(id: string, at: number, latencyMs: number): void;
  failure(id: string, at: number, message: string, malformed?: boolean): void;
}

/** Record a live stream at most this often (a busy stream sends many messages per second). */
const HEALTH_SAMPLE_MS = 5_000;

/**
 * Live Binance top-of-book and closed klines over one combined stream.
 * Consumers read the latest values; staleness is decided by the caller from
 * `receivedAt`.
 */
export class BinanceStreams {
  private readonly quotes = new Map<string, OrderBook>();
  private readonly closedBars = new Map<string, Bar[]>();
  private socket: ResilientSocket | null = null;
  private health: StreamHealthSink | null = null;
  private lastHealthSample = 0;
  private pendingError: string | null = null;
  state: SocketState = 'IDLE';

  constructor(
    private readonly symbols: string[],
    private readonly interval: string,
    private readonly opts: { base?: string; staleAfterMs?: number; onState?: (s: SocketState, d?: string) => void } = {},
  ) {}

  start(): void {
    const streams = this.symbols.flatMap((s) => [`${s.toLowerCase()}@bookTicker`, `${s.toLowerCase()}@kline_${this.interval}`]).join('/');
    this.socket = new ResilientSocket({
      url: `${this.opts.base ?? 'wss://data-stream.binance.vision'}/stream?streams=${streams}`,
      name: BINANCE_WS_SOURCE,
      staleAfterMs: this.opts.staleAfterMs ?? 30_000,
      onMessage: (m) => this.handle(m),
      onStateChange: (s, d) => this.onSocketState(s, d),
    });
    this.socket.start();
  }

  /** Report messages and disconnects to a health tracker (shown on the System page). */
  reportHealthTo(sink: StreamHealthSink | null): void {
    this.health = sink;
  }

  onSocketState(state: SocketState, detail?: string): void {
    this.state = state;
    this.opts.onState?.(state, detail);
    // An error is followed by a close: report once, with the error as the reason.
    if (detail?.startsWith('error')) {
      this.pendingError = detail;
      return;
    }
    if (state !== 'CLOSED') return;
    const reason = [this.pendingError, detail && detail !== 'closed' ? detail : null].filter(Boolean).join('; ');
    this.pendingError = null;
    if (detail === 'stopped') return;
    this.health?.failure(BINANCE_WS_SOURCE, Date.now(), `websocket closed${reason ? ` (${reason})` : ''}`);
  }

  private alive(now: number): void {
    if (!this.health || now - this.lastHealthSample < HEALTH_SAMPLE_MS) return;
    this.lastHealthSample = now;
    this.health.success(BINANCE_WS_SOURCE, now, 0);
  }

  stop(): void {
    this.socket?.stop();
  }

  handle(message: unknown): void {
    const env = combined.safeParse(message);
    const data = env.success ? env.data.data : message;
    const bt = bookTicker.safeParse(data);
    if (bt.success) {
      const now = Date.now();
      this.alive(now);
      const q = bt.data;
      if (q.b > 0 && q.a > q.b) this.quotes.set(q.s, { venue: 'binance', symbol: q.s, bids: [{ price: q.b, size: q.B }], asks: [{ price: q.a, size: q.A }], ts: now, receivedAt: now });
      return;
    }
    const k = kline.safeParse(data);
    if (k.success) this.alive(Date.now());
    if (k.success && k.data.k.x) {
      const bar: Bar = { ts: k.data.k.t, open: k.data.k.o, high: k.data.k.h, low: k.data.k.l, close: k.data.k.c, volume: k.data.k.v };
      const list = this.closedBars.get(k.data.s) ?? [];
      if (list.length === 0 || list[list.length - 1]!.ts < bar.ts) list.push(bar);
      this.closedBars.set(k.data.s, list.slice(-2000));
    }
  }

  quote(symbol: string): OrderBook | undefined {
    return this.quotes.get(symbol);
  }

  bars(symbol: string): Bar[] {
    return this.closedBars.get(symbol) ?? [];
  }

  stats(): { messages: number; malformed: number; lastMessageAt: number } {
    return { messages: this.socket?.messages ?? 0, malformed: this.socket?.malformed ?? 0, lastMessageAt: this.socket?.lastMessage() ?? 0 };
  }
}

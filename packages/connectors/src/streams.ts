import type { Bar, OrderBook } from '@aoc/core';
import { z } from 'zod';
import { ResilientSocket, type SocketState } from './ws';

const num = z.union([z.string(), z.number()]).transform(Number);
const bookTicker = z.object({ s: z.string(), b: num, B: num, a: num, A: num });
const kline = z.object({ e: z.literal('kline'), s: z.string(), k: z.object({ t: z.number(), T: z.number(), o: num, h: num, l: num, c: num, v: num, x: z.boolean() }) });
const combined = z.object({ stream: z.string(), data: z.unknown() });

/**
 * Live Binance top-of-book and closed klines over one combined stream.
 * Consumers read the latest values; staleness is decided by the caller from
 * `receivedAt`.
 */
export class BinanceStreams {
  private readonly quotes = new Map<string, OrderBook>();
  private readonly closedBars = new Map<string, Bar[]>();
  private socket: ResilientSocket | null = null;
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
      name: 'binance.spot.ws',
      staleAfterMs: this.opts.staleAfterMs ?? 30_000,
      onMessage: (m) => this.handle(m),
      onStateChange: (s, d) => {
        this.state = s;
        this.opts.onState?.(s, d);
      },
    });
    this.socket.start();
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
      const q = bt.data;
      if (q.b > 0 && q.a > q.b) this.quotes.set(q.s, { venue: 'binance', symbol: q.s, bids: [{ price: q.b, size: q.B }], asks: [{ price: q.a, size: q.A }], ts: now, receivedAt: now });
      return;
    }
    const k = kline.safeParse(data);
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

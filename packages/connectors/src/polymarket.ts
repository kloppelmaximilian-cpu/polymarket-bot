import { ExternalApiError, type OrderBook, type OutcomeBook } from '@aoc/core';
import { z } from 'zod';
import type { HttpClient } from './http';
import { validateBook } from './venues';

/** Gamma returns some arrays as stringified JSON; accept both forms. */
const jsonArray = z.union([z.array(z.string()), z.string()]).transform((v, ctx) => {
  if (Array.isArray(v)) return v;
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[];
  } catch {
    /* handled below */
  }
  ctx.addIssue({ code: 'custom', message: 'expected a JSON array of strings' });
  return z.NEVER;
});

const gammaMarket = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  question: z.string(),
  conditionId: z.string().optional(),
  slug: z.string().optional(),
  endDate: z.string().optional().nullable(),
  outcomes: jsonArray,
  clobTokenIds: jsonArray.optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  enableOrderBook: z.boolean().optional(),
  negRisk: z.boolean().optional().nullable(),
  feeSchedule: z.object({ rate: z.union([z.number(), z.string()]).transform(Number), takerOnly: z.boolean().optional() }).partial().optional().nullable(),
  orderPriceMinTickSize: z.union([z.number(), z.string()]).transform(Number).optional().nullable(),
  volume24hr: z.union([z.number(), z.string()]).transform(Number).optional().nullable(),
  liquidity: z.union([z.number(), z.string()]).transform(Number).optional().nullable(),
});
export type GammaMarket = z.output<typeof gammaMarket>;

const level = z.object({ price: z.union([z.string(), z.number()]).transform(Number), size: z.union([z.string(), z.number()]).transform(Number) });
const clobBook = z.object({ asset_id: z.string(), bids: z.array(level), asks: z.array(level), timestamp: z.union([z.string(), z.number()]).optional(), tick_size: z.union([z.string(), z.number()]).optional() });

export interface PMMarketSnapshot {
  marketId: string;
  question: string;
  negRisk: boolean;
  outcomes: OutcomeBook[];
}

export class PolymarketConnector {
  constructor(
    private readonly http: HttpClient,
    private readonly gammaBase = 'https://gamma-api.polymarket.com',
    private readonly clobBase = 'https://clob.polymarket.com',
  ) {}

  /** Active markets with an order book, most traded first. */
  async activeMarkets(limit = 50): Promise<GammaMarket[]> {
    const rows = await this.http.json(`${this.gammaBase}/markets`, z.array(z.unknown()), {
      source: 'polymarket.gamma',
      query: { active: true, closed: false, limit: Math.min(500, limit * 2), order: 'volume24hr', ascending: false },
    });
    const out: GammaMarket[] = [];
    let malformed = 0;
    for (const r of rows) {
      const p = gammaMarket.safeParse(r);
      if (!p.success) {
        malformed++;
        continue;
      }
      const m = p.data;
      if (m.enableOrderBook === false || m.closed) continue;
      if (!m.clobTokenIds || m.clobTokenIds.length !== m.outcomes.length) continue;
      out.push(m);
      if (out.length >= limit) break;
    }
    if (rows.length > 0 && malformed === rows.length) throw new ExternalApiError('MALFORMED', 'polymarket.gamma: no market matched the expected schema', { source: 'polymarket.gamma' });
    return out;
  }

  /** Books for many tokens in one request. Bids are re-sorted descending, asks ascending. */
  async books(tokenIds: string[]): Promise<Map<string, OrderBook>> {
    const out = new Map<string, OrderBook>();
    for (let i = 0; i < tokenIds.length; i += 500) {
      const chunk = tokenIds.slice(i, i + 500);
      const rows = await this.http.json(`${this.clobBase}/books`, z.array(clobBook), { source: 'polymarket.clob', method: 'POST', body: chunk.map((token_id) => ({ token_id })) });
      const now = Date.now();
      for (const r of rows) {
        const bids = r.bids.filter((l) => l.size > 0).sort((a, b) => b.price - a.price);
        const asks = r.asks.filter((l) => l.size > 0).sort((a, b) => a.price - b.price);
        const ts = r.timestamp !== undefined ? Number(r.timestamp) : now;
        const book: OrderBook = { venue: 'polymarket', symbol: r.asset_id, bids, asks, ts: Number.isFinite(ts) ? ts : now, receivedAt: now, tickSize: r.tick_size !== undefined ? Number(r.tick_size) : undefined };
        validateBook(book);
        out.set(r.asset_id, book);
      }
    }
    return out;
  }

  /** Markets plus their books, shaped for the prediction-market strategies. */
  async snapshot(limit = 30): Promise<{ ts: number; markets: PMMarketSnapshot[]; notes: string[] }> {
    const markets = await this.activeMarkets(limit);
    const tokens = markets.flatMap((m) => m.clobTokenIds ?? []);
    const books = await this.books(tokens);
    const notes: string[] = [];
    const out: PMMarketSnapshot[] = [];
    for (const m of markets) {
      const ids = m.clobTokenIds ?? [];
      const rate = m.feeSchedule?.rate;
      if (rate === undefined) notes.push(`${m.question}: no fee schedule published, taker fee assumed 0 — verify`);
      const outcomes: OutcomeBook[] = [];
      for (let i = 0; i < ids.length; i++) {
        const book = books.get(ids[i]!);
        if (!book) continue;
        outcomes.push({
          marketId: m.id,
          question: m.question,
          outcome: m.outcomes[i] ?? `#${i}`,
          tokenId: ids[i]!,
          book: { ...book, tickSize: book.tickSize ?? m.orderPriceMinTickSize ?? 0.01 },
          feeRate: rate !== undefined && Number.isFinite(rate) ? rate : 0,
          feeModel: rate ? 'polymarket_pq' : 'none',
          negRisk: m.negRisk ?? false,
          endDate: m.endDate ?? undefined,
        });
      }
      if (outcomes.length === ids.length && outcomes.length >= 2) out.push({ marketId: m.id, question: m.question, negRisk: m.negRisk ?? false, outcomes });
    }
    return { ts: Date.now(), markets: out, notes };
  }
}

/**
 * Every external endpoint the platform may call. Base URLs and payload
 * shapes follow the venues' official public documentation (links below).
 * The outbound allowlist is derived from this table.
 */
export interface DataSourceDef {
  id: string;
  name: string;
  kind: 'MARKET_DATA' | 'RESEARCH' | 'LLM';
  transport: 'REST' | 'WEBSOCKET';
  host: string;
  staleAfterMs: number;
  docs: string;
  /** Requests per second the client allows itself (well under published limits). */
  rate: { capacity: number; refillPerSecond: number };
  notes: string;
}

export const DATA_SOURCES: DataSourceDef[] = [
  {
    id: 'binance.spot.rest',
    name: 'Binance Spot (REST market data)',
    kind: 'MARKET_DATA',
    transport: 'REST',
    host: 'data-api.binance.vision',
    staleAfterMs: 120_000,
    docs: 'https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints',
    rate: { capacity: 20, refillPerSecond: 10 },
    notes: 'Market-data-only base URL. /api/v3/klines (max 1000 bars), /api/v3/depth. Request weight limit 6000/min per IP. Not available in every jurisdiction.',
  },
  {
    id: 'binance.spot.ws',
    name: 'Binance Spot (WebSocket streams)',
    kind: 'MARKET_DATA',
    transport: 'WEBSOCKET',
    host: 'data-stream.binance.vision',
    staleAfterMs: 30_000,
    docs: 'https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams',
    rate: { capacity: 5, refillPerSecond: 1 },
    notes: '<symbol>@bookTicker and <symbol>@kline_<interval> via the combined /stream endpoint.',
  },
  {
    id: 'binance.futures.rest',
    name: 'Binance USDⓈ-M Futures (funding history)',
    kind: 'MARKET_DATA',
    transport: 'REST',
    host: 'fapi.binance.com',
    staleAfterMs: 9 * 3_600_000,
    docs: 'https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History',
    rate: { capacity: 5, refillPerSecond: 1 },
    notes: '/fapi/v1/fundingRate (max 1000 rows, shared 500 req / 5 min / IP). Fields: symbol, fundingRate, fundingTime, markPrice.',
  },
  {
    id: 'coinbase.exchange.rest',
    name: 'Coinbase Exchange (public REST)',
    kind: 'MARKET_DATA',
    transport: 'REST',
    host: 'api.exchange.coinbase.com',
    staleAfterMs: 120_000,
    docs: 'https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductbook',
    rate: { capacity: 5, refillPerSecond: 3 },
    notes: '/products/{id}/book?level=2, /products/{id}/candles (max 300; rows [time, low, high, open, close, volume], newest first).',
  },
  {
    id: 'kraken.spot.rest',
    name: 'Kraken Spot (public REST)',
    kind: 'MARKET_DATA',
    transport: 'REST',
    host: 'api.kraken.com',
    staleAfterMs: 120_000,
    docs: 'https://docs.kraken.com/api/docs/rest-api/get-order-book',
    rate: { capacity: 3, refillPerSecond: 1 },
    notes: '/0/public/Depth, /0/public/OHLC (max 720 rows). Responses are {error: [], result: {...}}.',
  },
  {
    id: 'polymarket.gamma',
    name: 'Polymarket Gamma (market metadata)',
    kind: 'MARKET_DATA',
    transport: 'REST',
    host: 'gamma-api.polymarket.com',
    staleAfterMs: 15 * 60_000,
    docs: 'https://docs.polymarket.com/developers/gamma-markets-api/get-markets',
    rate: { capacity: 10, refillPerSecond: 5 },
    notes: 'outcomes and clobTokenIds are stringified JSON arrays. Read-only, no auth.',
  },
  {
    id: 'polymarket.clob',
    name: 'Polymarket CLOB (order books)',
    kind: 'MARKET_DATA',
    transport: 'REST',
    host: 'clob.polymarket.com',
    staleAfterMs: 120_000,
    docs: 'https://docs.polymarket.com/developers/CLOB/prices-books/get-books',
    rate: { capacity: 10, refillPerSecond: 5 },
    notes: 'POST /books with up to 500 token ids. Book levels are strings; bids arrive ascending and asks descending and are normalised.',
  },
  {
    id: 'github.search',
    name: 'GitHub Search API',
    kind: 'RESEARCH',
    transport: 'REST',
    host: 'api.github.com',
    staleAfterMs: 24 * 3_600_000,
    docs: 'https://docs.github.com/en/rest/search/search#search-repositories',
    // No burst and one request per 7 s: at most ~8.6 per minute, under the unauthenticated 10/min.
    rate: { capacity: 1, refillPerSecond: 1 / 7 },
    notes: 'Unauthenticated search: 10 requests/min per IP; with GITHUB_TOKEN: 30/min.',
  },
  {
    id: 'arxiv.api',
    name: 'arXiv API',
    kind: 'RESEARCH',
    transport: 'REST',
    host: 'export.arxiv.org',
    staleAfterMs: 24 * 3_600_000,
    docs: 'https://info.arxiv.org/help/api/user-manual.html',
    rate: { capacity: 1, refillPerSecond: 0.3 },
    notes: 'Atom XML. arXiv asks for no more than one request every 3 seconds.',
  },
  {
    id: 'hackernews.algolia',
    name: 'Hacker News (Algolia search API)',
    kind: 'RESEARCH',
    transport: 'REST',
    host: 'hn.algolia.com',
    staleAfterMs: 24 * 3_600_000,
    docs: 'https://hn.algolia.com/api',
    rate: { capacity: 2, refillPerSecond: 0.5 },
    notes: 'Public search of stories, used for "new idea / new launch" signals.',
  },
  {
    id: 'anthropic.messages',
    name: 'Anthropic Messages API (optional idea generator)',
    kind: 'LLM',
    transport: 'REST',
    host: 'api.anthropic.com',
    staleAfterMs: 7 * 24 * 3_600_000,
    docs: 'https://docs.claude.com/en/api/messages',
    rate: { capacity: 1, refillPerSecond: 0.2 },
    notes: 'Only used when ANTHROPIC_API_KEY is set and IDEA_GENERATOR_LLM_ENABLED=true.',
  },
];

export const ALLOWED_HOSTS: readonly string[] = DATA_SOURCES.map((d) => d.host);

export function sourceDef(id: string): DataSourceDef {
  const d = DATA_SOURCES.find((x) => x.id === id);
  if (!d) throw new RangeError(`unknown data source ${id}`);
  return d;
}

export function rateLimitsByHost(): Record<string, { capacity: number; refillPerSecond: number }> {
  const out: Record<string, { capacity: number; refillPerSecond: number }> = {};
  for (const d of DATA_SOURCES) out[d.host] ??= d.rate;
  return out;
}

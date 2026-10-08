import { DataUnavailableError, describeError, stableHash, type Bar, type FundingRatePoint, type Quote } from '@aoc/core';
import { DATA_SOURCES, deriveHealth } from '@aoc/connectors';
import { dataSnapshots, dataSources, datasetPoints, datasets, marketBars, type DbOrTx } from '@aoc/database';
import type { AnyStrategyModule, DataBundle, PredictionMarketSnapshot, QuoteSnapshot } from '@aoc/strategies';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { PlatformContext } from './context';

const HOUR = 3_600_000;

/** Reuse a stored historical dataset if it is this fresh. */
const DATASET_MAX_AGE_MS = 6 * HOUR;

async function storeBars(db: DbOrTx, source: string, symbol: string, interval: string, bars: Bar[]): Promise<string> {
  const checksum = stableHash(bars.map((b) => [b.ts, b.close]), 24);
  const [existing] = await db
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.source, source), eq(datasets.kind, 'BARS'), eq(datasets.symbol, symbol), eq(datasets.checksum, checksum)));
  if (existing) return existing.id;
  const [ds] = await db
    .insert(datasets)
    .values({ source, kind: 'BARS', symbol, interval, startTs: bars[0]!.ts, endTs: bars[bars.length - 1]!.ts, rowCount: bars.length, provenance: 'HISTORICAL', checksum, meta: { fetchedAt: new Date().toISOString() } })
    .returning({ id: datasets.id });
  for (let i = 0; i < bars.length; i += 1000) {
    await db.insert(marketBars).values(bars.slice(i, i + 1000).map((b) => ({ datasetId: ds!.id, ...b }))).onConflictDoNothing();
  }
  return ds!.id;
}

async function loadBars(db: DbOrTx, datasetId: string): Promise<Bar[]> {
  const rows = await db.select().from(marketBars).where(eq(marketBars.datasetId, datasetId)).orderBy(asc(marketBars.ts));
  return rows.map((r) => ({ ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

/** Historical bars: from the DB cache when fresh, otherwise fetched and stored. */
export async function historicalBars(ctx: PlatformContext, venue: string, symbol: string, interval: string, count: number): Promise<{ bars: Bar[]; datasetId: string }> {
  const source = venue === 'binance-futures' ? 'binance' : venue;
  const [recent] = await ctx.db
    .select()
    .from(datasets)
    .where(and(eq(datasets.source, source), eq(datasets.kind, 'BARS'), eq(datasets.symbol, symbol), eq(datasets.interval, interval), eq(datasets.provenance, 'HISTORICAL')))
    .orderBy(desc(datasets.createdAt))
    .limit(1);
  if (recent && recent.rowCount >= count && ctx.clock.now().getTime() - recent.createdAt.getTime() < DATASET_MAX_AGE_MS) {
    return { bars: await loadBars(ctx.db, recent.id), datasetId: recent.id };
  }
  const bars = await ctx.marketData.bars(source, symbol, interval, count);
  if (bars.length < Math.min(count, 200)) throw new DataUnavailableError(`${source} returned only ${bars.length} ${interval} bars for ${symbol}`);
  const datasetId = await storeBars(ctx.db, source, symbol, interval, bars);
  return { bars, datasetId };
}

export async function historicalFunding(ctx: PlatformContext, symbol: string, days: number): Promise<{ funding: FundingRatePoint[]; datasetId: string }> {
  const since = ctx.clock.now().getTime() - days * 86_400_000;
  const funding = await ctx.marketData.funding(symbol, since);
  if (funding.length < 30) throw new DataUnavailableError(`only ${funding.length} funding prints for ${symbol}`);
  const checksum = stableHash(funding.map((f) => [f.fundingTime, f.rate]), 24);
  const [existing] = await ctx.db.select({ id: datasets.id }).from(datasets).where(and(eq(datasets.source, 'binance-futures'), eq(datasets.kind, 'FUNDING'), eq(datasets.symbol, symbol), eq(datasets.checksum, checksum)));
  if (existing) return { funding, datasetId: existing.id };
  const [ds] = await ctx.db
    .insert(datasets)
    .values({ source: 'binance-futures', kind: 'FUNDING', symbol, interval: '8h', startTs: funding[0]!.fundingTime, endTs: funding[funding.length - 1]!.fundingTime, rowCount: funding.length, provenance: 'HISTORICAL', checksum })
    .returning({ id: datasets.id });
  for (let i = 0; i < funding.length; i += 1000) {
    await ctx.db
      .insert(datasetPoints)
      .values(funding.slice(i, i + 1000).map((f) => ({ datasetId: ds!.id, ts: f.fundingTime, payload: { rate: f.rate, markPrice: f.markPrice ?? null } })))
      .onConflictDoNothing();
  }
  return { funding, datasetId: ds!.id };
}

/** Quote snapshots recorded by earlier paper ticks: the only free source of cross-venue L1 history. */
export async function recordedQuotes(ctx: PlatformContext, symbol: string, minSnapshots: number): Promise<QuoteSnapshot[]> {
  const rows = await ctx.db
    .select()
    .from(dataSnapshots)
    .where(and(eq(dataSnapshots.sourceId, 'recorder.quotes'), eq(dataSnapshots.symbol, symbol)))
    .orderBy(asc(dataSnapshots.receivedAt))
    .limit(50_000);
  if (rows.length < minSnapshots) throw new DataUnavailableError(`only ${rows.length} recorded quote snapshots for ${symbol} (need ${minSnapshots}); paper mode records them`);
  return rows.map((r) => ({ ts: r.receivedAt.getTime(), quotes: (r.payload.quotes as Quote[]) ?? [] }));
}

export async function recordedPredictionMarkets(ctx: PlatformContext, minSnapshots: number): Promise<PredictionMarketSnapshot[]> {
  const rows = await ctx.db.select().from(dataSnapshots).where(eq(dataSnapshots.sourceId, 'recorder.pm')).orderBy(asc(dataSnapshots.receivedAt)).limit(20_000);
  if (rows.length < minSnapshots) throw new DataUnavailableError(`only ${rows.length} recorded prediction-market snapshots (need ${minSnapshots}); paper mode records them`);
  return rows.map((r) => r.payload as unknown as PredictionMarketSnapshot);
}

export interface AcquiredData {
  bundle: DataBundle;
  datasetIds: string[];
  notes: string[];
  realDataError: string | null;
}

/**
 * Data for a backtest: real historical data when it can be obtained, else
 * the module's DEMO generator — always labelled, never silently mixed.
 */
export async function acquireData(ctx: PlatformContext, m: AnyStrategyModule, params: Record<string, unknown>, seed: string): Promise<AcquiredData> {
  const reqs = m.dataRequirements(params);
  const bundle: DataBundle = { provenance: 'HISTORICAL', label: '', bars: {}, funding: {} };
  const datasetIds: string[] = [];
  const labels: string[] = [];
  try {
    for (const r of reqs) {
      if (r.kind === 'BARS') {
        const got = await historicalBars(ctx, r.venue, r.symbol, r.interval, Math.max(r.minBars, 2000));
        bundle.bars![r.symbol] = got.bars;
        datasetIds.push(got.datasetId);
        labels.push(`${r.symbol} ${r.interval} ×${got.bars.length}`);
      } else if (r.kind === 'FUNDING') {
        const got = await historicalFunding(ctx, r.symbol, 365);
        bundle.funding![r.symbol] = got.funding;
        datasetIds.push(got.datasetId);
        labels.push(`${r.symbol} funding ×${got.funding.length}`);
      } else if (r.kind === 'QUOTES') {
        bundle.quoteSeries = await recordedQuotes(ctx, r.symbol, 500);
        labels.push(`recorded quotes ×${bundle.quoteSeries.length}`);
      } else if (r.kind === 'PM_MARKETS') {
        bundle.pmSeries = await recordedPredictionMarkets(ctx, 200);
        labels.push(`recorded PM snapshots ×${bundle.pmSeries.length}`);
      }
    }
    bundle.label = `Historical data: ${labels.join(', ')}`;
    return { bundle, datasetIds, notes: [], realDataError: null };
  } catch (e) {
    const reason = describeError(e).message;
    if (!m.syntheticData) throw e;
    const demo = m.syntheticData(params, seed);
    return { bundle: demo, datasetIds: [], notes: [`Real data unavailable (${reason}); using ${demo.label}. DEMO results test the machinery only.`], realDataError: reason };
  }
}

/** Store live snapshots that later become backtest data for quote/PM strategies. */
export async function recordLiveData(ctx: PlatformContext, bundle: DataBundle): Promise<void> {
  const now = ctx.clock.now();
  for (const q of bundle.quoteSeries ?? []) {
    if (q.quotes.length < 2) continue;
    const symbol = q.quotes[0]!.symbol;
    await ctx.db.insert(dataSnapshots).values({ sourceId: 'recorder.quotes', kind: 'QUOTE', symbol, ts: new Date(q.ts), receivedAt: now, payload: { quotes: q.quotes } });
  }
  for (const s of bundle.pmSeries ?? []) {
    const compact: PredictionMarketSnapshot = {
      ts: s.ts,
      markets: s.markets.map((m) => ({
        ...m,
        outcomes: m.outcomes.map((o) => ({ ...o, book: { ...o.book, bids: o.book.bids.slice(0, 5), asks: o.book.asks.slice(0, 5) } })),
      })),
    };
    await ctx.db.insert(dataSnapshots).values({ sourceId: 'recorder.pm', kind: 'MARKETS', symbol: 'polymarket', ts: new Date(s.ts), receivedAt: now, payload: compact as unknown as Record<string, unknown> });
  }
}

/** Persist the in-memory health of every source into data_sources. */
export async function syncDataSources(ctx: PlatformContext): Promise<void> {
  const now = ctx.clock.now().getTime();
  for (const def of DATA_SOURCES) {
    const s = ctx.marketData.health.state(def.id);
    const websocket = def.transport === 'WEBSOCKET';
    const enabled =
      def.kind === 'MARKET_DATA'
        ? ctx.config.MARKET_DATA_ENABLED && (!websocket || ctx.config.MARKET_DATA_WEBSOCKETS)
        : def.kind === 'RESEARCH'
          ? ctx.config.RESEARCH_MONITOR_ENABLED
          : ctx.config.IDEA_GENERATOR_LLM_ENABLED && !!ctx.config.ANTHROPIC_API_KEY;
    // Only the process running the stream observes it; another process (e.g. the CLI) must not overwrite its row.
    if (websocket && enabled && !ctx.marketData.streaming) continue;
    const disabledReason = enabled ? null : websocket && ctx.config.MARKET_DATA_ENABLED ? 'disabled by configuration (MARKET_DATA_WEBSOCKETS=false)' : 'disabled by configuration';
    const [stored] = await ctx.db.select().from(dataSources).where(eq(dataSources.id, def.id));
    // Merge with what other processes recorded (the API and the worker each track health).
    const lastSuccess = Math.max(s.lastSuccessAt ?? 0, stored?.lastSuccessAt?.getTime() ?? 0) || null;
    const lastError = Math.max(s.lastErrorAt ?? 0, stored?.lastErrorAt?.getTime() ?? 0) || null;
    const merged = { ...s, lastSuccessAt: lastSuccess, lastErrorAt: lastError, consecutiveFailures: s.lastSuccessAt === null && s.lastErrorAt === null ? (stored?.consecutiveFailures ?? 0) : s.consecutiveFailures };
    const status = enabled ? deriveHealth(merged, now) : 'OFFLINE';
    const values = {
      id: def.id,
      name: def.name,
      kind: def.kind,
      transport: def.transport,
      status,
      enabled,
      lastSuccessAt: lastSuccess ? new Date(lastSuccess) : null,
      lastErrorAt: lastError ? new Date(lastError) : null,
      lastError: s.lastError ?? stored?.lastError ?? null,
      consecutiveFailures: merged.consecutiveFailures,
      latencyMs: s.latencyMs ?? stored?.latencyMs ?? null,
      staleAfterMs: def.staleAfterMs,
      successCount: (stored?.successCount ?? 0) + s.successCount,
      errorCount: (stored?.errorCount ?? 0) + s.errorCount,
      meta: { docs: def.docs, notes: def.notes, host: def.host, disabledReason },
      updatedAt: new Date(now),
    };
    await ctx.db.insert(dataSources).values(values).onConflictDoUpdate({ target: dataSources.id, set: values });
  }
  // Counters are cumulative in the table; reset the in-memory deltas that were just added.
  ctx.marketData.health.resetCounters();
}

export async function pruneSnapshots(ctx: PlatformContext, olderThanDays: number): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - olderThanDays * 86_400_000);
  const rows = await ctx.db.delete(dataSnapshots).where(lt(dataSnapshots.receivedAt, cutoff)).returning({ id: dataSnapshots.id });
  return rows.length;
}

export async function snapshotCounts(db: DbOrTx): Promise<Record<string, number>> {
  const rows = await db.select({ source: dataSnapshots.sourceId, n: sql<number>`count(*)::int` }).from(dataSnapshots).where(gte(dataSnapshots.receivedAt, new Date(0))).groupBy(dataSnapshots.sourceId);
  return Object.fromEntries(rows.map((r) => [r.source, r.n]));
}

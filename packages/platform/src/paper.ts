import { ConflictError, ValidationError, d, dsum, toDb, utcDayKey, type ExperimentStatus, type Provenance, type RiskLimits } from '@aoc/core';
import {
  experiments,
  paperAccounts,
  paperFills,
  paperOrders,
  paperPositions,
  paperTransactions,
  performanceSnapshots,
  type DbOrTx,
} from '@aoc/database';
import { PAPER_TRADING_STATUSES } from '@aoc/experiments';
import { PaperAccount, type EngineChanges, type Instrument, type OrderState, type PaperAccountState, type PositionState } from '@aoc/paper-engine';
import { createPreTradeHook, decideAllocation } from '@aoc/risk';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { audit, type Actor } from './audit';
import type { PlatformContext } from './context';
import { getEmergencyStop } from './settings';

export type AccountRow = typeof paperAccounts.$inferSelect;

/**
 * Capital already promised to active accounts of one pool: PAPER (the
 * trading paper fund) or SIMULATED (the business simulation budget). The two
 * pools are never mixed.
 */
export async function allocatedCapital(db: DbOrTx, provenance: 'PAPER' | 'SIMULATED'): Promise<string> {
  const rows = await db.select({ c: paperAccounts.startingCapital }).from(paperAccounts).where(and(eq(paperAccounts.status, 'ACTIVE'), eq(paperAccounts.provenance, provenance)));
  return dsum(rows.map((r) => r.c)).toString();
}

export function poolSize(ctx: PlatformContext, provenance: 'PAPER' | 'SIMULATED'): number {
  return provenance === 'PAPER' ? ctx.config.PAPER_TOTAL_CAPITAL_USD : ctx.config.BUSINESS_SIM_BUDGET_USD;
}

export interface OpenAccountInput {
  experimentId: string;
  versionId: string | null;
  name: string;
  capital: number;
  maxCapital: number;
  provenance: Extract<Provenance, 'PAPER' | 'SIMULATED'>;
  isDemo: boolean;
}

/**
 * Open a paper account funded from the paper fund. Refuses when the fund or
 * the experiment's max-capital limit would be exceeded.
 */
export async function openPaperAccount(ctx: PlatformContext, tx: DbOrTx, input: OpenAccountInput, actor: Actor): Promise<AccountRow> {
  const decision = decideAllocation({
    totalPaperCapital: poolSize(ctx, input.provenance),
    allocated: await allocatedCapital(tx, input.provenance),
    requested: input.capital,
    experimentMaxCapital: input.maxCapital,
  });
  if (!decision.approved) throw new ValidationError(`paper allocation refused: ${decision.reasons.join('; ')}`, { reasons: decision.reasons });
  const now = ctx.clock.now();
  const [row] = await tx
    .insert(paperAccounts)
    .values({
      experimentId: input.experimentId,
      versionId: input.versionId,
      name: input.name,
      startingCapital: '0',
      cash: '0',
      peakEquity: '0',
      dayKey: utcDayKey(now),
      dayStartEquity: '0',
      provenance: input.provenance,
      isDemo: input.isDemo,
    })
    .returning();
  if (!row) throw new ConflictError('could not create paper account');
  // The opening allocation is an ordinary DEPOSIT in the ledger.
  const engine = PaperAccount.restore(emptyState(row.id, utcDayKey(now)));
  const opened = engine.deposit(input.capital, now, 'Initial paper capital allocation');
  await persistChanges(tx, row, engine, [opened], now);
  await audit(tx, actor, 'PAPER_ACCOUNT_CREATED', { type: 'paper_account', id: row.id, experimentId: input.experimentId }, { capital: input.capital, provenance: input.provenance, remainingFund: decision.remainingAfter.toString() });
  const [fresh] = await tx.select().from(paperAccounts).where(eq(paperAccounts.id, row.id));
  return fresh!;
}

function emptyState(id: string, dayKey: string): PaperAccountState {
  return {
    id,
    startingCapital: '0',
    cash: '0',
    realizedPnl: '0',
    feesPaid: '0',
    slippageCost: '0',
    fundingPnl: '0',
    operatingPnl: '0',
    peakEquity: '0',
    dayKey,
    dayStartEquity: '0',
    ordersToday: 0,
    spendTotal: '0',
    apiSpendTotal: '0',
    ledgerSeq: 0,
    status: 'ACTIVE',
    positions: [],
    openOrders: [],
  };
}

function numOrNull(v: string | null): ReturnType<typeof d> | null {
  return v === null ? null : d(v);
}

/** Rebuild the engine state of an account from its rows. */
export async function loadEngineState(tx: DbOrTx, account: AccountRow): Promise<PaperAccountState> {
  const positions = await tx.select().from(paperPositions).where(eq(paperPositions.accountId, account.id));
  const open = await tx
    .select()
    .from(paperOrders)
    .where(and(eq(paperOrders.accountId, account.id), inArray(paperOrders.status, ['OPEN', 'PARTIALLY_FILLED'])));
  return {
    id: account.id,
    startingCapital: account.startingCapital,
    cash: account.cash,
    realizedPnl: account.realizedPnl,
    feesPaid: account.feesPaid,
    slippageCost: account.slippageCost,
    fundingPnl: account.fundingPnl,
    operatingPnl: account.operatingPnl,
    peakEquity: account.peakEquity,
    dayKey: account.dayKey,
    dayStartEquity: account.dayStartEquity,
    ordersToday: account.ordersToday,
    spendTotal: account.spendTotal,
    apiSpendTotal: account.apiSpendTotal,
    ledgerSeq: account.ledgerSeq,
    status: account.status as PaperAccountState['status'],
    positions: positions.map(
      (p): PositionState => ({
        venue: p.venue,
        symbol: p.symbol,
        kind: p.instrumentKind as PositionState['kind'],
        quantity: d(p.quantity),
        avgPrice: d(p.avgPrice),
        realizedPnl: d(p.realizedPnl),
        markPrice: numOrNull(p.markPrice),
        openedAt: p.openedAt,
        updatedAt: p.updatedAt,
      }),
    ),
    openOrders: open.map(
      (o): OrderState => ({
        id: o.id,
        clientOrderId: o.clientOrderId,
        instrument: o.instrument as unknown as Instrument,
        side: o.side as OrderState['side'],
        type: o.type as OrderState['type'],
        quantity: d(o.quantity),
        limitPrice: numOrNull(o.limitPrice),
        status: o.status as OrderState['status'],
        filledQuantity: d(o.filledQuantity),
        avgFillPrice: numOrNull(o.avgFillPrice),
        reserved: d(o.reserved),
        rejectReason: o.rejectReason,
        reduceOnly: o.reduceOnly,
        postOnly: o.postOnly,
        reason: o.reason,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      }),
    ),
  };
}

/**
 * Write everything an engine operation changed, atomically, with optimistic
 * locking on the account row: if another writer touched the account since it
 * was loaded, nothing is written and a ConflictError is raised.
 */
export async function persistChanges(tx: DbOrTx, account: AccountRow, engine: PaperAccount, batches: EngineChanges[], now: Date, extra: { strategyState?: Record<string, unknown>; simulatedDays?: number } = {}): Promise<void> {
  for (const c of batches) {
    for (const o of c.orders) {
      const values = {
        id: o.id,
        accountId: account.id,
        clientOrderId: o.clientOrderId,
        venue: o.instrument.venue,
        symbol: o.instrument.symbol,
        instrumentKind: o.instrument.kind,
        instrument: o.instrument as unknown as Record<string, unknown>,
        side: o.side,
        type: o.type,
        quantity: toDb(o.quantity),
        limitPrice: o.limitPrice ? toDb(o.limitPrice) : null,
        status: o.status,
        filledQuantity: toDb(o.filledQuantity),
        avgFillPrice: o.avgFillPrice ? toDb(o.avgFillPrice) : null,
        reserved: toDb(o.reserved),
        rejectReason: o.rejectReason,
        reduceOnly: o.reduceOnly,
        postOnly: o.postOnly,
        reason: o.reason?.slice(0, 500) ?? null,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      };
      await tx
        .insert(paperOrders)
        .values(values)
        .onConflictDoUpdate({
          target: paperOrders.id,
          set: { status: values.status, filledQuantity: values.filledQuantity, avgFillPrice: values.avgFillPrice, reserved: values.reserved, rejectReason: values.rejectReason, updatedAt: values.updatedAt },
        });
    }
    for (const f of c.fills) {
      await tx.insert(paperFills).values({
        id: f.id,
        orderId: f.orderId,
        accountId: account.id,
        venue: f.venue,
        symbol: f.symbol,
        side: f.side,
        quantity: toDb(f.quantity),
        price: toDb(f.price),
        fee: toDb(f.fee),
        slippageCost: toDb(f.slippageCost),
        liquidity: f.liquidity,
        realizedPnl: toDb(f.realizedPnl),
        ts: f.ts,
      });
    }
    for (const t of c.transactions) {
      await tx.insert(paperTransactions).values({
        id: t.id,
        accountId: account.id,
        seq: t.seq,
        type: t.type,
        amount: toDb(t.amount),
        balanceAfter: toDb(t.balanceAfter),
        category: t.category,
        description: t.description.slice(0, 500),
        refOrderId: t.refOrderId,
        refFillId: t.refFillId,
        ts: t.ts,
      });
    }
    for (const p of c.closedPositions) {
      await tx.delete(paperPositions).where(and(eq(paperPositions.accountId, account.id), eq(paperPositions.venue, p.venue), eq(paperPositions.symbol, p.symbol)));
    }
    for (const p of c.positions) {
      if (p.quantity.isZero()) continue;
      const v = {
        accountId: account.id,
        venue: p.venue,
        symbol: p.symbol,
        instrumentKind: p.kind,
        quantity: toDb(p.quantity),
        avgPrice: toDb(p.avgPrice),
        realizedPnl: toDb(p.realizedPnl),
        markPrice: p.markPrice ? toDb(p.markPrice) : null,
        openedAt: p.openedAt,
        updatedAt: p.updatedAt,
      };
      await tx
        .insert(paperPositions)
        .values(v)
        .onConflictDoUpdate({ target: [paperPositions.accountId, paperPositions.venue, paperPositions.symbol], set: { quantity: v.quantity, avgPrice: v.avgPrice, realizedPnl: v.realizedPnl, markPrice: v.markPrice, openedAt: v.openedAt, updatedAt: v.updatedAt } });
    }
  }
  const st = engine.exportState();
  const updated = await tx
    .update(paperAccounts)
    .set({
      startingCapital: toDb(st.startingCapital),
      cash: toDb(st.cash),
      realizedPnl: toDb(st.realizedPnl),
      feesPaid: toDb(st.feesPaid),
      slippageCost: toDb(st.slippageCost),
      fundingPnl: toDb(st.fundingPnl),
      operatingPnl: toDb(st.operatingPnl),
      peakEquity: toDb(st.peakEquity),
      dayKey: st.dayKey,
      dayStartEquity: toDb(st.dayStartEquity),
      ordersToday: st.ordersToday,
      spendTotal: toDb(st.spendTotal),
      apiSpendTotal: toDb(st.apiSpendTotal),
      ledgerSeq: st.ledgerSeq,
      status: st.status,
      lockVersion: account.lockVersion + 1,
      updatedAt: now,
      lastTickAt: now,
      ...(extra.strategyState ? { strategyState: extra.strategyState } : {}),
      ...(extra.simulatedDays !== undefined ? { simulatedDays: extra.simulatedDays } : {}),
    })
    .where(and(eq(paperAccounts.id, account.id), eq(paperAccounts.lockVersion, account.lockVersion)))
    .returning({ id: paperAccounts.id });
  if (updated.length !== 1) throw new ConflictError(`paper account ${account.id} was modified concurrently; changes rolled back`);
}

export async function recordPerformance(tx: DbOrTx, account: AccountRow, engine: PaperAccount, ts: Date): Promise<void> {
  const s = engine.snapshot();
  await tx.insert(performanceSnapshots).values({
    accountId: account.id,
    experimentId: account.experimentId,
    ts,
    equity: toDb(s.equity),
    cash: toDb(s.cash),
    realizedPnl: toDb(s.realizedPnl),
    unrealizedPnl: toDb(s.unrealizedPnl),
    fees: toDb(s.feesPaid),
    exposure: toDb(s.exposure),
    drawdownPct: s.drawdownPct,
    provenance: account.provenance,
  });
}

/**
 * Lock the account row, rebuild the engine with the central risk hook
 * installed, run `fn`, and persist what it changed — all in one transaction.
 */
export async function withAccount<T>(
  ctx: PlatformContext,
  accountId: string,
  fn: (engine: PaperAccount, account: AccountRow, tx: DbOrTx) => Promise<{ changes: EngineChanges[]; result: T; strategyState?: Record<string, unknown>; simulatedDays?: number; snapshot?: boolean }>,
  opts: { purpose?: 'STRATEGY' | 'MANUAL_FLATTEN'; riskLimits?: RiskLimits } = {},
): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    const [account] = await tx.select().from(paperAccounts).where(eq(paperAccounts.id, accountId)).for('update');
    if (!account) throw new ValidationError(`paper account ${accountId} not found`);
    const [exp] = await tx.select({ status: experiments.status, riskLimits: experiments.riskLimits }).from(experiments).where(eq(experiments.id, account.experimentId));
    const stop = await getEmergencyStop(tx);
    const limits = (opts.riskLimits ?? exp?.riskLimits) as unknown as RiskLimits;
    const status = (exp?.status ?? 'PAUSED') as ExperimentStatus;
    const hook = createPreTradeHook(() => ({
      limits,
      emergencyStop: stop.engaged,
      // The lifecycle check accepts every paper-trading status (PAPER, PROMISING, PROBATION, READY_FOR_LIVE_REVIEW).
      experimentStatus: PAPER_TRADING_STATUSES.includes(status) ? 'PAPER' : status,
      purpose: opts.purpose ?? 'STRATEGY',
    }));
    const engine = PaperAccount.restore(await loadEngineState(tx, account), { preTradeHooks: [hook] });
    const now = ctx.clock.now();
    const out = await fn(engine, account, tx);
    await persistChanges(tx, account, engine, out.changes, now, { strategyState: out.strategyState, simulatedDays: out.simulatedDays });
    if (out.snapshot !== false) await recordPerformance(tx, account, engine, now);
    return out.result;
  });
}

/** Total equity etc. across active accounts, split by provenance. */
export async function fundSummary(db: DbOrTx): Promise<Array<{ provenance: string; isDemo: boolean; accounts: number; capital: string; cash: string }>> {
  const rows = await db
    .select({
      provenance: paperAccounts.provenance,
      isDemo: paperAccounts.isDemo,
      accounts: sql<number>`count(*)::int`,
      capital: sql<string>`coalesce(sum(${paperAccounts.startingCapital}), 0)::text`,
      cash: sql<string>`coalesce(sum(${paperAccounts.cash}), 0)::text`,
    })
    .from(paperAccounts)
    .where(eq(paperAccounts.status, 'ACTIVE'))
    .groupBy(paperAccounts.provenance, paperAccounts.isDemo);
  return rows;
}

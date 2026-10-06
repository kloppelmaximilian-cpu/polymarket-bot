import { describeError, type ExperimentStatus, type RiskLimits } from '@aoc/core';
import { experiments, paperAccounts, riskEvents, type DbOrTx } from '@aoc/database';
import { PAPER_TRADING_STATUSES } from '@aoc/experiments';
import { PaperAccount, merge, type AccountSnapshot, type EngineChanges } from '@aoc/paper-engine';
import { breaches, evaluateLimits, mustStop, type LimitStatus } from '@aoc/risk';
import type { Assumption } from '@aoc/core';
import type { DataBundle, DecisionLog } from '@aoc/strategies';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import { WORKER, audit, recordError, recordEvent, type Actor } from './audit';
import type { PlatformContext } from './context';
import { recordLiveData } from './data';
import { currentVersion, getExperiment, transition, type ExperimentRow } from './experiments';
import { notify } from './notifications';
import { loadEngineState, withAccount, type AccountRow } from './paper';

const NOTABLE = new Set(['ORDER', 'ORDER_REJECTED', 'ARB', 'ARB_MISSED', 'LEG_RISK', 'ENTER', 'EXIT', 'ENTRY_FAILED', 'SETTLED', 'NO_DATA', 'NO_QUOTE', 'REBALANCE', 'SETUP', 'MM_STOP', 'EXIT_BLOCKED']);

export interface TickResult {
  experimentId: string;
  ok: boolean;
  note: string;
  equity?: number;
}

/**
 * One paper tick for one experiment:
 *  1. fetch live data (outside any transaction; network can be slow)
 *  2. lock the account, run the module's paper step through the paper engine
 *     with the central risk hook, persist atomically
 *  3. evaluate risk limits and stop the experiment on a breach
 */
export async function paperTick(ctx: PlatformContext, exp: ExperimentRow, account: AccountRow): Promise<TickResult> {
  const m = ctx.registry.get(exp.strategyId);
  if (!m.paperStep) return { experimentId: exp.id, ok: false, note: 'module has no paper mode' };
  const version = await currentVersion(ctx.db, exp);
  const isBusiness = m.meta.kind === 'BUSINESS';
  let live: DataBundle = { provenance: 'PAPER', label: 'simulated operation' };
  let problems: string[] = [];
  if (!isBusiness) {
    const res = await ctx.marketData.liveBundle(m.dataRequirements(version.params));
    live = res.bundle;
    problems = res.problems;
    try {
      await recordLiveData(ctx, live);
    } catch (e) {
      await recordError(ctx.db, 'recorder', e, {}, exp.id);
    }
    if (problems.length > 0) await recordEvent(ctx.db, 'WARN', 'market-data', 'LIVE_DATA_PROBLEM', problems.slice(0, 3).join(' | '), { problems: problems.slice(0, 10) }, exp.id);
  }
  const decisions: DecisionLog[] = [];
  const outcome = await withAccount(ctx, account.id, async (engine, acc) => {
    const state = (acc.strategyState ?? {}) as { module?: Record<string, unknown>; meta?: { ticks?: number; dataTicks?: number; lastProblems?: string[] } };
    const meta = { ticks: (state.meta?.ticks ?? 0) + 1, dataTicks: (state.meta?.dataTicks ?? 0) + (problems.length === 0 ? 1 : 0), lastProblems: problems.slice(0, 5) };
    const out = m.paperStep!({
      params: version.params,
      account: engine,
      now: ctx.clock.now(),
      live,
      state: state.module ?? {},
      seed: `${exp.seed}/${version.label}/paper`,
      assumptions: version.assumptions as Assumption[],
      daysToSimulate: isBusiness ? ctx.config.BUSINESS_PAPER_DAYS_PER_TICK : undefined,
    });
    decisions.push(...out.decisions);
    return {
      changes: out.changes,
      result: { snapshot: engine.snapshot(), changes: out.changes },
      strategyState: { module: out.state, meta },
      simulatedDays: acc.simulatedDays + (out.simulatedDays ?? 0),
    };
  });

  // Audit trail for order activity (bounded per tick) and notable decisions.
  const all: EngineChanges = { orders: [], fills: [], transactions: [], positions: [], closedPositions: [] };
  for (const c of outcome.changes) merge(all, c);
  for (const o of all.orders.slice(0, 50)) {
    const action = o.status === 'REJECTED' ? 'PAPER_ORDER_REJECTED' : o.status === 'FILLED' || o.filledQuantity.gt(0) ? 'PAPER_ORDER_FILLED' : o.status === 'CANCELLED' ? 'PAPER_ORDER_CANCELLED' : 'PAPER_ORDER_CREATED';
    await audit(ctx.db, WORKER, action, { type: 'paper_order', id: o.id, experimentId: exp.id }, { symbol: o.instrument.symbol, side: o.side, qty: o.quantity.toString(), status: o.status, avgPrice: o.avgFillPrice?.toString() ?? null, reason: o.rejectReason ?? o.reason });
  }
  for (const dl of decisions.filter((x) => NOTABLE.has(x.action)).slice(0, 20)) {
    await recordEvent(ctx.db, dl.action.includes('REJECT') || dl.action === 'LEG_RISK' ? 'WARN' : 'INFO', 'paper', dl.action, dl.detail, dl.data ?? {}, exp.id);
  }
  await ctx.db.update(experiments).set({ lastActivityAt: ctx.clock.now() }).where(eq(experiments.id, exp.id));
  await enforceLimits(ctx, exp, account.id, outcome.snapshot);
  return { experimentId: exp.id, ok: problems.length === 0, note: problems.length ? problems.slice(0, 2).join(' | ') : `${decisions.length} decisions`, equity: outcome.snapshot.equity.toNumber() };
}

/**
 * Compare the account with its limits. A breach records a risk event (once
 * per limit per day), notifies, and stops the experiment (PAUSED) with all
 * open orders cancelled. Positions stay open and marked; a human decides.
 */
export async function enforceLimits(ctx: PlatformContext, exp: ExperimentRow, accountId: string, snap: AccountSnapshot, actor: Actor = WORKER): Promise<LimitStatus[]> {
  const limits = exp.riskLimits as unknown as RiskLimits;
  const statuses = evaluateLimits(limits, snap);
  const hits = breaches(statuses);
  if (hits.length === 0) return statuses;
  const dayStart = new Date(Date.UTC(ctx.clock.now().getUTCFullYear(), ctx.clock.now().getUTCMonth(), ctx.clock.now().getUTCDate()));
  for (const b of hits) {
    const [seen] = await ctx.db
      .select({ id: riskEvents.id })
      .from(riskEvents)
      .where(and(eq(riskEvents.experimentId, exp.id), eq(riskEvents.limitName, b.limit), gte(riskEvents.createdAt, dayStart), isNull(riskEvents.resolvedAt)));
    if (seen) continue;
    await ctx.db.insert(riskEvents).values({ experimentId: exp.id, accountId, limitName: b.limit, severity: b.severity, message: b.message, value: Number.isFinite(b.value) ? b.value : null, threshold: b.threshold, action: b.action });
    await audit(ctx.db, actor, 'RISK_LIMIT_TRIGGERED', { type: 'experiment', id: exp.id, experimentId: exp.id }, { limit: b.limit, value: b.value, threshold: b.threshold, action: b.action });
    await notify(ctx, { type: 'RISK_LIMIT_REACHED', severity: 'CRITICAL', title: `${exp.name}: ${b.label} limit reached`, body: b.message, experimentId: exp.id });
  }
  if (mustStop(statuses)) {
    const fresh = await getExperiment(ctx.db, exp.id);
    if (PAPER_TRADING_STATUSES.includes(fresh.status as ExperimentStatus)) {
      await ctx.db.transaction((tx) => transition(ctx, tx, fresh, 'PAUSED', { actor, reason: `risk limit: ${hits.map((h) => h.message).join('; ')}` }));
      await cancelOpenOrders(ctx, accountId, 'experiment stopped by risk limit');
    }
  }
  return statuses;
}

export async function cancelOpenOrders(ctx: PlatformContext, accountId: string, reason: string): Promise<number> {
  return withAccount(ctx, accountId, async (engine) => {
    const changes = engine.cancelAll(ctx.clock.now(), reason);
    return { changes: [changes], result: changes.orders.length, snapshot: false };
  });
}

/** Paper tick for every experiment that is paper testing. Failures are isolated per experiment. */
export async function paperTickAll(ctx: PlatformContext, keepAlive?: () => Promise<void>): Promise<TickResult[]> {
  const rows = await ctx.db
    .select({ exp: experiments, account: paperAccounts })
    .from(experiments)
    .innerJoin(paperAccounts, and(eq(paperAccounts.experimentId, experiments.id), eq(paperAccounts.status, 'ACTIVE')))
    .where(inArray(experiments.status, [...PAPER_TRADING_STATUSES]));
  const out: TickResult[] = [];
  for (const r of rows) {
    try {
      out.push(await paperTick(ctx, r.exp, r.account));
    } catch (e) {
      await recordError(ctx.db, 'paper', e, { accountId: r.account.id }, r.exp.id);
      out.push({ experimentId: r.exp.id, ok: false, note: describeError(e).message });
    }
    await keepAlive?.();
  }
  return out;
}

/** Re-check limits for every active account from its stored state (no new prices). */
export async function riskMonitorAll(ctx: PlatformContext): Promise<{ checked: number; breaches: number }> {
  const rows = await ctx.db
    .select({ exp: experiments, account: paperAccounts })
    .from(experiments)
    .innerJoin(paperAccounts, and(eq(paperAccounts.experimentId, experiments.id), eq(paperAccounts.status, 'ACTIVE')))
    .where(inArray(experiments.status, [...PAPER_TRADING_STATUSES]));
  let n = 0;
  for (const r of rows) {
    const snap = await snapshotOf(ctx.db, r.account);
    n += breaches(await enforceLimits(ctx, r.exp, r.account.id, snap)).length;
  }
  return { checked: rows.length, breaches: n };
}

export async function snapshotOf(db: DbOrTx, account: AccountRow): Promise<AccountSnapshot> {
  return PaperAccount.restore(await loadEngineState(db, account)).snapshot();
}

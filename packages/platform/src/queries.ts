import { NotFoundError, redactConfig, type ComplianceEntry, type RiskLimits } from '@aoc/core';
import {
  auditLogs,
  dataSources,
  experimentSources,
  experimentVersions,
  experiments,
  ideas,
  jobRuns,
  metrics,
  notifications,
  paperAccounts,
  paperFills,
  paperOrders,
  paperPositions,
  paperTransactions,
  performanceSnapshots,
  researchSources,
  riskEvents,
  rowsOf,
  scores,
  strategies,
  strategyRuns,
  systemEvents,
  workerHeartbeats,
  type DbOrTx,
} from '@aoc/database';
import { DEFAULT_THRESHOLDS, PAPER_TRADING_STATUSES } from '@aoc/experiments';
import { COMPONENT_LABELS, DEFAULT_WEIGHTS } from '@aoc/scoring';
import { evaluateLimits, overallRiskStatus, RISK_LIMIT_LABELS } from '@aoc/risk';
import { and, asc, desc, eq, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PlatformContext } from './context';
import { paperStats } from './evidence';
import { snapshotOf } from './paper-runner';
import { latestScores } from './scoring';
import { getEmergencyStop, getSetting, SETTING_KEYS } from './settings';

type ExperimentRow = typeof experiments.$inferSelect;
type AccountRow = typeof paperAccounts.$inferSelect;

export interface ExperimentListFilters {
  category?: string[];
  status?: string[];
  kind?: string;
  riskLevel?: string[];
  minScore?: number;
  maxScore?: number;
  minProfit?: number;
  maxCapital?: number;
  minAutomation?: number;
  minScalability?: number;
  since?: Date;
  search?: string;
  sort?: 'rank' | 'score' | 'pnl' | 'created' | 'name' | 'activity';
  dir?: 'asc' | 'desc';
  limit?: number;
  includeArchived?: boolean;
}

async function latestEquity(db: DbOrTx, accountIds: string[]): Promise<Map<string, { equity: number; ts: Date }>> {
  const out = new Map<string, { equity: number; ts: Date }>();
  if (accountIds.length === 0) return out;
  const res = await db.execute(
    sql`SELECT DISTINCT ON (account_id) account_id, equity, ts FROM performance_snapshots WHERE account_id IN (${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY account_id, ts DESC`,
  );
  for (const r of rowsOf<{ account_id: string; equity: string; ts: string }>(res)) out.set(String(r.account_id), { equity: Number(r.equity), ts: new Date(r.ts) });
  return out;
}

/** Most relevant paper account per experiment: the ACTIVE one, else the newest. */
async function accountsByExperiment(db: DbOrTx, experimentIds: string[]): Promise<Map<string, AccountRow>> {
  const out = new Map<string, AccountRow>();
  if (experimentIds.length === 0) return out;
  const rows = await db.select().from(paperAccounts).where(inArray(paperAccounts.experimentId, experimentIds)).orderBy(desc(paperAccounts.createdAt));
  for (const r of rows) {
    const cur = out.get(r.experimentId);
    if (!cur || (cur.status !== 'ACTIVE' && r.status === 'ACTIVE')) out.set(r.experimentId, r);
  }
  return out;
}

async function latestEvidence(db: DbOrTx, experimentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (experimentIds.length === 0) return out;
  const res = await db.execute(
    sql`SELECT DISTINCT ON (experiment_id) experiment_id, provenance FROM strategy_runs WHERE run_type IN ('BACKTEST','SIMULATION') AND status = 'SUCCEEDED' AND experiment_id IN (${sql.join(experimentIds.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY experiment_id, created_at DESC`,
  );
  for (const r of rowsOf<{ experiment_id: string; provenance: string }>(res)) out.set(String(r.experiment_id), r.provenance);
  return out;
}

export interface ExperimentListItem {
  id: string;
  slug: string;
  name: string;
  strategyId: string;
  category: string;
  kind: string;
  status: string;
  statusReason: string | null;
  failureReasons: string[];
  riskLevel: string;
  automationScore: number;
  scalabilityScore: number;
  complexityScore: number;
  capitalRequirement: number;
  expectedTimeToRevenueDays: number | null;
  isDemo: boolean;
  createdAt: string;
  lastActivityAt: string | null;
  evidence: string | null;
  score: { overall: number; components: Record<string, number | null>; confidence: string; evidence: string; rank: number | null; computedAt: string } | null;
  paper: { accountId: string; provenance: string; status: string; startingCapital: number; equity: number; pnl: number; pnlPct: number | null; isDemo: boolean } | null;
}

export async function listExperiments(ctx: PlatformContext, f: ExperimentListFilters = {}): Promise<ExperimentListItem[]> {
  const where: SQL[] = [];
  if (!f.includeArchived && !(f.status ?? []).includes('ARCHIVED')) where.push(sql`${experiments.status} <> 'ARCHIVED'`);
  if (f.category?.length) where.push(inArray(experiments.category, f.category));
  if (f.status?.length) where.push(inArray(experiments.status, f.status));
  if (f.kind) where.push(eq(experiments.kind, f.kind));
  if (f.riskLevel?.length) where.push(inArray(experiments.riskLevel, f.riskLevel));
  if (f.minAutomation !== undefined) where.push(gte(experiments.automationScore, f.minAutomation));
  if (f.minScalability !== undefined) where.push(gte(experiments.scalabilityScore, f.minScalability));
  if (f.maxCapital !== undefined) where.push(sql`${experiments.capitalRequirement} <= ${f.maxCapital}`);
  if (f.since) where.push(or(gte(experiments.createdAt, f.since), gte(experiments.lastActivityAt, f.since))!);
  if (f.search) where.push(or(ilike(experiments.name, `%${f.search}%`), ilike(experiments.description, `%${f.search}%`), ilike(experiments.strategyId, `%${f.search}%`))!);
  const rows = await ctx.db.select().from(experiments).where(where.length ? and(...where) : undefined);
  const ids = rows.map((r) => r.id);
  const [scoreMap, accounts, evidence] = await Promise.all([latestScores(ctx.db), accountsByExperiment(ctx.db, ids), latestEvidence(ctx.db, ids)]);
  const equity = await latestEquity(ctx.db, [...accounts.values()].map((a) => a.id));
  let items: ExperimentListItem[] = rows.map((r) => {
    const s = scoreMap.get(r.id);
    const a = accounts.get(r.id);
    const eq_ = a ? (equity.get(a.id)?.equity ?? Number(a.cash)) : null;
    const start = a ? Number(a.startingCapital) : 0;
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      strategyId: r.strategyId,
      category: r.category,
      kind: r.kind,
      status: r.status,
      statusReason: r.statusReason,
      failureReasons: r.failureReasons,
      riskLevel: r.riskLevel,
      automationScore: r.automationScore,
      scalabilityScore: r.scalabilityScore,
      complexityScore: r.complexityScore,
      capitalRequirement: Number(r.capitalRequirement),
      expectedTimeToRevenueDays: r.expectedTimeToRevenueDays,
      isDemo: r.isDemo,
      createdAt: r.createdAt.toISOString(),
      lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
      evidence: evidence.get(r.id) ?? null,
      score: s ? { overall: s.overall, components: s.components, confidence: s.confidence, evidence: s.evidence, rank: s.rank, computedAt: s.computedAt.toISOString() } : null,
      paper: a && eq_ !== null ? { accountId: a.id, provenance: a.provenance, status: a.status, startingCapital: start, equity: eq_, pnl: eq_ - start, pnlPct: start > 0 ? (eq_ - start) / start : null, isDemo: a.isDemo } : null,
    };
  });
  if (f.minScore !== undefined) items = items.filter((i) => (i.score?.overall ?? -1) >= f.minScore!);
  if (f.maxScore !== undefined) items = items.filter((i) => i.score !== null && i.score.overall <= f.maxScore!);
  if (f.minProfit !== undefined) items = items.filter((i) => i.paper !== null && i.paper.pnl >= f.minProfit!);
  const dir = f.dir === 'asc' ? 1 : -1;
  const sort = f.sort ?? 'rank';
  items.sort((a, b) => {
    switch (sort) {
      case 'rank':
        return (a.score?.rank ?? 1e9) - (b.score?.rank ?? 1e9);
      case 'score':
        return dir * ((a.score?.overall ?? -1) - (b.score?.overall ?? -1));
      case 'pnl':
        return dir * ((a.paper?.pnl ?? -Infinity) - (b.paper?.pnl ?? -Infinity));
      case 'created':
        return dir * (Date.parse(a.createdAt) - Date.parse(b.createdAt));
      case 'activity':
        return dir * (Date.parse(a.lastActivityAt ?? a.createdAt) - Date.parse(b.lastActivityAt ?? b.createdAt));
      case 'name':
        return -dir * a.name.localeCompare(b.name);
    }
  });
  return f.limit ? items.slice(0, f.limit) : items;
}

/** Dashboard KPIs. Money is split by provenance: PAPER and SIMULATED are never added together, DEMO never counts. */
export async function dashboard(ctx: PlatformContext) {
  const all = await listExperiments(ctx, { includeArchived: true });
  const live = all.filter((e) => e.status !== 'ARCHIVED');
  const active = live.filter((e) => !['FAILED', 'PAUSED', 'DISCOVERED'].includes(e.status));
  const accounts = await ctx.db.select().from(paperAccounts);
  const equity = await latestEquity(ctx.db, accounts.map((a) => a.id));
  const byProv = (prov: string) => {
    const rows = accounts.filter((a) => a.provenance === prov && !a.isDemo);
    const eqSum = rows.filter((a) => a.status === 'ACTIVE').reduce((s, a) => s + (equity.get(a.id)?.equity ?? Number(a.cash)), 0);
    const pnl = rows.reduce((s, a) => s + ((equity.get(a.id)?.equity ?? Number(a.cash)) - Number(a.startingCapital)), 0);
    const capital = rows.reduce((s, a) => s + Number(a.startingCapital), 0);
    // No account yet means NO DATA (null), never a made-up zero.
    const none = rows.length === 0;
    return { accounts: rows.length, activeAccounts: rows.filter((a) => a.status === 'ACTIVE').length, equity: none ? null : eqSum, pnl: none ? null : pnl, capital };
  };
  const paper = byProv('PAPER');
  const simulated = byProv('SIMULATED');
  const ranked = live.filter((e) => e.score && e.status !== 'FAILED').sort((a, b) => (a.score!.rank ?? 1e9) - (b.score!.rank ?? 1e9));
  const best = (kind: (e: ExperimentListItem) => boolean) => {
    const e = ranked.find(kind);
    return e ? { id: e.id, name: e.name, score: e.score!.overall, confidence: e.score!.confidence, evidence: e.score!.evidence } : null;
  };
  const scored = live.filter((e) => e.score);
  const stop = await getEmergencyStop(ctx.db);
  const activeAccounts = accounts.filter((a) => a.status === 'ACTIVE');
  const limitStatuses = [];
  for (const a of activeAccounts) {
    const exp = live.find((e) => e.id === a.experimentId);
    if (!exp || !PAPER_TRADING_STATUSES.includes(exp.status as never)) continue;
    const [row] = await ctx.db.select({ riskLimits: experiments.riskLimits }).from(experiments).where(eq(experiments.id, a.experimentId));
    limitStatuses.push(evaluateLimits(row!.riskLimits as unknown as RiskLimits, await snapshotOf(ctx.db, a)));
  }
  const [openRisk] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(riskEvents).where(and(sql`${riskEvents.resolvedAt} IS NULL`, gte(riskEvents.createdAt, new Date(ctx.clock.now().getTime() - 86_400_000))));
  const recentIdeas = await ctx.db.select({ id: ideas.id, name: ideas.name, category: ideas.category, origin: ideas.origin, status: ideas.status, createdAt: ideas.createdAt }).from(ideas).orderBy(desc(ideas.createdAt)).limit(6);
  const activity = await ctx.db.select().from(auditLogs).orderBy(desc(auditLogs.ts)).limit(12);
  const improved = await ctx.db.select({ id: experimentVersions.id, experimentId: experimentVersions.experimentId, label: experimentVersions.label, status: experimentVersions.status, changeNote: experimentVersions.changeNote, createdAt: experimentVersions.createdAt }).from(experimentVersions).where(sql`${experimentVersions.seq} > 1`).orderBy(desc(experimentVersions.createdAt)).limit(5);
  const nextToReview = live
    .filter((e) => ['READY_FOR_LIVE_REVIEW', 'PROMISING', 'PROBATION'].includes(e.status) || (e.status === 'DISCOVERED' && (e.score?.overall ?? 0) > 0))
    .sort((a, b) => ['READY_FOR_LIVE_REVIEW', 'PROMISING', 'PROBATION', 'DISCOVERED'].indexOf(a.status) - ['READY_FOR_LIVE_REVIEW', 'PROMISING', 'PROBATION', 'DISCOVERED'].indexOf(b.status))
    .slice(0, 5)
    .map((e) => ({ id: e.id, name: e.name, status: e.status, reason: e.statusReason }));
  return {
    totals: {
      totalExperiments: live.length,
      activeExperiments: active.length,
      byStatus: Object.fromEntries([...new Set(live.map((e) => e.status))].map((s) => [s, live.filter((e) => e.status === s).length])),
      failed: live.filter((e) => e.status === 'FAILED').length,
    },
    paperPortfolio: { ...paper, fund: ctx.config.PAPER_TOTAL_CAPITAL_USD, allocated: activeAccounts.reduce((s, a) => s + Number(a.startingCapital), 0) },
    simulatedBusiness: simulated,
    totalSimulatedProfit: { paper: paper.pnl, simulatedOperations: simulated.pnl, note: 'PAPER = virtual money on live data; SIMULATED = business operating simulations. They are reported separately and never added together. DEMO results are excluded.' },
    totalCapitalSimulated: paper.accounts + simulated.accounts > 0 ? paper.capital + simulated.capital : null,
    bestStrategy: best((e) => e.kind !== 'BUSINESS'),
    bestBusinessModel: best((e) => e.kind === 'BUSINESS'),
    averageScore: scored.length ? scored.reduce((s, e) => s + e.score!.overall, 0) / scored.length : null,
    riskStatus: { status: overallRiskStatus(limitStatuses, stop.engaged), openEvents24h: openRisk?.n ?? 0, emergencyStop: stop },
    topOpportunities: ranked.slice(0, 10),
    recentIdeas,
    recentActivity: activity,
    recentlyImproved: improved,
    nextToReview,
    mode: ctx.config.TRADING_MODE === 'live' ? 'LIVE REQUESTED — DISABLED' : 'PAPER',
  };
}

export async function experimentDetail(ctx: PlatformContext, idOrSlug: string) {
  const [exp] = await ctx.db
    .select()
    .from(experiments)
    .where(/^[0-9a-f-]{36}$/.test(idOrSlug) ? eq(experiments.id, idOrSlug) : eq(experiments.slug, idOrSlug));
  if (!exp) throw new NotFoundError('experiment', idOrSlug);
  const id = exp.id;
  const [strategy] = await ctx.db.select().from(strategies).where(eq(strategies.id, exp.strategyId));
  const versions = await ctx.db.select().from(experimentVersions).where(eq(experimentVersions.experimentId, id)).orderBy(desc(experimentVersions.seq));
  const runs = await ctx.db.select().from(strategyRuns).where(eq(strategyRuns.experimentId, id)).orderBy(desc(strategyRuns.createdAt)).limit(100);
  const latestByType: Record<string, (typeof runs)[number]> = {};
  for (const r of runs) if (r.status === 'SUCCEEDED' && r.versionId === exp.currentVersionId && !latestByType[r.runType]) latestByType[r.runType] = r;
  const scoreHistory = await ctx.db.select().from(scores).where(eq(scores.experimentId, id)).orderBy(desc(scores.computedAt)).limit(100);
  const sources = await ctx.db.select({ s: researchSources }).from(experimentSources).innerJoin(researchSources, eq(researchSources.id, experimentSources.sourceId)).where(eq(experimentSources.experimentId, id));
  const accounts = await ctx.db.select().from(paperAccounts).where(eq(paperAccounts.experimentId, id)).orderBy(desc(paperAccounts.createdAt));
  const account = accounts.find((a) => a.status === 'ACTIVE') ?? accounts[0] ?? null;
  let paper: Record<string, unknown> | null = null;
  let limits: ReturnType<typeof evaluateLimits> | null = null;
  if (account) {
    const snap = await snapshotOf(ctx.db, account);
    const stats = await paperStats(ctx, exp);
    limits = evaluateLimits(exp.riskLimits as unknown as RiskLimits, snap);
    paper = {
      account,
      snapshot: Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, typeof v === 'object' && v !== null && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : v])),
      positions: await ctx.db.select().from(paperPositions).where(eq(paperPositions.accountId, account.id)),
      orders: await ctx.db.select().from(paperOrders).where(eq(paperOrders.accountId, account.id)).orderBy(desc(paperOrders.createdAt)).limit(50),
      fills: await ctx.db.select().from(paperFills).where(eq(paperFills.accountId, account.id)).orderBy(desc(paperFills.ts)).limit(50),
      transactions: await ctx.db.select().from(paperTransactions).where(eq(paperTransactions.accountId, account.id)).orderBy(desc(paperTransactions.seq)).limit(50),
      equityCurve: stats?.equityCurve.slice(-500) ?? [],
      trades: stats?.trades.slice(-100) ?? [],
      stats: stats ? { days: stats.days, simulatedDays: stats.simulatedDays, trades: stats.trades.length, netProfit: stats.netProfit, maxDrawdownPct: stats.maxDrawdownPct, ordersTotal: stats.ordersTotal, ordersRejected: stats.ordersRejected, riskBreaches: stats.riskBreaches, dataUptime: stats.dataUptime, winRate: stats.trades.length ? stats.trades.filter((t) => t.netPnl > 0).length / stats.trades.length : null } : null,
      previousAccounts: accounts.filter((a) => a.id !== account.id).map((a) => ({ id: a.id, status: a.status, versionId: a.versionId, startingCapital: a.startingCapital, cash: a.cash, createdAt: a.createdAt })),
    };
  }
  const events = await ctx.db.select().from(riskEvents).where(eq(riskEvents.experimentId, id)).orderBy(desc(riskEvents.createdAt)).limit(50);
  const audits = await ctx.db.select().from(auditLogs).where(eq(auditLogs.experimentId, id)).orderBy(desc(auditLogs.ts)).limit(100);
  const sysEvents = await ctx.db.select().from(systemEvents).where(eq(systemEvents.experimentId, id)).orderBy(desc(systemEvents.createdAt)).limit(100);
  const metricRows = await ctx.db.select().from(metrics).where(eq(metrics.experimentId, id)).orderBy(desc(metrics.recordedAt)).limit(300);
  const [idea] = exp.ideaId ? await ctx.db.select().from(ideas).where(eq(ideas.id, exp.ideaId)) : [];
  return {
    experiment: exp,
    strategy: strategy ?? null,
    versions,
    currentVersion: versions.find((v) => v.id === exp.currentVersionId) ?? versions[0] ?? null,
    runs: runs.map((r) => ({ id: r.id, runType: r.runType, provenance: r.provenance, status: r.status, versionId: r.versionId, seed: r.seed, summary: r.summary, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs, createdAt: r.createdAt })),
    latestRuns: latestByType,
    scoreHistory,
    sources: sources.map((s) => s.s),
    paper,
    riskLimits: { limits: exp.riskLimits, labels: RISK_LIMIT_LABELS, status: limits },
    riskEvents: events,
    compliance: exp.compliance as ComplianceEntry[],
    audit: audits,
    events: sysEvents,
    metrics: metricRows,
    idea: idea ?? null,
  };
}

export async function compareExperiments(ctx: PlatformContext, ids: string[]) {
  const items = (await listExperiments(ctx, { includeArchived: true })).filter((e) => ids.includes(e.id));
  const runs = ids.length
    ? await ctx.db
        .select()
        .from(strategyRuns)
        .where(and(inArray(strategyRuns.experimentId, ids), inArray(strategyRuns.runType, ['BACKTEST', 'SIMULATION']), eq(strategyRuns.status, 'SUCCEEDED')))
        .orderBy(desc(strategyRuns.createdAt))
    : [];
  return items.map((e) => {
    const run = runs.find((r) => r.experimentId === e.id);
    return { ...e, keyResult: run ? { runType: run.runType, provenance: run.provenance, summary: run.summary } : null };
  });
}

export async function listStrategies(ctx: PlatformContext) {
  const rows = await ctx.db.select().from(strategies).orderBy(asc(strategies.kind), asc(strategies.name));
  const counts = await ctx.db.select({ strategyId: experiments.strategyId, n: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where ${experiments.status} not in ('ARCHIVED','FAILED','PAUSED','DISCOVERED'))::int` }).from(experiments).groupBy(experiments.strategyId);
  return rows.map((s) => ({ ...s, experiments: counts.find((c) => c.strategyId === s.id)?.n ?? 0, activeExperiments: counts.find((c) => c.strategyId === s.id)?.active ?? 0 }));
}

/** Every version of an experiment with its latest backtest/simulation, so v4 can be compared with v3. */
export async function versionComparison(ctx: PlatformContext, experimentId: string) {
  const versions = await ctx.db.select().from(experimentVersions).where(eq(experimentVersions.experimentId, experimentId)).orderBy(asc(experimentVersions.seq));
  const runs = await ctx.db.select().from(strategyRuns).where(and(eq(strategyRuns.experimentId, experimentId), eq(strategyRuns.status, 'SUCCEEDED'))).orderBy(desc(strategyRuns.createdAt));
  const sc = await ctx.db.select().from(scores).where(eq(scores.experimentId, experimentId)).orderBy(desc(scores.computedAt));
  return versions.map((v) => {
    const bt = runs.find((r) => r.versionId === v.id && (r.runType === 'BACKTEST' || r.runType === 'SIMULATION'));
    const wf = runs.find((r) => r.versionId === v.id && r.runType === 'WALK_FORWARD');
    const lab = runs.find((r) => r.versionId === v.id && r.runType === 'LAB');
    const score = sc.find((s) => s.versionId === v.id);
    return { version: v, result: bt ? { provenance: bt.provenance, summary: bt.summary, at: bt.createdAt } : null, walkForward: wf?.summary ?? null, lab: lab?.summary ?? null, score: score ? { overall: score.overall, confidence: score.confidence } : null };
  });
}

export async function portfolio(ctx: PlatformContext) {
  const accounts = await ctx.db.select({ a: paperAccounts, name: experiments.name, status: experiments.status, kind: experiments.kind }).from(paperAccounts).innerJoin(experiments, eq(experiments.id, paperAccounts.experimentId)).orderBy(desc(paperAccounts.createdAt));
  const equity = await latestEquity(ctx.db, accounts.map((x) => x.a.id));
  const rows = [];
  for (const x of accounts) {
    const snap = x.a.status === 'ACTIVE' ? await snapshotOf(ctx.db, x.a) : null;
    const eqv = equity.get(x.a.id)?.equity ?? Number(x.a.cash);
    rows.push({
      id: x.a.id,
      experimentId: x.a.experimentId,
      experimentName: x.name,
      experimentStatus: x.status,
      kind: x.kind,
      provenance: x.a.provenance,
      status: x.a.status,
      isDemo: x.a.isDemo,
      startingCapital: Number(x.a.startingCapital),
      cash: Number(x.a.cash),
      equity: eqv,
      pnl: eqv - Number(x.a.startingCapital),
      realizedPnl: Number(x.a.realizedPnl),
      unrealizedPnl: snap ? snap.unrealizedPnl.toNumber() : null,
      fees: Number(x.a.feesPaid),
      slippage: Number(x.a.slippageCost),
      funding: Number(x.a.fundingPnl),
      operatingPnl: Number(x.a.operatingPnl),
      exposure: snap ? snap.exposure.toNumber() : null,
      openPositions: snap?.openPositions ?? 0,
      openOrders: snap?.openOrders ?? 0,
      drawdownPct: snap?.drawdownPct ?? null,
      simulatedDays: x.a.simulatedDays,
      lastTickAt: x.a.lastTickAt,
      createdAt: x.a.createdAt,
    });
  }
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const allocated = active.reduce((s, r) => s + r.startingCapital, 0);
  return { fund: { total: ctx.config.PAPER_TOTAL_CAPITAL_USD, allocated, unallocated: ctx.config.PAPER_TOTAL_CAPITAL_USD - allocated, defaultAllocation: ctx.config.PAPER_DEFAULT_ALLOCATION_USD }, accounts: rows };
}

export async function accountDetail(ctx: PlatformContext, accountId: string) {
  const [a] = await ctx.db.select().from(paperAccounts).where(eq(paperAccounts.id, accountId));
  if (!a) throw new NotFoundError('paper account', accountId);
  return {
    account: a,
    positions: await ctx.db.select().from(paperPositions).where(eq(paperPositions.accountId, accountId)),
    orders: await ctx.db.select().from(paperOrders).where(eq(paperOrders.accountId, accountId)).orderBy(desc(paperOrders.createdAt)).limit(200),
    fills: await ctx.db.select().from(paperFills).where(eq(paperFills.accountId, accountId)).orderBy(desc(paperFills.ts)).limit(200),
    transactions: await ctx.db.select().from(paperTransactions).where(eq(paperTransactions.accountId, accountId)).orderBy(desc(paperTransactions.seq)).limit(500),
    equityCurve: await ctx.db.select({ ts: performanceSnapshots.ts, equity: performanceSnapshots.equity, drawdownPct: performanceSnapshots.drawdownPct }).from(performanceSnapshots).where(eq(performanceSnapshots.accountId, accountId)).orderBy(asc(performanceSnapshots.ts)).limit(5000),
  };
}

/** Normalised equity curves for charts: paper/simulated records and the latest backtests. */
export async function performance(ctx: PlatformContext, opts: { limit?: number } = {}) {
  const items = (await listExperiments(ctx, { includeArchived: false })).slice(0, opts.limit ?? 12);
  const curves = [];
  for (const e of items) {
    let paperCurve: Array<{ ts: number; value: number }> = [];
    if (e.paper) {
      const pts = await ctx.db.select({ ts: performanceSnapshots.ts, equity: performanceSnapshots.equity }).from(performanceSnapshots).where(eq(performanceSnapshots.accountId, e.paper.accountId)).orderBy(asc(performanceSnapshots.ts)).limit(3000);
      paperCurve = pts.map((p) => ({ ts: p.ts.getTime(), value: (Number(p.equity) / e.paper!.startingCapital) * 100 }));
    }
    const [bt] = await ctx.db.select().from(strategyRuns).where(and(eq(strategyRuns.experimentId, e.id), eq(strategyRuns.runType, 'BACKTEST'), eq(strategyRuns.status, 'SUCCEEDED'))).orderBy(desc(strategyRuns.createdAt)).limit(1);
    const btCurve = ((bt?.result as { equityCurve?: Array<{ ts: number; equity: number }> } | undefined)?.equityCurve ?? []).map((p, _i, arr) => ({ ts: p.ts, value: (p.equity / (arr[0]?.equity || 1)) * 100 }));
    curves.push({ id: e.id, name: e.name, category: e.category, kind: e.kind, paperProvenance: e.paper?.provenance ?? null, backtestProvenance: bt?.provenance ?? null, paper: paperCurve, backtest: btCurve, score: e.score?.overall ?? null });
  }
  const byCategory = Object.values(
    items.reduce<Record<string, { category: string; experiments: number; avgScore: number; scored: number; paperPnl: number }>>((acc, e) => {
      const c = (acc[e.category] ??= { category: e.category, experiments: 0, avgScore: 0, scored: 0, paperPnl: 0 });
      c.experiments++;
      if (e.score) {
        c.avgScore += e.score.overall;
        c.scored++;
      }
      if (e.paper && !e.paper.isDemo) c.paperPnl += e.paper.pnl;
      return acc;
    }, {}),
  ).map((c) => ({ ...c, avgScore: c.scored ? c.avgScore / c.scored : null }));
  return { curves, byCategory };
}

export async function logs(ctx: PlatformContext, f: { kind: 'audit' | 'events'; experimentId?: string; action?: string; level?: string; component?: string; search?: string; limit?: number; before?: Date }) {
  const limit = Math.min(f.limit ?? 200, 1000);
  if (f.kind === 'audit') {
    const where: SQL[] = [];
    if (f.experimentId) where.push(eq(auditLogs.experimentId, f.experimentId));
    if (f.action) where.push(eq(auditLogs.action, f.action));
    if (f.before) where.push(sql`${auditLogs.ts} < ${f.before.toISOString()}::timestamptz`);
    if (f.search) where.push(or(ilike(auditLogs.entityType, `%${f.search}%`), sql`${auditLogs.details}::text ILIKE ${`%${f.search}%`}`)!);
    return ctx.db.select().from(auditLogs).where(where.length ? and(...where) : undefined).orderBy(desc(auditLogs.ts)).limit(limit);
  }
  const where: SQL[] = [];
  if (f.experimentId) where.push(eq(systemEvents.experimentId, f.experimentId));
  if (f.level) where.push(eq(systemEvents.level, f.level));
  if (f.component) where.push(eq(systemEvents.component, f.component));
  if (f.before) where.push(sql`${systemEvents.createdAt} < ${f.before.toISOString()}::timestamptz`);
  if (f.search) where.push(ilike(systemEvents.message, `%${f.search}%`));
  return ctx.db.select().from(systemEvents).where(where.length ? and(...where) : undefined).orderBy(desc(systemEvents.createdAt)).limit(limit);
}

export async function riskOverview(ctx: PlatformContext) {
  const rows = await ctx.db.select({ exp: experiments, account: paperAccounts }).from(experiments).leftJoin(paperAccounts, and(eq(paperAccounts.experimentId, experiments.id), eq(paperAccounts.status, 'ACTIVE'))).where(sql`${experiments.status} not in ('ARCHIVED')`);
  const out = [];
  const all = [];
  for (const r of rows) {
    const limits = r.exp.riskLimits as unknown as RiskLimits;
    const status = r.account ? evaluateLimits(limits, await snapshotOf(ctx.db, r.account)) : null;
    if (status && PAPER_TRADING_STATUSES.includes(r.exp.status as never)) all.push(status);
    out.push({ experimentId: r.exp.id, name: r.exp.name, status: r.exp.status, kind: r.exp.kind, riskLevel: r.exp.riskLevel, limits, accountId: r.account?.id ?? null, utilization: status });
  }
  const stop = await getEmergencyStop(ctx.db);
  const events = await ctx.db.select({ e: riskEvents, name: experiments.name }).from(riskEvents).leftJoin(experiments, eq(experiments.id, riskEvents.experimentId)).orderBy(desc(riskEvents.createdAt)).limit(100);
  return { overall: overallRiskStatus(all, stop.engaged), emergencyStop: stop, experiments: out, events: events.map((x) => ({ ...x.e, experimentName: x.name })), labels: RISK_LIMIT_LABELS };
}

export async function research(ctx: PlatformContext, f: { search?: string; category?: string; sourceType?: string; limit?: number } = {}) {
  const where: SQL[] = [];
  if (f.search) where.push(or(ilike(researchSources.title, `%${f.search}%`), ilike(researchSources.summary, `%${f.search}%`))!);
  if (f.category) where.push(eq(researchSources.monitorCategory, f.category));
  if (f.sourceType) where.push(eq(researchSources.sourceType, f.sourceType));
  const sources = await ctx.db.select().from(researchSources).where(where.length ? and(...where) : undefined).orderBy(desc(researchSources.foundAt)).limit(Math.min(f.limit ?? 200, 1000));
  const links = await ctx.db.select({ sourceId: experimentSources.sourceId, experimentId: experimentSources.experimentId, name: experiments.name }).from(experimentSources).innerJoin(experiments, eq(experiments.id, experimentSources.experimentId));
  return sources.map((s) => ({ ...s, experiments: links.filter((l) => l.sourceId === s.id).map((l) => ({ id: l.experimentId, name: l.name })) }));
}

export async function listIdeas(ctx: PlatformContext, f: { status?: string; category?: string; search?: string } = {}) {
  const where: SQL[] = [];
  if (f.status) where.push(eq(ideas.status, f.status));
  if (f.category) where.push(eq(ideas.category, f.category));
  if (f.search) where.push(or(ilike(ideas.name, `%${f.search}%`), ilike(ideas.description, `%${f.search}%`))!);
  return ctx.db.select().from(ideas).where(where.length ? and(...where) : undefined).orderBy(desc(ideas.createdAt)).limit(500);
}

export async function listNotifications(ctx: PlatformContext, unreadOnly = false) {
  return ctx.db.select().from(notifications).where(unreadOnly ? sql`${notifications.readAt} IS NULL` : undefined).orderBy(desc(notifications.createdAt)).limit(100);
}

export async function markNotificationsRead(ctx: PlatformContext, ids?: string[]) {
  await ctx.db.update(notifications).set({ readAt: new Date() }).where(ids && ids.length ? inArray(notifications.id, ids) : sql`${notifications.readAt} IS NULL`);
}

export async function listJobs(ctx: PlatformContext, limit = 100) {
  const jobs = await ctx.db.select().from(jobRuns).orderBy(desc(jobRuns.createdAt)).limit(limit);
  const workers = await ctx.db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt));
  return { jobs, workers };
}

export async function listDataSources(ctx: PlatformContext) {
  return ctx.db.select().from(dataSources).orderBy(asc(dataSources.kind), asc(dataSources.id));
}

export async function settingsView(ctx: PlatformContext) {
  return {
    config: redactConfig(ctx.config),
    mode: { tradingMode: ctx.config.TRADING_MODE, liveEnabled: false, statement: 'PAPER is the default. No live executor exists in this build; live trading cannot be enabled by configuration.' },
    scoringWeights: { defaults: DEFAULT_WEIGHTS, overrides: await getSetting(ctx.db, SETTING_KEYS.scoringWeights, {}), labels: COMPONENT_LABELS },
    gateThresholds: { defaults: DEFAULT_THRESHOLDS, overrides: await getSetting(ctx.db, SETTING_KEYS.gateThresholds, {}) },
    emergencyStop: await getEmergencyStop(ctx.db),
  };
}

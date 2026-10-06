import {
  ConflictError,
  NotFoundError,
  ValidationError,
  defaultRiskLimits,
  newId,
  normalizeTitle,
  stableHash,
  toDb,
  type Assumption,
  type ComplianceEntry,
  type ComplianceItem,
  type ComplianceState,
  type ExperimentStatus,
  type FailureReason,
  type RiskLevel,
  type RiskLimits,
} from '@aoc/core';
import { experimentSources, experimentVersions, experiments, paperAccounts, researchSources, strategies, type DbOrTx } from '@aoc/database';
import { PAPER_TRADING_STATUSES, assertTransition, nextVersionLabel } from '@aoc/experiments';
import { defaultCompliance } from '@aoc/research';
import { validateRiskLimits } from '@aoc/risk';
import { VENUE_COSTS, type AnyStrategyModule, type DataRequirement } from '@aoc/strategies';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { audit, type Actor } from './audit';
import type { PlatformContext } from './context';
import { notify } from './notifications';

export type ExperimentRow = typeof experiments.$inferSelect;
export type VersionRow = typeof experimentVersions.$inferSelect;

/** Mirror the code registry into the strategies table (idempotent). */
export async function syncStrategies(ctx: PlatformContext): Promise<number> {
  let n = 0;
  for (const m of ctx.registry.list()) {
    const meta = m.meta;
    const values = {
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      category: meta.category,
      moduleVersion: meta.version,
      description: meta.description,
      paramsSchema: { paramSpace: meta.paramSpace, hypothesis: meta.hypothesis, edgeRationale: meta.edgeRationale, knownRisks: meta.knownRisks, qualitative: meta.qualitative },
      defaultParams: meta.defaultParams as Record<string, unknown>,
      requiredData: describeRequirements(m.dataRequirements(meta.defaultParams)),
      capabilities: meta.capabilities as unknown as Record<string, boolean>,
    };
    await ctx.db
      .insert(strategies)
      .values(values)
      .onConflictDoUpdate({ target: strategies.id, set: { ...values, updatedAt: new Date() } });
    n++;
  }
  return n;
}

export function describeRequirements(reqs: DataRequirement[]): string[] {
  return reqs.map((r) => {
    switch (r.kind) {
      case 'BARS':
        return `${r.venue} ${r.symbol} ${r.interval} bars (≥ ${r.minBars})`;
      case 'FUNDING':
        return `${r.venue} ${r.symbol} funding history (≥ ${r.minPoints} prints)`;
      case 'QUOTES':
        return `top-of-book quotes for ${r.symbol} on ${r.venues.join(', ')}`;
      case 'PM_MARKETS':
        return `prediction-market order books: ${r.query} (up to ${r.maxMarkets})`;
      case 'NONE':
        return 'no market data (assumption-driven simulation)';
    }
  });
}

/** Cost assumptions for finance modules, stated explicitly like business assumptions. */
function financeAssumptions(m: AnyStrategyModule, params: Record<string, unknown>): Assumption[] {
  const venues = new Set<string>();
  for (const r of m.dataRequirements(params)) {
    if (r.kind === 'BARS' || r.kind === 'FUNDING') venues.add(r.venue);
    if (r.kind === 'QUOTES') r.venues.forEach((v) => venues.add(v));
    if (r.kind === 'PM_MARKETS') venues.add('polymarket');
  }
  const out: Assumption[] = [];
  for (const v of venues) {
    const c = VENUE_COSTS[v];
    if (!c) continue;
    const fee = c.feeModel;
    const takerLabel = fee.type === 'bps' ? `${fee.takerBps} bps` : fee.type === 'polymarket' ? `rate ${fee.rate} × p(1−p)` : '0';
    out.push({ key: `${v}.takerFee`, label: `${v} taker fee`, unit: fee.type === 'bps' ? 'bps' : 'rate', low: fee.type === 'bps' ? fee.takerBps : fee.type === 'polymarket' ? fee.rate : 0, mode: fee.type === 'bps' ? fee.takerBps : fee.type === 'polymarket' ? fee.rate : 0, high: fee.type === 'bps' ? fee.takerBps : fee.type === 'polymarket' ? fee.rate : 0, distribution: 'fixed', source: c.source, note: `Published base tier (${takerLabel}); reviewed ${c.reviewed}. Costs are stressed ×1.5 and ×2 in sensitivity tests.` });
    out.push({ key: `${v}.spread`, label: `${v} typical spread`, unit: 'bps', low: c.typicalSpreadBps, mode: c.typicalSpreadBps, high: c.typicalSpreadBps * 3, distribution: 'fixed', source: null, note: 'Assumed typical spread for liquid instruments; recorded books replace it in paper mode.' });
  }
  out.push({ key: 'execution.latency', label: 'Decision-to-execution latency', unit: 'bars/snapshots', low: 1, mode: 1, high: 1, distribution: 'fixed', source: null, note: 'Orders decided on one bar/snapshot execute on the next (no same-bar fills).' });
  return out;
}

function slugify(s: string): string {
  return normalizeTitle(s).replace(/\s+/g, '-').slice(0, 60);
}

export interface CreateExperimentInput {
  strategyId: string;
  name?: string;
  description?: string;
  hypothesis?: string;
  params?: Record<string, unknown>;
  assumptionOverrides?: Record<string, { low?: number; mode?: number; high?: number; source?: string | null }>;
  capital?: number;
  riskLimits?: Partial<RiskLimits>;
  riskLevel?: RiskLevel;
  ideaId?: string | null;
  sourceIds?: string[];
  isDemo?: boolean;
}

export async function createExperiment(ctx: PlatformContext, input: CreateExperimentInput, actor: Actor): Promise<ExperimentRow> {
  const m = ctx.registry.get(input.strategyId);
  const meta = m.meta;
  const params = ctx.registry.parseParams(input.strategyId, input.params ?? {});
  const capital = input.capital ?? ctx.config.PAPER_DEFAULT_ALLOCATION_USD;
  if (!(capital > 0)) throw new ValidationError('capital must be positive');
  const isBusiness = meta.kind === 'BUSINESS';
  let assumptions: Assumption[] = isBusiness ? (m.defaultAssumptions?.() ?? []) : financeAssumptions(m, params);
  if (input.assumptionOverrides) {
    assumptions = assumptions.map((a) => {
      const o = input.assumptionOverrides![a.key];
      if (!o) return a;
      const next = { ...a, low: o.low ?? a.low, mode: o.mode ?? a.mode, high: o.high ?? a.high, source: o.source !== undefined ? o.source : a.source };
      if (!(next.low <= next.mode && next.mode <= next.high)) throw new ValidationError(`assumption ${a.key}: low <= mode <= high violated`);
      return next;
    });
  }
  const baseLimits = defaultRiskLimits(capital);
  const limits = validateRiskLimits({
    ...baseLimits,
    // A young business burns cash by design; the stop is running out of the allocation.
    ...(isBusiness
      ? { maxCapital: Math.max(capital * 10, 5_000), maxDrawdownPct: 1, maxDailyLoss: Math.max(capital * 10, 5_000), maxOrdersPerDay: 0, maxOrderNotional: 0, maxExposure: 0, maxPositions: 0, maxApiSpend: Math.max(capital * 10, 5_000), maxExperimentSpend: Math.max(capital * 50, 25_000) }
      : {}),
    ...input.riskLimits,
  });
  const name = input.name ?? meta.name;
  const q = meta.qualitative;
  const estimatedCost = isBusiness
    ? assumptions.filter((a) => a.stressRole === 'cost' && a.unit === 'USD' && /per month/i.test(a.label) && !/per (customer|client|ticket|email|lead|product)/i.test(a.label)).reduce((s, a) => s + a.mode, 0)
    : 0;

  return ctx.db.transaction(async (tx) => {
    const [strategyRow] = await tx.select({ id: strategies.id }).from(strategies).where(eq(strategies.id, meta.id));
    if (!strategyRow) throw new ValidationError(`strategy ${meta.id} is not registered in the database (run the seed or syncStrategies)`);
    const id = newId();
    const [row] = await tx
      .insert(experiments)
      .values({
        id,
        slug: `${slugify(name)}-${stableHash(id, 6)}`,
        strategyId: meta.id,
        ideaId: input.ideaId ?? null,
        name,
        category: meta.category,
        kind: meta.kind,
        description: input.description ?? meta.description,
        hypothesis: input.hypothesis ?? meta.hypothesis,
        assumptions,
        requiredData: describeRequirements(m.dataRequirements(params)),
        capitalRequirement: toDb(capital),
        estimatedCost: toDb(estimatedCost),
        riskLevel: input.riskLevel ?? meta.defaultRiskLevel,
        automationScore: q.automation,
        scalabilityScore: q.scalability,
        complexityScore: 100 - q.operationalSimplicity,
        expectedTimeToRevenueDays: q.timeToRevenueDays,
        qualitative: { ...q },
        status: 'DISCOVERED',
        riskLimits: limits as unknown as Record<string, number>,
        compliance: defaultCompliance(meta.category),
        paperCapital: toDb(capital),
        isDemo: input.isDemo ?? false,
        lastActivityAt: ctx.clock.now(),
      })
      .returning();
    const [version] = await tx
      .insert(experimentVersions)
      .values({ experimentId: id, seq: 1, label: 'v1', params, assumptions, strategyModuleVersion: meta.version, createdBy: actor.id, changeNote: 'Initial version (module defaults)', status: 'ACTIVE' })
      .returning();
    await tx.update(experiments).set({ currentVersionId: version!.id }).where(eq(experiments.id, id));
    if (input.sourceIds && input.sourceIds.length > 0) {
      const existing = await tx.select({ id: researchSources.id }).from(researchSources).where(inArray(researchSources.id, input.sourceIds));
      if (existing.length > 0) await tx.insert(experimentSources).values(existing.map((s) => ({ experimentId: id, sourceId: s.id }))).onConflictDoNothing();
    }
    await audit(tx, actor, 'EXPERIMENT_CREATED', { type: 'experiment', id, experimentId: id }, { strategyId: meta.id, name, capital, isDemo: input.isDemo ?? false });
    await audit(tx, actor, 'VERSION_CREATED', { type: 'experiment_version', id: version!.id, experimentId: id }, { label: 'v1', params });
    return { ...row!, currentVersionId: version!.id };
  });
}

export async function getExperiment(db: DbOrTx, id: string): Promise<ExperimentRow> {
  const [row] = await db.select().from(experiments).where(eq(experiments.id, id));
  if (!row) throw new NotFoundError('experiment', id);
  return row;
}

export async function currentVersion(db: DbOrTx, exp: ExperimentRow): Promise<VersionRow> {
  if (exp.currentVersionId) {
    const [v] = await db.select().from(experimentVersions).where(eq(experimentVersions.id, exp.currentVersionId));
    if (v) return v;
  }
  const [latest] = await db.select().from(experimentVersions).where(eq(experimentVersions.experimentId, exp.id)).orderBy(desc(experimentVersions.seq)).limit(1);
  if (!latest) throw new NotFoundError('experiment version', exp.id);
  return latest;
}

export interface TransitionOptions {
  actor: Actor;
  reason: string;
  failureReasons?: FailureReason[];
  /** Pipeline transitions are refused for manual-only moves. */
  by?: 'PIPELINE' | 'USER';
  evaluation?: Record<string, unknown>;
}

/**
 * Move an experiment to a new status. The update is conditional on the
 * status not having changed since `from` was read (optimistic guard), so a
 * pipeline step that took minutes cannot overwrite a user's pause.
 */
export async function transition(ctx: PlatformContext, tx: DbOrTx, exp: Pick<ExperimentRow, 'id' | 'name' | 'status'>, to: ExperimentStatus, o: TransitionOptions): Promise<ExperimentRow> {
  const from = exp.status as ExperimentStatus;
  assertTransition(from, to, o.by ?? 'PIPELINE');
  const now = ctx.clock.now();
  const set: Partial<typeof experiments.$inferInsert> = { status: to, statusReason: o.reason.slice(0, 1000), updatedAt: now, lastActivityAt: now };
  if (o.failureReasons) set.failureReasons = o.failureReasons;
  if (o.evaluation) set.evaluation = o.evaluation;
  if (to === 'PAUSED') set.statusBeforePause = from;
  if (to === 'PAPER' && from === 'EVALUATING') set.paperStartedAt = now;
  if (to === 'FAILED' || to === 'ARCHIVED' || to === 'PAUSED') set.stoppedAt = now;
  if (to === 'PROBATION') set.probationCount = ((exp as ExperimentRow).probationCount ?? 0) + 1;
  if (to === 'RESEARCHING' && (from === 'FAILED' || from === 'ARCHIVED')) {
    set.failureReasons = [];
    set.stoppedAt = null;
  }
  const rows = await tx
    .update(experiments)
    .set(set)
    .where(and(eq(experiments.id, exp.id), eq(experiments.status, from)))
    .returning();
  if (rows.length !== 1) throw new ConflictError(`experiment ${exp.id} changed status concurrently (expected ${from})`);
  await audit(tx, o.actor, 'EXPERIMENT_STATUS_CHANGED', { type: 'experiment', id: exp.id, experimentId: exp.id }, { from, to, reason: o.reason, failureReasons: o.failureReasons ?? [] });
  // Leaving paper trading freezes the account (no automated orders); the risk hook also enforces this.
  if (PAPER_TRADING_STATUSES.includes(from) && !PAPER_TRADING_STATUSES.includes(to)) {
    await audit(tx, o.actor, 'STRATEGY_STOPPED', { type: 'experiment', id: exp.id, experimentId: exp.id }, { status: to });
  }
  if (!PAPER_TRADING_STATUSES.includes(from) && PAPER_TRADING_STATUSES.includes(to)) {
    await audit(tx, o.actor, 'STRATEGY_STARTED', { type: 'experiment', id: exp.id, experimentId: exp.id }, { status: to });
  }
  const msg = { experimentId: exp.id };
  if (to === 'FAILED') await notify(ctx, { ...msg, type: 'EXPERIMENT_FAILED', severity: 'WARNING', title: `${exp.name} → FAILED`, body: o.reason }, tx);
  else if (to === 'READY_FOR_LIVE_REVIEW') await notify(ctx, { ...msg, type: 'READY_FOR_LIVE_REVIEW', severity: 'SUCCESS', title: `${exp.name} is ready for manual live review`, body: 'All pre-defined paper criteria are met. Nothing has been enabled; live trading remains disabled.' }, tx);
  else if (to === 'PAPER' && from === 'EVALUATING') await notify(ctx, { ...msg, type: 'EXPERIMENT_STARTED', title: `${exp.name} started paper testing`, body: o.reason }, tx);
  else if (to === 'PROMISING') await notify(ctx, { ...msg, type: 'PAPER_MILESTONE', severity: 'SUCCESS', title: `${exp.name} → PROMISING`, body: o.reason }, tx);
  else if (to === 'ARCHIVED') await notify(ctx, { ...msg, type: 'EXPERIMENT_FINISHED', title: `${exp.name} archived`, body: o.reason }, tx);
  return rows[0]!;
}

export interface NewVersionInput {
  params?: Record<string, unknown>;
  assumptions?: Assumption[];
  changeNote: string;
  bump?: 'minor' | 'major';
  status?: 'ACTIVE' | 'CANDIDATE';
  parentVersionId?: string | null;
}

/** Create a new immutable version. ACTIVE versions supersede the current one. */
export async function createVersion(ctx: PlatformContext, experimentId: string, input: NewVersionInput, actor: Actor): Promise<VersionRow> {
  return ctx.db.transaction(async (tx) => {
    const [exp] = await tx.select().from(experiments).where(eq(experiments.id, experimentId)).for('update');
    if (!exp) throw new NotFoundError('experiment', experimentId);
    const base = await currentVersion(tx, exp);
    const params = ctx.registry.parseParams(exp.strategyId, { ...(base.params as Record<string, unknown>), ...(input.params ?? {}) });
    const assumptions = input.assumptions ?? (base.assumptions as Assumption[]);
    for (const a of assumptions) if (!(a.low <= a.mode && a.mode <= a.high)) throw new ValidationError(`assumption ${a.key}: low <= mode <= high violated`);
    const all = await tx.select({ label: experimentVersions.label, seq: experimentVersions.seq }).from(experimentVersions).where(eq(experimentVersions.experimentId, experimentId));
    const label = nextVersionLabel(all.map((v) => v.label), input.bump ?? 'minor');
    const seq = Math.max(0, ...all.map((v) => v.seq)) + 1;
    const status = input.status ?? 'ACTIVE';
    const [v] = await tx
      .insert(experimentVersions)
      .values({
        experimentId,
        seq,
        label,
        params,
        assumptions,
        strategyModuleVersion: ctx.registry.get(exp.strategyId).meta.version,
        parentVersionId: input.parentVersionId ?? base.id,
        createdBy: actor.id,
        changeNote: input.changeNote.slice(0, 1000),
        status,
      })
      .returning();
    if (status === 'ACTIVE') {
      await tx.update(experimentVersions).set({ status: 'SUPERSEDED' }).where(and(eq(experimentVersions.experimentId, experimentId), eq(experimentVersions.status, 'ACTIVE'), eq(experimentVersions.seq, base.seq)));
      await tx.update(experiments).set({ currentVersionId: v!.id, assumptions, updatedAt: new Date() }).where(eq(experiments.id, experimentId));
    }
    await audit(tx, actor, 'VERSION_CREATED', { type: 'experiment_version', id: v!.id, experimentId }, { label, status, changeNote: input.changeNote });
    if (input.params) await audit(tx, actor, 'PARAMETER_CHANGED', { type: 'experiment', id: experimentId, experimentId }, { from: base.label, to: label, params: input.params });
    return v!;
  });
}

/** Promote a CANDIDATE version (e.g. from the Strategy Lab) to ACTIVE; results restart from a backtest. */
export async function promoteVersion(ctx: PlatformContext, experimentId: string, versionId: string, actor: Actor): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [exp] = await tx.select().from(experiments).where(eq(experiments.id, experimentId)).for('update');
    if (!exp) throw new NotFoundError('experiment', experimentId);
    const [v] = await tx.select().from(experimentVersions).where(and(eq(experimentVersions.id, versionId), eq(experimentVersions.experimentId, experimentId)));
    if (!v) throw new NotFoundError('experiment version', versionId);
    if (v.status !== 'CANDIDATE') throw new ValidationError(`version ${v.label} is ${v.status}, not CANDIDATE`);
    await tx.update(experimentVersions).set({ status: 'SUPERSEDED' }).where(and(eq(experimentVersions.experimentId, experimentId), eq(experimentVersions.status, 'ACTIVE')));
    await tx.update(experimentVersions).set({ status: 'ACTIVE' }).where(eq(experimentVersions.id, versionId));
    await tx.update(experiments).set({ currentVersionId: versionId, assumptions: v.assumptions, updatedAt: new Date() }).where(eq(experiments.id, experimentId));
    // The old version's paper account belongs to the old parameters: close it.
    await tx.update(paperAccounts).set({ status: 'CLOSED' }).where(and(eq(paperAccounts.experimentId, experimentId), eq(paperAccounts.status, 'ACTIVE')));
    await audit(tx, actor, 'PARAMETER_CHANGED', { type: 'experiment', id: experimentId, experimentId }, { promoted: v.label });
    const status = exp.status as ExperimentStatus;
    const target: ExperimentStatus | null = status === 'PAPER' || status === 'PROMISING' || status === 'READY_FOR_LIVE_REVIEW' ? 'EVALUATING' : status === 'PROBATION' ? 'BACKTESTING' : null;
    if (target === 'EVALUATING') {
      // Re-evaluate from scratch: EVALUATING re-runs gates; the pipeline sends it back through BACKTESTING by clearing the evaluation.
      await transition(ctx, tx, exp, 'EVALUATING', { actor, reason: `version ${v.label} promoted; re-evaluating`, by: 'USER', evaluation: { needsBacktest: true } });
    } else if (target === 'BACKTESTING') {
      await transition(ctx, tx, exp, 'BACKTESTING', { actor, reason: `version ${v.label} promoted`, by: 'USER' });
    }
  });
}

export async function updateRiskLimits(ctx: PlatformContext, experimentId: string, limits: Partial<RiskLimits>, actor: Actor): Promise<RiskLimits> {
  return ctx.db.transaction(async (tx) => {
    const exp = await getExperiment(tx, experimentId);
    const next = validateRiskLimits({ ...(exp.riskLimits as unknown as RiskLimits), ...limits });
    await tx.update(experiments).set({ riskLimits: next as unknown as Record<string, number>, updatedAt: new Date() }).where(eq(experiments.id, experimentId));
    await audit(tx, actor, 'RISK_LIMITS_CHANGED', { type: 'experiment', id: experimentId, experimentId }, { before: exp.riskLimits, after: next });
    return next;
  });
}

export async function updateCompliance(ctx: PlatformContext, experimentId: string, item: ComplianceItem, state: ComplianceState, note: string, actor: Actor): Promise<ComplianceEntry[]> {
  return ctx.db.transaction(async (tx) => {
    const [exp] = await tx.select().from(experiments).where(eq(experiments.id, experimentId)).for('update');
    if (!exp) throw new NotFoundError('experiment', experimentId);
    const list = (exp.compliance as ComplianceEntry[]).slice();
    const entry: ComplianceEntry = { item, state, note: note.slice(0, 2000), reviewedAt: new Date().toISOString(), reviewer: actor.id };
    const i = list.findIndex((c) => c.item === item);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    await tx.update(experiments).set({ compliance: list, updatedAt: new Date() }).where(eq(experiments.id, experimentId));
    await audit(tx, actor, 'COMPLIANCE_UPDATED', { type: 'experiment', id: experimentId, experimentId }, { item, state, note });
    if (state === 'BLOCKER' && !['FAILED', 'ARCHIVED'].includes(exp.status)) {
      await transition(ctx, tx, exp, 'FAILED', { actor, by: 'USER', reason: `compliance blocker: ${item} — ${note}`, failureReasons: ['COMPLIANCE_BLOCKER'] });
    }
    return list;
  });
}

/** Pause, resume or archive on request of a human. */
export async function setStatusByUser(ctx: PlatformContext, experimentId: string, action: 'pause' | 'resume' | 'archive' | 'revive', reason: string, actor: Actor): Promise<ExperimentRow> {
  return ctx.db.transaction(async (tx) => {
    const [exp] = await tx.select().from(experiments).where(eq(experiments.id, experimentId)).for('update');
    if (!exp) throw new NotFoundError('experiment', experimentId);
    const status = exp.status as ExperimentStatus;
    let to: ExperimentStatus;
    if (action === 'pause') to = 'PAUSED';
    else if (action === 'archive') to = 'ARCHIVED';
    else if (action === 'revive') to = 'RESEARCHING';
    else {
      if (status !== 'PAUSED') throw new ValidationError(`only PAUSED experiments can be resumed (status ${status})`);
      const prev = (exp.statusBeforePause as ExperimentStatus | null) ?? 'RESEARCHING';
      to = prev === 'PAUSED' ? 'RESEARCHING' : prev;
    }
    return transition(ctx, tx, exp, to, { actor, by: 'USER', reason: reason || `${action} by user` });
  });
}

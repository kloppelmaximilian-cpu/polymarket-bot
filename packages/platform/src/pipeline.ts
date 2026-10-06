import { ConflictError, describeError, type ExperimentStatus, type FailureReason } from '@aoc/core';
import { experimentSources, experiments, paperAccounts, strategyRuns, type DbOrTx } from '@aoc/database';
import { DEFAULT_THRESHOLDS, PIPELINE_STATUSES, liveReviewGate, prePaperGate, promisingGate, rejectionReasons, type GateResult, type GateThresholds } from '@aoc/experiments';
import { complianceSummary } from '@aoc/research';
import type { ComplianceEntry, RiskLimits } from '@aoc/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { WORKER, recordError, recordEvent, type Actor } from './audit';
import type { PlatformContext } from './context';
import { buildEvidence } from './evidence';
import { runEvaluationSuite } from './evaluation';
import { currentVersion, getExperiment, transition, type ExperimentRow } from './experiments';
import { openPaperAccount } from './paper';
import { SETTING_KEYS, getSetting } from './settings';

/** How often a paper-testing experiment is re-evaluated against the gates. */
export const REVIEW_INTERVAL_MS = 6 * 3_600_000;

export interface StepResult {
  experimentId: string;
  from: ExperimentStatus;
  to: ExperimentStatus | null;
  note: string;
}

function gateSummary(g: GateResult): Record<string, unknown> {
  return { gate: g.gate, passed: g.passed, blocking: g.blocking, checks: g.checks };
}

async function thresholds(db: DbOrTx): Promise<Partial<GateThresholds>> {
  return getSetting<Partial<GateThresholds>>(db, SETTING_KEYS.gateThresholds, {});
}

/**
 * Advance one experiment by one lifecycle step. Every transition is
 * conditional on the status read at the start (see `transition`), so a
 * concurrent pause by a user wins over a slow pipeline step.
 */
export async function advanceExperiment(ctx: PlatformContext, experimentId: string, opts: { actor?: Actor; force?: boolean; keepAlive?: () => Promise<void> } = {}): Promise<StepResult> {
  const actor = opts.actor ?? WORKER;
  const exp = await getExperiment(ctx.db, experimentId);
  const from = exp.status as ExperimentStatus;
  const done = (to: ExperimentStatus | null, note: string): StepResult => ({ experimentId, from, to, note });
  if (!ctx.registry.has(exp.strategyId)) return done(null, `strategy module ${exp.strategyId} is not available in this build`);
  const m = ctx.registry.get(exp.strategyId);
  const version = await currentVersion(ctx.db, exp);
  const merged: GateThresholds = { ...DEFAULT_THRESHOLDS, ...(await thresholds(ctx.db)) };

  switch (from) {
    case 'DISCOVERED':
      return done(null, 'waiting for a human to start research');

    case 'RESEARCHING': {
      const compliance = exp.compliance as ComplianceEntry[];
      const summary = complianceSummary(compliance);
      const sources = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(experimentSources).where(eq(experimentSources.experimentId, exp.id));
      await ctx.db.insert(strategyRuns).values({
        experimentId: exp.id,
        versionId: version.id,
        runType: 'RESEARCH',
        provenance: 'HYPOTHETICAL',
        status: 'SUCCEEDED',
        config: {},
        summary: { hypothesis: exp.hypothesis, edgeRationale: m.meta.edgeRationale, knownRisks: m.meta.knownRisks, requiredData: exp.requiredData, sources: sources[0]?.n ?? 0, compliance: summary },
        result: {},
        startedAt: ctx.clock.now(),
        finishedAt: ctx.clock.now(),
      });
      if (summary.blockers > 0) {
        await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'FAILED', { actor, reason: 'compliance blocker found during research', failureReasons: ['COMPLIANCE_BLOCKER'] }));
        return done('FAILED', 'compliance blocker');
      }
      await ctx.db.transaction((tx) =>
        transition(ctx, tx, exp, 'PROTOTYPE', { actor, reason: `research checklist complete: ${sources[0]?.n ?? 0} sources, ${summary.unreviewed} compliance items still unreviewed (required before live review, not before paper testing)` }),
      );
      return done('PROTOTYPE', 'research complete');
    }

    case 'PROTOTYPE': {
      ctx.registry.parseParams(exp.strategyId, version.params);
      await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'BACKTESTING', { actor, reason: `prototype ready: ${m.meta.id}@${m.meta.version}, parameters ${version.label} validated` }));
      return done('BACKTESTING', 'prototype validated');
    }

    case 'BACKTESTING': {
      const prior = (exp.evaluation ?? {}) as Record<string, unknown>;
      const suite = await runEvaluationSuite(ctx, exp, version, { trials: (prior.labTrials as number | undefined) ?? 1, trialSharpeVariance: (prior.labTrialVariance as number | undefined) ?? 0, keepAlive: opts.keepAlive });
      const evaluation: Record<string, unknown> = {
        ...prior,
        needsBacktest: false,
        suiteAt: ctx.clock.now().toISOString(),
        provenance: suite.provenance,
        runIds: suite.runIds,
        ...(suite.kind === 'FINANCE' ? { dsr: suite.dsr, dataNotes: suite.dataNotes, realDataError: suite.realDataError } : {}),
      };
      await ctx.db.transaction((tx) =>
        transition(ctx, tx, exp, 'EVALUATING', {
          actor,
          reason: suite.kind === 'FINANCE' ? `backtest suite finished on ${suite.provenance === 'HISTORICAL' ? 'historical' : 'DEMO'} data (${suite.full.trades.length} trades)` : `Monte Carlo estimate finished (${suite.simulation.summary.runs} scenarios)`,
          evaluation,
        }),
      );
      return done('EVALUATING', 'evaluation suite complete');
    }

    case 'EVALUATING': {
      const evaluation = (exp.evaluation ?? {}) as Record<string, unknown>;
      if (evaluation.needsBacktest) {
        await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'BACKTESTING', { actor, reason: 'parameters changed: re-running the evaluation suite' }));
        return done('BACKTESTING', 're-test');
      }
      const ev = await buildEvidence(ctx, exp, version);
      const rej = rejectionReasons(ev.evaluation, merged);
      if (rej.reasons.length > 0) return fail(ctx, exp, rej.reasons, rej.details, actor).then(() => done('FAILED', rej.reasons.join(', ')));
      const gate = prePaperGate(ev.evaluation, merged);
      if (!gate.passed) {
        await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'PROBATION', { actor, reason: `not ready for paper testing: ${gate.blocking.join('; ')}`, evaluation: { ...evaluation, prePaper: gateSummary(gate) } }));
        return done('PROBATION', 'pre-paper gate not passed');
      }
      const opened = await ensurePaperAccount(ctx, exp, version.id, actor);
      if (!opened.ok) {
        await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'PROBATION', { actor, reason: `waiting for paper capital: ${opened.reason}`, evaluation: { ...evaluation, prePaper: gateSummary(gate) } }));
        return done('PROBATION', opened.reason);
      }
      const label = m.meta.kind === 'BUSINESS' ? 'simulated operation (SIMULATED, no real customers)' : 'paper trading on live data (virtual money)';
      await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'PAPER', { actor, reason: `pre-paper gate passed; starting ${label}`, evaluation: { ...evaluation, prePaper: gateSummary(gate) } }));
      return done('PAPER', 'paper test started');
    }

    case 'PAPER':
    case 'PROMISING':
    case 'READY_FOR_LIVE_REVIEW': {
      const last = exp.lastEvaluatedAt?.getTime() ?? 0;
      if (!opts.force && ctx.clock.now().getTime() - last < REVIEW_INTERVAL_MS) return done(null, 'next review not due yet');
      const ev = await buildEvidence(ctx, exp, version);
      const evaluation = { ...(exp.evaluation as Record<string, unknown>) };
      const rej = rejectionReasons(ev.evaluation, merged);
      if (rej.reasons.length > 0) return fail(ctx, exp, rej.reasons, rej.details, actor).then(() => done('FAILED', rej.reasons.join(', ')));
      const promising = promisingGate(ev.evaluation, merged);
      const live = liveReviewGate(ev.evaluation, merged);
      const nextEval = { ...evaluation, promising: gateSummary(promising), liveReview: gateSummary(live), reviewedAt: ctx.clock.now().toISOString() };
      if (from === 'PAPER' && promising.passed) {
        await ctx.db.transaction(async (tx) => {
          const e2 = await transition(ctx, tx, exp, 'EVALUATING', { actor, reason: 'paper review: PROMISING criteria met', evaluation: nextEval });
          await transition(ctx, tx, e2, 'PROMISING', { actor, reason: 'met every pre-defined PROMISING criterion under the tested assumptions' });
        });
        return done('PROMISING', 'promising gate passed');
      }
      if (from === 'PROMISING' && live.passed) {
        await ctx.db.transaction(async (tx) => {
          const e2 = await transition(ctx, tx, exp, 'EVALUATING', { actor, reason: 'paper review: live-review criteria met', evaluation: nextEval });
          await transition(ctx, tx, e2, 'READY_FOR_LIVE_REVIEW', { actor, reason: 'met every pre-defined criterion; awaiting manual review. Live trading remains disabled.' });
        });
        return done('READY_FOR_LIVE_REVIEW', 'live-review gate passed');
      }
      if ((from === 'PROMISING' || from === 'READY_FOR_LIVE_REVIEW') && !promising.passed) {
        await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'PROBATION', { actor, reason: `no longer meets PROMISING criteria: ${promising.blocking.join('; ')}`, evaluation: nextEval }));
        return done('PROBATION', 'regressed');
      }
      // Still collecting evidence: extend, or give up after two probation rounds without progress.
      const longEnough = m.meta.kind === 'BUSINESS' ? (ev.paper?.simulatedDays ?? 0) >= merged.businessPaperMinDays * 3 : (ev.paper?.days ?? 0) >= merged.paperMinDaysPromising * 4;
      if (from === 'PAPER' && longEnough) {
        if (exp.probationCount >= 2) {
          return fail(ctx, exp, ['NO_EDGE'], { NO_EDGE: `did not meet the PROMISING criteria after extended testing: ${promising.blocking.join('; ')}` }, actor).then(() => done('FAILED', 'no edge after extended testing'));
        }
        await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'PROBATION', { actor, reason: `extended testing: ${promising.blocking.join('; ')}`, evaluation: nextEval }));
        return done('PROBATION', 'extended testing');
      }
      await ctx.db.update(experiments).set({ lastEvaluatedAt: ctx.clock.now(), evaluation: nextEval }).where(and(eq(experiments.id, exp.id), eq(experiments.status, from)));
      return done(null, `reviewed: ${promising.passed ? 'promising' : `${promising.blocking.length} criteria outstanding`}`);
    }

    case 'PROBATION': {
      const evaluation = (exp.evaluation ?? {}) as Record<string, unknown>;
      // If the last suite ran on DEMO data, try again: real data may be reachable now.
      if (evaluation.provenance === 'DEMO' && evaluation.realDataError && m.meta.capabilities.requiresRealData) {
        const age = ctx.clock.now().getTime() - Date.parse(String(evaluation.suiteAt ?? 0));
        if (age > 24 * 3_600_000) {
          await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'BACKTESTING', { actor, reason: 'retrying the backtest with real data' }));
          return done('BACKTESTING', 'retry with real data');
        }
      }
      const opened = await ensurePaperAccount(ctx, exp, version.id, actor);
      if (!opened.ok) return done(null, `still waiting: ${opened.reason}`);
      await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'PAPER', { actor, reason: 'continuing paper testing (probation)' }));
      return done('PAPER', 'probation → paper');
    }

    default:
      return done(null, `no automatic step for ${from}`);
  }
}

async function fail(ctx: PlatformContext, exp: ExperimentRow, reasons: FailureReason[], details: Partial<Record<FailureReason, string>>, actor: Actor): Promise<void> {
  const text = reasons.map((r) => `${r}: ${details[r] ?? ''}`).join(' | ');
  await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'FAILED', { actor, reason: text, failureReasons: reasons, evaluation: { ...(exp.evaluation as Record<string, unknown>), rejection: details } }));
}

/** Open the experiment's paper account if it has none (idempotent). */
export async function ensurePaperAccount(ctx: PlatformContext, staleExp: ExperimentRow, versionId: string, actor: Actor): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await ctx.db.transaction(async (tx) => {
      const exp = await getExperiment(tx, staleExp.id);
      const [existing] = await tx.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.experimentId, exp.id), eq(paperAccounts.status, 'ACTIVE')));
      if (existing) return;
      const m = ctx.registry.get(exp.strategyId);
      const limits = exp.riskLimits as unknown as RiskLimits;
      await openPaperAccount(
        ctx,
        tx,
        {
          experimentId: exp.id,
          versionId,
          name: `${exp.name} — paper`,
          capital: Number(exp.paperCapital),
          maxCapital: limits.maxCapital,
          provenance: m.meta.kind === 'BUSINESS' ? 'SIMULATED' : 'PAPER',
          isDemo: exp.isDemo,
        },
        actor,
      );
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: describeError(e).message };
  }
}

/**
 * One pass over all experiments the pipeline is responsible for. Expensive
 * steps (backtests) are capped per pass so a pass stays short.
 */
export async function advanceAll(ctx: PlatformContext, opts: { maxBacktests?: number; keepAlive?: () => Promise<void> } = {}): Promise<StepResult[]> {
  const rows = await ctx.db
    .select({ id: experiments.id, status: experiments.status })
    .from(experiments)
    .where(inArray(experiments.status, [...PIPELINE_STATUSES]))
    .orderBy(asc(experiments.lastActivityAt));
  const results: StepResult[] = [];
  let backtests = 0;
  for (const r of rows) {
    if (r.status === 'BACKTESTING') {
      if (backtests >= (opts.maxBacktests ?? 3)) continue;
      backtests++;
    }
    try {
      results.push(await advanceExperiment(ctx, r.id, { keepAlive: opts.keepAlive }));
      await opts.keepAlive?.();
    } catch (e) {
      if (e instanceof ConflictError) {
        results.push({ experimentId: r.id, from: r.status as ExperimentStatus, to: null, note: `skipped: ${e.message}` });
        continue;
      }
      await recordError(ctx.db, 'pipeline', e, { step: r.status }, r.id);
      await recordEvent(ctx.db, 'WARN', 'pipeline', 'STEP_FAILED', `pipeline step ${r.status} failed: ${describeError(e).message}`, {}, r.id);
      results.push({ experimentId: r.id, from: r.status as ExperimentStatus, to: null, note: `error: ${describeError(e).message}` });
    }
  }
  return results;
}

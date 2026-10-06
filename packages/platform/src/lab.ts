import { ValidationError, kurtosis, skewness } from '@aoc/core';
import { periodReturns, periodSharpe } from '@aoc/backtest';
import { experiments, strategyRuns } from '@aoc/database';
import { proposeVariants, selectVariant, type LabRecommendation, type VariantResult } from '@aoc/experiments';
import { eq } from 'drizzle-orm';
import { audit, type Actor } from './audit';
import type { PlatformContext } from './context';
import { acquireData } from './data';
import { createVersion, currentVersion, getExperiment } from './experiments';
import { notify } from './notifications';

/**
 * Strategy Lab: try the pre-registered neighbours of the current version on
 * the training period, pick the best by training Sharpe, and report how it
 * does out of sample. A variant is only proposed (as a CANDIDATE version)
 * when it survives the deflated-Sharpe test for every variant tried so far.
 * Nothing is promoted automatically.
 */
export async function runLab(ctx: PlatformContext, experimentId: string, actor: Actor, maxVariants = 8): Promise<LabRecommendation & { candidateVersionId: string | null }> {
  const exp = await getExperiment(ctx.db, experimentId);
  const m = ctx.registry.get(exp.strategyId);
  if (!m.backtest) throw new ValidationError('the Strategy Lab needs a backtestable strategy');
  if (Object.keys(m.meta.paramSpace).length === 0) throw new ValidationError('this module has no registered parameter space');
  const version = await currentVersion(ctx.db, exp);
  const base = version.params as Record<string, unknown>;
  const seed = `${exp.id}/lab/${version.label}`;
  const data = await acquireData(ctx, m, base, seed);
  const capital = Number(exp.paperCapital);
  const full = m.backtest({ params: base, data: data.bundle, initialCapital: capital, seed });
  const boundary = Math.round(full.startTs + (full.endTs - full.startTs) * 0.7);

  const evaluate = (params: Record<string, unknown>): VariantResult => {
    const p = ctx.registry.parseParams(exp.strategyId, params);
    const train = m.backtest!({ params: p, data: data.bundle, initialCapital: capital, seed, window: { startTs: full.startTs, endTs: boundary } });
    const test = m.backtest!({ params: p, data: data.bundle, initialCapital: capital, seed, window: { startTs: boundary, endTs: full.endTs + 1 } });
    const rets = periodReturns(train.equityCurve);
    return {
      params: p,
      trainSharpe: periodSharpe(train.equityCurve),
      trainNetReturn: train.metrics.totalReturnPct ?? 0,
      testNetReturn: test.metrics.totalReturnPct ?? 0,
      testTrades: test.trades.length,
      testSharpe: test.metrics.sharpe,
      trainPeriods: rets.length,
      trainSkew: skewness(rets),
      trainKurtosis: kurtosis(rets),
    };
  };

  const baseline = evaluate(base);
  const variants = proposeVariants(base, m.meta.paramSpace, maxVariants).map(evaluate);
  const prior = (exp.evaluation ?? {}) as Record<string, unknown>;
  const totalTrials = ((prior.labTrials as number | undefined) ?? 1) + variants.length;
  const rec = selectVariant(baseline, variants);
  const sharpes = [baseline, ...variants].map((v) => v.trainSharpe).filter(Number.isFinite);
  const mean = sharpes.reduce((a, b) => a + b, 0) / Math.max(1, sharpes.length);
  const variance = sharpes.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, sharpes.length - 1);

  let candidateVersionId: string | null = null;
  if (rec.recommend && rec.best) {
    const changed = Object.fromEntries(Object.entries(rec.best.params).filter(([k, v]) => JSON.stringify(base[k]) !== JSON.stringify(v)));
    const v = await createVersion(
      ctx,
      exp.id,
      { params: changed, status: 'CANDIDATE', changeNote: `Strategy Lab candidate: out-of-sample return ${(rec.best.testNetReturn * 100).toFixed(2)}% vs ${(baseline.testNetReturn * 100).toFixed(2)}%; deflated Sharpe ${rec.dsr?.toFixed(2)} over ${totalTrials} trials. Needs review before promotion.` },
      actor,
    );
    candidateVersionId = v.id;
    await notify(ctx, { type: 'STRATEGY_IMPROVED', severity: 'SUCCESS', experimentId: exp.id, title: `${exp.name}: Strategy Lab proposed ${v.label}`, body: 'Candidate version created for review; nothing was promoted automatically.' });
  }
  await ctx.db.insert(strategyRuns).values({
    experimentId: exp.id,
    versionId: version.id,
    runType: 'LAB',
    provenance: data.bundle.provenance === 'HISTORICAL' ? 'HISTORICAL' : 'DEMO',
    status: 'SUCCEEDED',
    seed,
    config: { base, maxVariants, splitAt: boundary, data: data.bundle.label },
    summary: { recommend: rec.recommend, reasons: rec.reasons, dsr: rec.dsr, trials: rec.trials, totalTrials, candidateVersionId },
    result: { baseline, variants },
    startedAt: ctx.clock.now(),
    finishedAt: ctx.clock.now(),
  });
  await ctx.db
    .update(experiments)
    .set({ evaluation: { ...prior, labTrials: totalTrials, labTrialVariance: Number.isFinite(variance) ? variance : 0, labAt: ctx.clock.now().toISOString() } })
    .where(eq(experiments.id, exp.id));
  await audit(ctx.db, actor, 'STRATEGY_STARTED', { type: 'lab', id: exp.id, experimentId: exp.id }, { lab: true, variants: variants.length, recommend: rec.recommend });
  return { ...rec, candidateVersionId };
}

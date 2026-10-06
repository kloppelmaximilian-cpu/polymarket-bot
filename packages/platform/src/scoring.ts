import type { ExperimentStatus } from '@aoc/core';
import { experiments, scores, type DbOrTx } from '@aoc/database';
import { computeScore, rank, type ComponentKey, type ScoreResult } from '@aoc/scoring';
import { desc, eq, ne, sql } from 'drizzle-orm';
import { SYSTEM, audit, recordError } from './audit';
import type { PlatformContext } from './context';
import { buildEvidence } from './evidence';
import { currentVersion, type ExperimentRow } from './experiments';
import { SETTING_KEYS, getSetting } from './settings';

export async function scoreExperiment(ctx: PlatformContext, exp: ExperimentRow): Promise<ScoreResult> {
  const version = await currentVersion(ctx.db, exp);
  const ev = await buildEvidence(ctx, exp, version);
  const weights = await getSetting<Partial<Record<ComponentKey, number>>>(ctx.db, SETTING_KEYS.scoringWeights, {});
  return computeScore({ ...ev.scoring, weights });
}

/** Recompute every score, store changes, and rank. ARCHIVED experiments are not ranked. */
export async function scoreAll(ctx: PlatformContext): Promise<{ scored: number; changed: number }> {
  const rows = await ctx.db.select().from(experiments).where(ne(experiments.status, 'ARCHIVED'));
  const results: Array<{ exp: ExperimentRow; score: ScoreResult; versionId: string }> = [];
  for (const exp of rows) {
    try {
      const version = await currentVersion(ctx.db, exp);
      results.push({ exp, score: await scoreExperiment(ctx, exp), versionId: version.id });
    } catch (e) {
      await recordError(ctx.db, 'scoring', e, {}, exp.id);
    }
  }
  const ranked = rank(results);
  let changed = 0;
  for (const r of ranked) {
    const [prev] = await ctx.db.select().from(scores).where(eq(scores.experimentId, r.exp.id)).orderBy(desc(scores.computedAt)).limit(1);
    const same = prev && Math.abs(prev.overall - r.score.overall) < 0.05 && prev.confidence === r.score.confidence && prev.rank === r.rank && JSON.stringify(prev.components) === JSON.stringify(r.score.components);
    if (same) continue;
    changed++;
    await ctx.db.insert(scores).values({
      experimentId: r.exp.id,
      versionId: r.versionId,
      overall: r.score.overall,
      components: r.score.components,
      confidence: r.score.confidence,
      evidence: r.score.evidence,
      rank: r.rank,
      explanation: { caps: r.score.caps, explanation: r.score.explanation, riskMultiplier: r.score.riskMultiplier },
    });
    if (!prev || Math.abs(prev.overall - r.score.overall) >= 1) {
      await audit(ctx.db, SYSTEM, 'SCORE_CHANGED', { type: 'experiment', id: r.exp.id, experimentId: r.exp.id }, { from: prev?.overall ?? null, to: r.score.overall, confidence: r.score.confidence, rank: r.rank });
    }
  }
  return { scored: ranked.length, changed };
}

/** Latest score per experiment (one query). */
export async function latestScores(db: DbOrTx): Promise<Map<string, typeof scores.$inferSelect>> {
  const rows = await db.execute(sql`SELECT DISTINCT ON (experiment_id) * FROM scores ORDER BY experiment_id, computed_at DESC`);
  const out = new Map<string, typeof scores.$inferSelect>();
  for (const r of (rows as unknown as { rows: Record<string, unknown>[] }).rows) {
    out.set(String(r.experiment_id), {
      id: Number(r.id),
      experimentId: String(r.experiment_id),
      versionId: (r.version_id as string | null) ?? null,
      overall: Number(r.overall),
      components: (typeof r.components === 'string' ? JSON.parse(r.components) : r.components) as Record<string, number | null>,
      confidence: String(r.confidence),
      evidence: String(r.evidence),
      rank: r.rank === null ? null : Number(r.rank),
      explanation: (typeof r.explanation === 'string' ? JSON.parse(r.explanation) : r.explanation) as Record<string, unknown>,
      computedAt: new Date(r.computed_at as string),
    });
  }
  return out;
}

export function isActive(status: string): boolean {
  return !['ARCHIVED', 'FAILED', 'PAUSED', 'DISCOVERED'].includes(status as ExperimentStatus);
}


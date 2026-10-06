import type { AppConfig } from '@aoc/core';
import { JobQueue, type JobDefinition, type ScheduleEntry } from '@aoc/jobs';
import { pruneSnapshots, syncDataSources } from './data';
import { WORKER } from './audit';
import type { PlatformContext } from './context';
import { runLab } from './lab';
import { advanceAll, advanceExperiment } from './pipeline';
import { paperTickAll, riskMonitorAll } from './paper-runner';
import { generateIdeas, runMonitor, triageIdeas } from './research-service';
import { scoreAll } from './scoring';
import { deliverPendingNotifications } from './notifications';
import { experiments } from '@aoc/database';
import { and, inArray } from 'drizzle-orm';
import type { IdeaFocus } from '@aoc/research';

export const JOB_NAMES = ['pipeline.advance', 'paper.tick', 'risk.monitor', 'scores.recompute', 'data.health', 'research.monitor', 'ideas.generate', 'lab.run', 'maintenance.prune', 'notifications.deliver'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/**
 * Job handlers. "haltable" jobs are the ones that act (advance experiments,
 * trade on paper, run the lab); they do not run while the emergency stop is
 * engaged. Monitoring, scoring and data-health jobs keep running.
 */
export function buildJobs(ctx: PlatformContext): Record<JobName, JobDefinition> {
  return {
    'pipeline.advance': {
      haltable: true,
      handler: async ({ job, keepAlive }) => {
        const id = job.payload.experimentId as string | undefined;
        if (id) return { step: await advanceExperiment(ctx, id, { force: !!job.payload.force, keepAlive }) };
        const steps = await advanceAll(ctx, { keepAlive });
        return { steps: steps.filter((s) => s.to !== null || s.note.startsWith('error')).length, moved: steps.filter((s) => s.to).map((s) => `${s.from}→${s.to}`) };
      },
    },
    'paper.tick': {
      haltable: true,
      handler: async ({ keepAlive }) => {
        const ticks = await paperTickAll(ctx, keepAlive);
        return { experiments: ticks.length, ok: ticks.filter((t) => t.ok).length, problems: ticks.filter((t) => !t.ok).map((t) => t.note).slice(0, 5) };
      },
    },
    'risk.monitor': { haltable: false, handler: async () => riskMonitorAll(ctx) },
    'scores.recompute': { haltable: false, handler: async () => scoreAll(ctx) },
    'data.health': {
      haltable: false,
      handler: async ({ job }) => {
        const probe = job.payload.probe ? await ctx.marketData.probe() : null;
        await syncDataSources(ctx);
        return { probe };
      },
    },
    'research.monitor': { haltable: false, handler: async () => runMonitor(ctx, WORKER) },
    'ideas.generate': {
      haltable: false,
      handler: async ({ job }) => {
        const gen = await generateIdeas(ctx, { focus: (job.payload.focus as IdeaFocus | undefined) ?? 'any', count: Number(job.payload.count ?? 10) }, WORKER);
        const triage = await triageIdeas(ctx, WORKER, Number(job.payload.maxConvert ?? 2));
        return { ...gen, ...triage };
      },
    },
    'lab.run': {
      haltable: true,
      handler: async ({ job }) => {
        let id = job.payload.experimentId as string | undefined;
        if (!id) {
          const candidates = await ctx.db
            .select({ id: experiments.id, strategyId: experiments.strategyId })
            .from(experiments)
            .where(and(inArray(experiments.status, ['PAPER', 'PROMISING', 'PROBATION']), inArray(experiments.kind, ['TRADING', 'ARBITRAGE', 'PREDICTION_MARKET'])));
          const withSpace = candidates.filter((c) => ctx.registry.has(c.strategyId) && Object.keys(ctx.registry.get(c.strategyId).meta.paramSpace).length > 0);
          if (withSpace.length === 0) return { skipped: 'no experiment eligible for the Strategy Lab' };
          id = withSpace[Math.floor(Date.now() / 86_400_000) % withSpace.length]!.id;
        }
        const r = await runLab(ctx, id, WORKER);
        return { experimentId: id, recommend: r.recommend, reasons: r.reasons, candidateVersionId: r.candidateVersionId };
      },
    },
    'notifications.deliver': { haltable: false, handler: async () => deliverPendingNotifications(ctx) },
    'maintenance.prune': {
      haltable: false,
      handler: async () => {
        const q = new JobQueue(ctx.db, { workerId: 'maintenance', leaseMs: 60_000 });
        return { jobs: await q.prune(14), snapshots: await pruneSnapshots(ctx, 30) };
      },
    },
  };
}

export function buildSchedule(cfg: AppConfig): ScheduleEntry[] {
  const out: ScheduleEntry[] = [
    { name: 'pipeline.advance', everyMs: 60_000, priority: 50 },
    { name: 'paper.tick', everyMs: cfg.PAPER_TICK_SECONDS * 1000, priority: 20 },
    { name: 'risk.monitor', everyMs: 60_000, priority: 10 },
    { name: 'scores.recompute', everyMs: 5 * 60_000, priority: 80 },
    { name: 'data.health', everyMs: 60_000, priority: 30 },
    { name: 'data.health', everyMs: 15 * 60_000, payload: { probe: true }, priority: 60 },
    { name: 'ideas.generate', everyMs: 24 * 3_600_000, payload: { focus: 'any', count: 10 }, priority: 120 },
    { name: 'lab.run', everyMs: 24 * 3_600_000, priority: 150 },
    { name: 'maintenance.prune', everyMs: 24 * 3_600_000, priority: 200 },
  ];
  if (cfg.NOTIFY_WEBHOOK_URL) out.push({ name: 'notifications.deliver', everyMs: 30_000, priority: 40 });
  if (cfg.RESEARCH_MONITOR_ENABLED) out.push({ name: 'research.monitor', everyMs: 12 * 3_600_000, priority: 120 });
  return out;
}


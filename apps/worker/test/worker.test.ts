import { loadConfig, newId, silentLogger } from '@aoc/core';
import { createTestDatabase, jobRuns, workerHeartbeats, type DatabaseHandle } from '@aoc/database';
import { JobQueue } from '@aoc/jobs';
import { SYSTEM, buildJobs, buildSchedule, createContext, engageEmergencyStop, releaseEmergencyStop, seed, startBackground, type PlatformContext } from '@aoc/platform';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let h: DatabaseHandle;
let ctx: PlatformContext;
let queue: JobQueue;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  h = await createTestDatabase();
  const config = loadConfig({ DATABASE_URL: 'memory://', MARKET_DATA_ENABLED: 'false', RESEARCH_MONITOR_ENABLED: 'false', WORKER_POLL_MS: '100', SCHEDULER_ENABLED: 'false' });
  ctx = createContext({ db: h.db, config, logger: silentLogger(), fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch });
  queue = new JobQueue(h.db, { workerId: 'test-worker', leaseMs: 60_000 });
  await seed(ctx);
}, 120_000);

afterAll(async () => h?.close());

describe('background worker', () => {
  it('runs queued jobs, records results and heartbeats, and stops cleanly', async () => {
    const bg = await startBackground({ ctx, queue, config: ctx.config, logger: ctx.logger });
    try {
      const { id } = await queue.enqueue('pipeline.advance', {}, { dedupeKey: 'test:advance:1' });
      const done = await waitFor(async () => {
        const [row] = await h.db.select().from(jobRuns).where(eq(jobRuns.id, id!));
        return row && ['SUCCEEDED', 'FAILED', 'DEAD'].includes(row.status) ? row : null;
      }, 60_000);
      expect(done.status, done.lastError ?? '').toBe('SUCCEEDED');
      expect(done.result).toHaveProperty('moved');
      const beats = await h.db.select().from(workerHeartbeats);
      expect(beats.some((b) => b.status === 'RUNNING')).toBe(true);
    } finally {
      await bg.stop();
    }
    const beats = await h.db.select().from(workerHeartbeats);
    expect(beats.every((b) => b.status === 'STOPPED')).toBe(true);
  }, 90_000);

  it('does not run acting jobs while the emergency stop is engaged, but keeps monitoring', async () => {
    await engageEmergencyStop(ctx, 'worker test', SYSTEM);
    const bg = await startBackground({ ctx, queue, config: ctx.config, logger: ctx.logger });
    try {
      const tick = await queue.enqueue('paper.tick', {}, { dedupeKey: 'test:tick:halted' });
      const risk = await queue.enqueue('risk.monitor', {}, { dedupeKey: 'test:risk:halted' });
      await waitFor(async () => {
        const [row] = await h.db.select().from(jobRuns).where(eq(jobRuns.id, risk.id!));
        return row?.status === 'SUCCEEDED';
      });
      await new Promise((r) => setTimeout(r, 500));
      const [halted] = await h.db.select().from(jobRuns).where(eq(jobRuns.id, tick.id!));
      expect(halted!.status).toBe('QUEUED');
      await releaseEmergencyStop(ctx, 'worker test done', SYSTEM);
      await waitFor(async () => {
        const [row] = await h.db.select().from(jobRuns).where(eq(jobRuns.id, tick.id!));
        return row?.status === 'SUCCEEDED';
      });
    } finally {
      await bg.stop();
    }
  }, 90_000);
});

describe('scheduled runs of external-API jobs', () => {
  const run = (payload: Record<string, unknown>) =>
    buildJobs(ctx)['research.monitor'].handler({ job: { id: newId(), name: 'research.monitor', dedupeKey: null, payload, status: 'RUNNING', attempts: 1, maxAttempts: 1, runAt: new Date(), lockedBy: 't', lockedUntil: null }, keepAlive: async () => undefined, log: ctx.logger });

  it('skips a scheduled run shortly after a real one, never a manual run', async () => {
    await h.db.delete(jobRuns).where(eq(jobRuns.name, 'research.monitor'));
    // No earlier run: the scheduled run goes ahead.
    expect(await run({ scheduled: true })).not.toHaveProperty('skipped');
    // A run that finished an hour ago: the next scheduled run is skipped …
    await h.db.insert(jobRuns).values({ name: 'research.monitor', status: 'SUCCEEDED', finishedAt: new Date(Date.now() - 3_600_000), result: { found: 3 } });
    expect(await run({ scheduled: true })).toHaveProperty('skipped');
    // … a manual run is not.
    expect(await run({})).not.toHaveProperty('skipped');
    // Skipped runs do not count as runs, and a run seven hours ago is old enough.
    await h.db.delete(jobRuns).where(eq(jobRuns.name, 'research.monitor'));
    await h.db.insert(jobRuns).values([
      { name: 'research.monitor', status: 'SUCCEEDED', finishedAt: new Date(Date.now() - 60_000), result: { skipped: 'x' } },
      { name: 'research.monitor', status: 'SUCCEEDED', finishedAt: new Date(Date.now() - 7 * 3_600_000), result: { found: 1 } },
    ]);
    expect(await run({ scheduled: true })).not.toHaveProperty('skipped');
  });

  it('marks the long-interval schedule entries as scheduled', () => {
    const entries = buildSchedule(loadConfig({ DATABASE_URL: 'memory://', RESEARCH_MONITOR_ENABLED: 'true' }));
    for (const name of ['research.monitor', 'ideas.generate']) expect(entries.find((e) => e.name === name)?.payload?.scheduled, name).toBe(true);
  });
});


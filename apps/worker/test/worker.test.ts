import { loadConfig, newId, silentLogger } from '@aoc/core';
import { createTestDatabase, dataSources, jobRuns, workerHeartbeats, type DatabaseHandle } from '@aoc/database';
import { JobQueue } from '@aoc/jobs';
import { SYSTEM, buildJobs, buildSchedule, createContext, engageEmergencyStop, releaseEmergencyStop, seed, startBackground, syncDataSources, systemHealth, type PlatformContext } from '@aoc/platform';
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

  it('skips a scheduled run shortly after a real one or while one is running, never a manual run', async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    await h.db.delete(jobRuns).where(eq(jobRuns.name, 'research.monitor'));
    // No earlier run: the scheduled run goes ahead.
    expect(await run({ scheduled: true })).not.toHaveProperty('skipped');
    // A run that finished ten minutes ago: the next scheduled run is skipped …
    await h.db.insert(jobRuns).values({ name: 'research.monitor', status: 'SUCCEEDED', finishedAt: minutesAgo(10), result: { found: 3 } });
    expect(await run({ scheduled: true })).toMatchObject({ skipped: expect.stringMatching(/less than 1 h/) });
    // … a manual run is not.
    expect(await run({})).not.toHaveProperty('skipped');
    // Skipped runs do not count as runs, and a run two hours ago is old enough (the 12 h cadence stays intact).
    await h.db.delete(jobRuns).where(eq(jobRuns.name, 'research.monitor'));
    await h.db.insert(jobRuns).values([
      { name: 'research.monitor', status: 'SUCCEEDED', finishedAt: minutesAgo(1), result: { skipped: 'x' } },
      { name: 'research.monitor', status: 'SUCCEEDED', finishedAt: minutesAgo(120), result: { found: 1 } },
    ]);
    expect(await run({ scheduled: true })).not.toHaveProperty('skipped');
    // A run still in progress (valid lease) blocks a second scheduled run; an abandoned one (lease expired) does not.
    await h.db.delete(jobRuns).where(eq(jobRuns.name, 'research.monitor'));
    await h.db.insert(jobRuns).values({ name: 'research.monitor', status: 'RUNNING', lockedUntil: new Date(Date.now() + 60_000) });
    expect(await run({ scheduled: true })).toMatchObject({ skipped: expect.stringMatching(/in progress/) });
    await h.db.update(jobRuns).set({ lockedUntil: minutesAgo(1) }).where(eq(jobRuns.name, 'research.monitor'));
    expect(await run({ scheduled: true })).not.toHaveProperty('skipped');
  });

  it('does not show a skipped run as the research agent\'s last run', async () => {
    const monitorCtx = createContext({ db: h.db, config: loadConfig({ DATABASE_URL: 'memory://', MARKET_DATA_ENABLED: 'false', RESEARCH_MONITOR_ENABLED: 'true' }), logger: silentLogger() });
    await h.db.delete(jobRuns).where(eq(jobRuns.name, 'research.monitor'));
    const real = new Date(Date.now() - 3 * 3_600_000);
    await h.db.insert(jobRuns).values([
      { name: 'research.monitor', status: 'SUCCEEDED', finishedAt: real, result: { found: 2 } },
      { name: 'research.monitor', status: 'SUCCEEDED', finishedAt: new Date(), result: { skipped: 'recent run' } },
    ]);
    const agent = (await systemHealth(monitorCtx)).components.find((c) => c.component === 'Research Agent')!;
    expect(agent.detail).toContain(real.toISOString());
  });

  it('marks the long-interval schedule entries as scheduled', () => {
    const entries = buildSchedule(loadConfig({ DATABASE_URL: 'memory://', RESEARCH_MONITOR_ENABLED: 'true' }));
    for (const name of ['research.monitor', 'ideas.generate']) expect(entries.find((e) => e.name === name)?.payload?.scheduled, name).toBe(true);
  });
});

describe('data-source table', () => {
  const ctxWith = (env: Record<string, string>) => createContext({ db: h.db, config: loadConfig({ DATABASE_URL: 'memory://', RESEARCH_MONITOR_ENABLED: 'false', ...env }), logger: silentLogger() });
  const wsRow = async () => (await h.db.select().from(dataSources).where(eq(dataSources.id, 'binance.spot.ws')))[0]!;

  it('marks the websocket as disabled when websockets are switched off', async () => {
    await syncDataSources(ctxWith({ MARKET_DATA_ENABLED: 'true', MARKET_DATA_WEBSOCKETS: 'false' }));
    const row = await wsRow();
    expect(row.enabled).toBe(false);
    expect((row.meta as { disabledReason: string }).disabledReason).toMatch(/MARKET_DATA_WEBSOCKETS=false/);
  });

  it('leaves the websocket row to the process that runs the stream', async () => {
    await h.db.update(dataSources).set({ status: 'CONNECTED', enabled: true }).where(eq(dataSources.id, 'binance.spot.ws'));
    // A process without a stream (e.g. the CLI) must not recompute it from stale timestamps.
    await syncDataSources(ctxWith({ MARKET_DATA_ENABLED: 'true', MARKET_DATA_WEBSOCKETS: 'true' }));
    expect((await wsRow()).status).toBe('CONNECTED');
  });
});


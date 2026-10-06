import { ManualClock, ValidationError, silentLogger } from '@aoc/core';
import { createTestDatabase, jobRuns, type DatabaseHandle } from '@aoc/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobQueue, Scheduler, Worker } from '../src';

let h: DatabaseHandle;
const clock = new ManualClock('2026-05-01T12:00:00Z');
beforeAll(async () => {
  h = await createTestDatabase();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.db.delete(jobRuns);
});

describe('job queue', () => {
  it('never enqueues a duplicate dedupe key', async () => {
    const q = new JobQueue(h.db, { workerId: 'w1', leaseMs: 60_000, clock });
    expect((await q.enqueue('a', {}, { dedupeKey: 'a:1' })).created).toBe(true);
    expect((await q.enqueue('a', {}, { dedupeKey: 'a:1' })).created).toBe(false);
    expect(await h.db.select().from(jobRuns)).toHaveLength(1);
  });

  it('lets only one worker claim a job', async () => {
    const q1 = new JobQueue(h.db, { workerId: 'w1', leaseMs: 60_000, clock });
    const q2 = new JobQueue(h.db, { workerId: 'w2', leaseMs: 60_000, clock });
    await q1.enqueue('a');
    const [c1, c2] = await Promise.all([q1.claim(), q2.claim()]);
    expect([c1, c2].filter(Boolean)).toHaveLength(1);
  });

  it('respects run_at and priority', async () => {
    const q = new JobQueue(h.db, { workerId: 'w1', leaseMs: 60_000, clock });
    await q.enqueue('later', {}, { runAt: new Date(clock.now().getTime() + 60_000) });
    await q.enqueue('low', {}, { priority: 200 });
    await q.enqueue('high', {}, { priority: 10 });
    expect((await q.claim())!.name).toBe('high');
    expect((await q.claim())!.name).toBe('low');
    expect(await q.claim()).toBeNull();
    clock.advance(61_000);
    expect((await q.claim())!.name).toBe('later');
    clock.set('2026-05-01T12:00:00Z');
  });

  it('reclaims jobs from a crashed worker and gives up after max attempts', async () => {
    const q = new JobQueue(h.db, { workerId: 'w1', leaseMs: 1_000, clock });
    await q.enqueue('crashy', {}, { maxAttempts: 2 });
    const first = await q.claim();
    expect(first!.attempts).toBe(1);
    clock.advance(2_000);
    expect(await q.reclaimExpired()).toEqual({ requeued: 1, dead: 0 });
    const second = await q.claim();
    expect(second!.attempts).toBe(2);
    clock.advance(2_000);
    expect(await q.reclaimExpired()).toEqual({ requeued: 0, dead: 1 });
    // The crashed worker cannot complete a job it no longer holds.
    expect(await q.complete(first!)).toBe(false);
    clock.set('2026-05-01T12:00:00Z');
  });

  it('retries retryable failures with backoff and fails validation errors immediately', async () => {
    const q = new JobQueue(h.db, { workerId: 'w1', leaseMs: 60_000, clock });
    await q.enqueue('flaky', {}, { maxAttempts: 3 });
    const j = await q.claim();
    expect(await q.fail(j!, new Error('transient'))).toBe('QUEUED');
    const [row] = await h.db.select().from(jobRuns).where(eq(jobRuns.id, j!.id));
    expect(row!.runAt.getTime()).toBeGreaterThan(clock.now().getTime());
    await q.enqueue('bad');
    const b = await q.claim(['bad']);
    expect(await q.fail(b!, new ValidationError('nope'))).toBe('FAILED');
  });
});

describe('worker and scheduler', () => {
  it('runs handlers, records failures and respects the emergency stop for haltable jobs', async () => {
    const q = new JobQueue(h.db, { workerId: 'w1', leaseMs: 60_000, clock });
    const ran: string[] = [];
    let halted = true;
    const w = new Worker(
      q,
      {
        trade: { haltable: true, handler: async () => void ran.push('trade') },
        health: { haltable: false, handler: async () => void ran.push('health') },
        boom: { haltable: false, handler: async () => { throw new ValidationError('bad payload'); } },
      },
      { concurrency: 1, pollMs: 10, logger: silentLogger(), isHalted: async () => halted },
    );
    await q.enqueue('trade');
    await q.enqueue('health');
    while (await w.runOnce(true));
    expect(ran).toEqual(['health']);
    halted = false;
    while (await w.runOnce(true));
    expect(ran).toEqual(['health', 'trade']);
    await q.enqueue('boom');
    while (await w.runOnce(true));
    const [boom] = await h.db.select().from(jobRuns).where(eq(jobRuns.name, 'boom'));
    expect(boom!.status).toBe('FAILED');
    expect(boom!.lastError).toMatch(/bad payload/);
    expect(w.stats().failed).toBe(1);
  });

  it('schedules each period exactly once, even with two schedulers', async () => {
    const q = new JobQueue(h.db, { workerId: 'w1', leaseMs: 60_000, clock });
    const s1 = new Scheduler(q, [{ name: 'tick', everyMs: 60_000 }], silentLogger());
    const s2 = new Scheduler(q, [{ name: 'tick', everyMs: 60_000 }], silentLogger());
    const t = new Date('2026-05-01T12:00:30Z');
    expect(await s1.tick(t)).toBe(1);
    expect(await s2.tick(t)).toBe(0);
    expect(await s1.tick(new Date('2026-05-01T12:01:01Z'))).toBe(1);
    expect(await h.db.select().from(jobRuns)).toHaveLength(2);
  });
});

import { describeError, isRetryable, systemClock, type Clock } from '@aoc/core';
import { jobRuns, rowsOf, workerHeartbeats, type Database } from '@aoc/database';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD' | 'CANCELLED';

export interface JobRow {
  id: string;
  name: string;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
}

export interface EnqueueOptions {
  /** Unique key: a second enqueue with the same key is a no-op (duplicate-job guard). */
  dedupeKey?: string;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
}

function rowToJob(r: Record<string, unknown>): JobRow {
  return {
    id: String(r.id),
    name: String(r.name),
    dedupeKey: (r.dedupe_key as string | null) ?? null,
    payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
    status: r.status as JobStatus,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    runAt: new Date(r.run_at as string),
    lockedBy: (r.locked_by as string | null) ?? null,
    lockedUntil: r.locked_until ? new Date(r.locked_until as string) : null,
  };
}

/**
 * A job queue on PostgreSQL:
 *  - duplicate jobs are impossible (unique dedupe_key, ON CONFLICT DO NOTHING)
 *  - a claim is one atomic UPDATE over `FOR UPDATE SKIP LOCKED`, so two
 *    workers never run the same job
 *  - a claim is a lease: if a worker dies, the lease expires and the job is
 *    reclaimed (counting the attempt), up to maxAttempts, then DEAD
 *  - failures retry with exponential backoff when the error is retryable
 */
export class JobQueue {
  constructor(
    private readonly db: Database,
    private readonly opts: { workerId: string; leaseMs: number; clock?: Clock },
  ) {}

  private now(): Date {
    return (this.opts.clock ?? systemClock).now();
  }

  async enqueue(name: string, payload: Record<string, unknown> = {}, o: EnqueueOptions = {}): Promise<{ id: string | null; created: boolean }> {
    const rows = await this.db
      .insert(jobRuns)
      .values({ name, payload, dedupeKey: o.dedupeKey ?? null, runAt: o.runAt ?? this.now(), priority: o.priority ?? 100, maxAttempts: o.maxAttempts ?? 3 })
      .onConflictDoNothing({ target: jobRuns.dedupeKey })
      .returning({ id: jobRuns.id });
    return rows[0] ? { id: rows[0].id, created: true } : { id: null, created: false };
  }

  /** Atomically claim the next due job (optionally restricted to names). */
  async claim(names?: string[]): Promise<JobRow | null> {
    const now = this.now();
    const until = new Date(now.getTime() + this.opts.leaseMs);
    const nameFilter = names && names.length > 0 ? sql`AND name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})` : sql``;
    const res = await this.db.execute(sql`
      UPDATE job_runs SET status = 'RUNNING', attempts = attempts + 1, locked_by = ${this.opts.workerId},
        locked_until = ${until.toISOString()}::timestamptz, started_at = ${now.toISOString()}::timestamptz
      WHERE id = (
        SELECT id FROM job_runs
        WHERE status = 'QUEUED' AND run_at <= ${now.toISOString()}::timestamptz ${nameFilter}
        ORDER BY priority ASC, run_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *`);
    const row = rowsOf(res)[0];
    return row ? rowToJob(row) : null;
  }

  /** Only the lease holder may complete a job; a reclaimed job cannot be completed twice. */
  async complete(job: JobRow, result: Record<string, unknown> = {}): Promise<boolean> {
    const rows = await this.db
      .update(jobRuns)
      .set({ status: 'SUCCEEDED', finishedAt: this.now(), result, lockedUntil: null, lastError: null })
      .where(and(eq(jobRuns.id, job.id), eq(jobRuns.status, 'RUNNING'), eq(jobRuns.lockedBy, this.opts.workerId)))
      .returning({ id: jobRuns.id });
    return rows.length === 1;
  }

  async fail(job: JobRow, err: unknown): Promise<JobStatus> {
    const msg = describeError(err).message.slice(0, 2000);
    const retry = isRetryable(err) || !(err instanceof Error && 'code' in err);
    const exhausted = job.attempts >= job.maxAttempts;
    const status: JobStatus = !retry || exhausted ? (exhausted ? 'DEAD' : 'FAILED') : 'QUEUED';
    const backoffMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, job.attempts - 1));
    await this.db
      .update(jobRuns)
      .set({
        status,
        lastError: msg,
        lockedUntil: null,
        lockedBy: null,
        finishedAt: status === 'QUEUED' ? null : this.now(),
        runAt: status === 'QUEUED' ? new Date(this.now().getTime() + backoffMs) : undefined,
      })
      .where(and(eq(jobRuns.id, job.id), eq(jobRuns.lockedBy, this.opts.workerId)));
    return status;
  }

  async extendLease(job: JobRow): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({ lockedUntil: new Date(this.now().getTime() + this.opts.leaseMs) })
      .where(and(eq(jobRuns.id, job.id), eq(jobRuns.lockedBy, this.opts.workerId), eq(jobRuns.status, 'RUNNING')));
  }

  /** Jobs whose worker died: back to the queue, or DEAD when out of attempts. */
  async reclaimExpired(): Promise<{ requeued: number; dead: number }> {
    const now = this.now();
    const dead = await this.db
      .update(jobRuns)
      .set({ status: 'DEAD', lastError: 'lease expired (worker crashed or hung) and no attempts left', lockedBy: null, lockedUntil: null, finishedAt: now })
      .where(and(eq(jobRuns.status, 'RUNNING'), lt(jobRuns.lockedUntil, now), sql`${jobRuns.attempts} >= ${jobRuns.maxAttempts}`))
      .returning({ id: jobRuns.id });
    const requeued = await this.db
      .update(jobRuns)
      .set({ status: 'QUEUED', lastError: 'lease expired (worker crashed or hung); retrying', lockedBy: null, lockedUntil: null, runAt: now })
      .where(and(eq(jobRuns.status, 'RUNNING'), lt(jobRuns.lockedUntil, now)))
      .returning({ id: jobRuns.id });
    return { requeued: requeued.length, dead: dead.length };
  }

  async cancelQueued(names?: string[]): Promise<number> {
    const rows = await this.db
      .update(jobRuns)
      .set({ status: 'CANCELLED', finishedAt: this.now(), lastError: 'cancelled' })
      .where(names && names.length > 0 ? and(eq(jobRuns.status, 'QUEUED'), inArray(jobRuns.name, names)) : eq(jobRuns.status, 'QUEUED'))
      .returning({ id: jobRuns.id });
    return rows.length;
  }

  async heartbeat(info: { hostname: string; pid: number; startedAt: Date; status: 'RUNNING' | 'STOPPING' | 'STOPPED'; processed: number; failed: number; currentJob: string | null }): Promise<void> {
    const now = this.now();
    await this.db
      .insert(workerHeartbeats)
      .values({ workerId: this.opts.workerId, hostname: info.hostname, pid: info.pid, startedAt: info.startedAt, lastSeenAt: now, status: info.status, jobsProcessed: info.processed, jobsFailed: info.failed, currentJob: info.currentJob })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeenAt: now, status: info.status, jobsProcessed: info.processed, jobsFailed: info.failed, currentJob: info.currentJob } });
  }

  /** Remove finished jobs older than `days` (keeps the table small). */
  async prune(days: number): Promise<number> {
    const cutoff = new Date(this.now().getTime() - days * 86_400_000);
    const rows = await this.db
      .delete(jobRuns)
      .where(and(inArray(jobRuns.status, ['SUCCEEDED', 'CANCELLED', 'DEAD', 'FAILED']), lt(jobRuns.createdAt, cutoff)))
      .returning({ id: jobRuns.id });
    return rows.length;
  }
}

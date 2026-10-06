import { hostname } from 'node:os';
import { describeError, type Logger } from '@aoc/core';
import type { JobQueue, JobRow } from './queue';

export interface JobContext {
  job: JobRow;
  /** Extend the lease during long work so the job is not reclaimed. */
  keepAlive(): Promise<void>;
  log: Logger;
}

export interface JobDefinition {
  handler: (ctx: JobContext) => Promise<Record<string, unknown> | void>;
  /** If true the job does not run while the emergency stop is engaged. */
  haltable: boolean;
}

export interface WorkerOptions {
  concurrency: number;
  pollMs: number;
  logger: Logger;
  isHalted: () => Promise<boolean>;
  onJobError?: (job: JobRow, err: unknown, status: string) => Promise<void> | void;
}

/**
 * Pulls jobs from the queue and runs them with bounded concurrency. Every
 * failure is logged and recorded on the job row; nothing is swallowed.
 */
export class Worker {
  private running = false;
  private active = 0;
  private processed = 0;
  private failed = 0;
  private current = new Set<string>();
  private readonly startedAt = new Date();
  private loop: Promise<void> | null = null;

  constructor(
    private readonly queue: JobQueue,
    private readonly jobs: Record<string, JobDefinition>,
    private readonly o: WorkerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(timeoutMs = 30_000): Promise<void> {
    this.running = false;
    const deadline = Date.now() + timeoutMs;
    while (this.active > 0 && Date.now() < deadline) await sleep(100);
    await this.loop;
    await this.queue.heartbeat(this.heartbeatInfo('STOPPED')).catch(() => undefined);
  }

  stats() {
    return { processed: this.processed, failed: this.failed, active: this.active, current: [...this.current] };
  }

  private heartbeatInfo(status: 'RUNNING' | 'STOPPING' | 'STOPPED') {
    return { hostname: hostname(), pid: process.pid, startedAt: this.startedAt, status, processed: this.processed, failed: this.failed, currentJob: [...this.current].join(', ') || null };
  }

  private async run(): Promise<void> {
    let lastHeartbeat = 0;
    let lastReclaim = 0;
    while (this.running) {
      try {
        const now = Date.now();
        if (now - lastHeartbeat > 10_000) {
          await this.queue.heartbeat(this.heartbeatInfo('RUNNING'));
          lastHeartbeat = now;
        }
        if (now - lastReclaim > 30_000) {
          const r = await this.queue.reclaimExpired();
          if (r.requeued || r.dead) this.o.logger.warn(r, 'reclaimed jobs with expired leases');
          lastReclaim = now;
        }
        if (this.active < this.o.concurrency) {
          const claimed = await this.runOnce();
          if (claimed) continue;
        }
      } catch (e) {
        this.o.logger.error({ err: describeError(e) }, 'worker loop error');
      }
      await sleep(this.o.pollMs);
    }
  }

  /** Claim and start one job. Returns false when nothing was due. */
  async runOnce(wait = false): Promise<boolean> {
    const halted = await this.o.isHalted();
    const names = Object.entries(this.jobs)
      .filter(([, d]) => !(halted && d.haltable))
      .map(([n]) => n);
    if (names.length === 0) return false;
    const job = await this.queue.claim(names);
    if (!job) return false;
    const p = this.execute(job);
    if (wait) await p;
    return true;
  }

  private async execute(job: JobRow): Promise<void> {
    const def = this.jobs[job.name];
    this.active++;
    this.current.add(job.name);
    const log = this.o.logger.child({ job: job.name, jobId: job.id, attempt: job.attempts });
    try {
      if (!def) throw new Error(`no handler registered for job ${job.name}`);
      const result = await def.handler({ job, keepAlive: () => this.queue.extendLease(job), log });
      await this.queue.complete(job, result ?? {});
      this.processed++;
    } catch (e) {
      this.failed++;
      const status = await this.queue.fail(job, e).catch(() => 'UNKNOWN');
      log.error({ err: describeError(e), status }, 'job failed');
      await this.o.onJobError?.(job, e, status);
    } finally {
      this.active--;
      this.current.delete(job.name);
    }
  }
}

export interface ScheduleEntry {
  name: string;
  everyMs: number;
  payload?: Record<string, unknown>;
  priority?: number;
}

/**
 * Periodic jobs. The dedupe key is the job name plus the time bucket, so any
 * number of schedulers (or restarts) enqueue each period exactly once.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: JobQueue,
    private readonly entries: ScheduleEntry[],
    private readonly logger: Logger,
  ) {}

  async tick(now = new Date()): Promise<number> {
    let created = 0;
    for (const e of this.entries) {
      const bucket = Math.floor(now.getTime() / e.everyMs);
      const res = await this.queue.enqueue(e.name, e.payload ?? {}, { dedupeKey: `${e.name}:${e.everyMs}:${bucket}`, priority: e.priority, runAt: now });
      if (res.created) created++;
    }
    return created;
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    const run = () => this.tick().catch((e) => this.logger.error({ err: describeError(e) }, 'scheduler tick failed'));
    void run();
    this.timer = setInterval(run, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

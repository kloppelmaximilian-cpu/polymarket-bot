import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createLogger, describeError, loadConfig, type AppConfig, type Logger } from '@aoc/core';
import { BinanceStreams } from '@aoc/connectors';
import { createDatabase, type DatabaseHandle } from '@aoc/database';
import { JobQueue, Scheduler, Worker } from '@aoc/jobs';
import { recordError, recordEvent } from './audit';
import { createContext, type PlatformContext } from './context';
import { syncStrategies } from './experiments';
import { seed } from './seed';
import { buildJobs, buildSchedule } from './jobs';
import { getEmergencyStop } from './settings';

/**
 * Load `.env` from the working directory or the nearest parent that has one
 * (the monorepo root when started from an app folder). Variables already set
 * in the environment win over the file.
 */
export function loadDotEnv(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 4; i++) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Make a relative `pglite://dir` absolute against `baseDir`; other URLs pass through. */
export function resolvePgliteUrl(url: string, baseDir: string): string {
  if (!url.startsWith('pglite://')) return url;
  const path = url.slice('pglite://'.length) || '.data/pglite';
  return `pglite://${isAbsolute(path) ? path : resolve(baseDir, path)}`;
}

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  database: DatabaseHandle;
  ctx: PlatformContext;
  queue: JobQueue;
  streams: BinanceStreams | null;
  close(): Promise<void>;
}

/** Symbols streamed over the Binance websocket (the spot pairs the starter strategies use). */
export const STREAM_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

/**
 * Open configuration, logger, database (migrated), platform context and job
 * queue. Shared by the API, the worker and the CLI.
 */
export async function openRuntime(o: { name: string; migrate?: boolean; streams?: boolean; logger?: Logger }): Promise<Runtime> {
  const envFile = loadDotEnv();
  // A relative embedded-database path means "relative to the project root", whichever app started.
  if (process.env.DATABASE_URL) process.env.DATABASE_URL = resolvePgliteUrl(process.env.DATABASE_URL, envFile ? dirname(envFile) : process.cwd());
  const config = loadConfig();
  const logger = o.logger ?? createLogger({ name: o.name, level: config.LOG_LEVEL, pretty: config.NODE_ENV === 'development' && process.stdout.isTTY });
  const database = await createDatabase(config.DATABASE_URL, { onPoolError: (err) => logger.error({ err: describeError(err) }, 'database pool error') });
  if (o.migrate ?? true) await database.migrate();

  let streams: BinanceStreams | null = null;
  if (o.streams && config.MARKET_DATA_ENABLED && config.MARKET_DATA_WEBSOCKETS) {
    streams = new BinanceStreams(STREAM_SYMBOLS, '1h', {
      staleAfterMs: Math.min(config.DATA_STALE_AFTER_MS, 60_000),
      onState: (state, detail) => logger.info({ state, detail }, 'binance websocket'),
    });
  }
  const ctx = createContext({ db: database.db, config, logger, streams });
  const queue = new JobQueue(database.db, { workerId: `${o.name}@${hostname()}:${process.pid}`, leaseMs: config.JOB_LEASE_MS });
  return {
    config,
    logger,
    database,
    ctx,
    queue,
    streams,
    close: async () => {
      streams?.stop();
      await database.close();
    },
  };
}

export interface Background {
  worker: Worker;
  scheduler: Scheduler | null;
  stop(): Promise<void>;
}

/**
 * Start the job worker (and the scheduler when enabled). Used by the worker
 * process, and inside the API in embedded mode (PGlite allows one process).
 */
export async function startBackground(rt: Pick<Runtime, 'ctx' | 'queue' | 'streams' | 'config' | 'logger'>, o: { scheduler?: boolean } = {}): Promise<Background> {
  const { ctx, queue, config, logger } = rt;
  const synced = await syncStrategies(ctx);
  logger.info({ modules: synced }, 'strategy modules synced');
  if (config.SEED_ON_START) {
    const r = await seed(ctx);
    logger.info({ created: r.created.length }, 'starter experiments seeded (SEED_ON_START)');
  }
  rt.streams?.start();

  const worker = new Worker(queue, buildJobs(ctx), {
    concurrency: config.WORKER_CONCURRENCY,
    pollMs: config.WORKER_POLL_MS,
    logger,
    isHalted: async () => (await getEmergencyStop(ctx.db)).engaged,
    onJobError: async (job, err, status) => {
      await recordError(ctx.db, 'worker', err, { job: job.name, jobId: job.id, attempt: job.attempts, status }).catch(() => undefined);
    },
  });
  worker.start();

  let scheduler: Scheduler | null = null;
  if ((o.scheduler ?? true) && config.SCHEDULER_ENABLED) {
    scheduler = new Scheduler(queue, buildSchedule(config), logger);
    scheduler.start();
  }
  await recordEvent(ctx.db, 'INFO', 'worker', 'WORKER_STARTED', 'worker started', { concurrency: config.WORKER_CONCURRENCY, scheduler: !!scheduler, websockets: !!rt.streams });
  return {
    worker,
    scheduler,
    stop: async () => {
      scheduler?.stop();
      rt.streams?.stop();
      await worker.stop();
      await recordEvent(ctx.db, 'INFO', 'worker', 'WORKER_STOPPED', 'worker stopped', worker.stats()).catch(() => undefined);
    },
  };
}

/** Run `shutdown` once on SIGINT/SIGTERM; a second signal exits immediately. */
export function onShutdown(logger: Logger, shutdown: () => Promise<void>): void {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    logger.info({ signal }, 'shutting down');
    shutdown()
      .then(() => process.exit(0))
      .catch((e) => {
        logger.error({ err: describeError(e) }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
}

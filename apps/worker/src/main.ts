import { describeError } from '@aoc/core';
import { onShutdown, openRuntime, startBackground } from '@aoc/platform';

/**
 * The worker process: runs queued jobs (pipeline, paper ticks, risk monitor,
 * scoring, research, lab) and the scheduler that enqueues them. Any number of
 * workers may run against one PostgreSQL database; the queue guarantees each
 * job runs once.
 */
async function main(): Promise<void> {
  const rt = await openRuntime({ name: 'aoc-worker', migrate: true });
  if (rt.database.kind === 'pglite') {
    throw new Error('the embedded database (PGlite) is single-process: in embedded mode the worker runs inside the API (pnpm dev:embedded); use PostgreSQL for a separate worker');
  }
  const bg = await startBackground(rt);
  rt.logger.info({ concurrency: rt.config.WORKER_CONCURRENCY, scheduler: !!bg.scheduler }, 'worker running — PAPER / SIMULATION ONLY');
  onShutdown(rt.logger, async () => {
    await bg.stop();
    await rt.close();
  });
}

main().catch((e) => {
  process.stderr.write(`worker failed: ${describeError(e).message}\n`);
  process.exit(1);
});

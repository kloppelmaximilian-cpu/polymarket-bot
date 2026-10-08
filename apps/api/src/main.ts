import { describeError, effectiveMode } from '@aoc/core';
import { onShutdown, openRuntime, recordEvent, startBackground, type Background } from '@aoc/platform';
import { buildApp } from './app';

async function main(): Promise<void> {
  const rt = await openRuntime({ name: 'aoc-api', migrate: true });
  const { config, logger, ctx, queue, database } = rt;

  // PGlite is single-process, so in embedded mode the worker runs in here.
  const embedded = config.EMBEDDED_WORKER || database.kind === 'pglite';
  let background: Background | null = null;
  if (embedded) {
    background = await startBackground(rt);
    logger.info('embedded worker and scheduler started inside the API process');
  }

  const app = await buildApp({ ctx, queue });
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  await recordEvent(ctx.db, 'INFO', 'api', 'API_STARTED', 'API started', { host: config.API_HOST, port: config.API_PORT, embeddedWorker: embedded, database: database.kind });
  logger.info(
    { url: `http://${config.API_HOST}:${config.API_PORT}`, docs: `http://${config.API_HOST}:${config.API_PORT}/docs`, mode: effectiveMode(config), auth: config.API_TOKEN ? 'bearer token' : 'none (local only)' },
    'Automated Opportunity Center API listening — PAPER / SIMULATION ONLY',
  );

  onShutdown(logger, async () => {
    await app.close();
    await background?.stop();
    await rt.close();
  });
}

main().catch((e) => {
  process.stderr.write(`API failed to start: ${describeError(e).message}\n`);
  process.exit(1);
});

import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { AocError, describeError, type ErrorCode } from '@aoc/core';
import { JobQueue } from '@aoc/jobs';
import { recordError, type Actor, type PlatformContext } from '@aoc/platform';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { registerRoutes } from './routes';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  LIVE_TRADING_DISABLED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  DUPLICATE: 409,
  RISK_LIMIT: 422,
  EMERGENCY_STOP: 423,
  EXTERNAL_API: 502,
  DATA_UNAVAILABLE: 503,
  STALE_DATA: 503,
  INTERNAL: 500,
};

export interface AppDeps {
  ctx: PlatformContext;
  queue: JobQueue;
  /** Report this process' API health (always ONLINE when answering). */
  logger?: boolean;
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { ctx } = deps;
  const app = Fastify({
    loggerInstance: deps.logger === false ? undefined : (ctx.logger as never),
    genReqId: () => crypto.randomUUID(),
    // One line per request floods the terminal; requests are logged at debug level below.
    disableRequestLogging: true,
    bodyLimit: 1_000_000,
    // Not behind a proxy by default: trusting X-Forwarded-For would let clients spoof their IP
    // (and the rate-limit allow-list). Enable only behind a reverse proxy you control.
    trustProxy: ctx.config.API_TRUST_PROXY,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, { origin: ctx.config.WEB_ORIGIN.split(',').map((s) => s.trim()), credentials: false });
  await app.register(rateLimit, { max: ctx.config.API_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute', allowList: ['127.0.0.1', '::1'] });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Automated Opportunity Center API',
        version: '0.1.0',
        description: 'Research, simulation, backtesting and paper testing of automated business and trading ideas. Paper/simulation only: there is no live-trading endpoint.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: ctx.config.API_TOKEN ? [{ bearer: [] }] : [],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Authentication: when API_TOKEN is set every route except liveness/readiness needs it.
  app.decorateRequest('actor', null as unknown as Actor);
  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    const open = req.url === '/health' || req.url.startsWith('/health/') || req.url.startsWith('/docs');
    const token = ctx.config.API_TOKEN;
    if (token && !open && !tokenMatches(token, req.headers.authorization)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' } });
    }
    req.actor = { type: 'USER', id: token ? 'api-token' : 'local-user' };
  });

  // Visible with LOG_LEVEL=debug; server errors are logged by the error handler regardless.
  app.addHook('onResponse', async (req, reply) => {
    req.log.debug({ method: req.method, url: req.url, statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });

  app.setErrorHandler(async (error, req, reply) => {
    const err = error as Error;
    if (err instanceof ZodError || (err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message, issues: (err as ZodError).issues ?? (err as { validation?: unknown }).validation } });
    }
    if (err instanceof AocError) {
      const status = STATUS[err.code] ?? 500;
      if (status >= 500) req.log.error({ err: err.toJSON() }, 'request failed');
      return reply.code(status).send({ error: err.toJSON() });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'REQUEST', message: err.message } });
    req.log.error({ err: describeError(err) }, 'unhandled error');
    await recordError(ctx.db, 'api', err, { method: req.method, url: req.url, requestId: req.id });
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error (recorded in system events)', requestId: req.id } });
  });

  await registerRoutes(app, deps);
  return app;
}

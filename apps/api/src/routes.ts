import { CATEGORIES, COMPLIANCE_ITEMS, COMPLIANCE_STATES, EXPERIMENT_STATUSES, NotFoundError, RISK_LEVELS, ValidationError, evaluateLiveGate } from '@aoc/core';
import { experiments, ideas as ideasTable, metrics as metricsTable, paperAccounts, strategies, strategyRuns } from '@aoc/database';
import { DEFAULT_THRESHOLDS } from '@aoc/experiments';
import { GENERATOR_PROMPTS, defaultCompliance } from '@aoc/research';
import { DEFAULT_WEIGHTS } from '@aoc/scoring';
import {
  JOB_NAMES,
  SETTING_KEYS,
  accountDetail,
  advanceExperiment,
  compareExperiments,
  createExperiment,
  createVersion,
  dashboard,
  engageEmergencyStop,
  experimentDetail,
  getEmergencyStop,
  insertIdea,
  linkSourcesToExperiment,
  listDataSources,
  listExperiments,
  listIdeas,
  listJobs,
  listNotifications,
  listStrategies,
  logs,
  markNotificationsRead,
  performance,
  portfolio,
  promoteVersion,
  putSetting,
  releaseEmergencyStop,
  research,
  riskOverview,
  setStatusByUser,
  settingsView,
  startResearch,
  systemHealth,
  updateCompliance,
  updateRiskLimits,
  upsertSource,
  versionComparison,
  withAccount,
  audit,
} from '@aoc/platform';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from './app';

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined));
const numQ = z.coerce.number().optional();
const uuid = z.string().uuid();

export async function registerRoutes(fastify: FastifyInstance, { ctx, queue }: AppDeps): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ─────────────────────────────────────────────────────────── health ──
  app.get('/health', { schema: { tags: ['system'], summary: 'Liveness' } }, async () => ({ status: 'ok', mode: ctx.config.TRADING_MODE === 'live' ? 'LIVE_REQUESTED_BUT_DISABLED' : 'PAPER' }));
  app.get('/health/ready', { schema: { tags: ['system'], summary: 'Readiness (database reachable)' } }, async (_req, reply) => {
    try {
      await ctx.db.select({ id: strategies.id }).from(strategies).limit(1);
      return { status: 'ready' };
    } catch (e) {
      return reply.code(503).send({ status: 'not-ready', error: (e as Error).message });
    }
  });
  app.get('/v1/system/health', { schema: { tags: ['system'], summary: 'Component health: System, API, Database, Workers, Data Sources, Research Agent, Paper Engine' } }, async () => systemHealth(ctx, 'ONLINE'));
  app.get('/metrics', { schema: { tags: ['system'], summary: 'Prometheus metrics' } }, async (_req, reply) => {
    const exps = await ctx.db.select({ status: experiments.status }).from(experiments);
    const accounts = await ctx.db.select({ status: paperAccounts.status }).from(paperAccounts);
    const { jobs, workers } = await listJobs(ctx, 500);
    const lines = ['# HELP aoc_experiments Experiments by status', '# TYPE aoc_experiments gauge'];
    for (const s of EXPERIMENT_STATUSES) lines.push(`aoc_experiments{status="${s}"} ${exps.filter((e) => e.status === s).length}`);
    lines.push('# TYPE aoc_paper_accounts gauge', `aoc_paper_accounts{status="ACTIVE"} ${accounts.filter((a) => a.status === 'ACTIVE').length}`);
    lines.push('# TYPE aoc_jobs_recent gauge');
    for (const s of ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD']) lines.push(`aoc_jobs_recent{status="${s}"} ${jobs.filter((j) => j.status === s).length}`);
    lines.push('# TYPE aoc_workers_running gauge', `aoc_workers_running ${workers.filter((w) => w.status === 'RUNNING' && Date.now() - w.lastSeenAt.getTime() < 60_000).length}`);
    lines.push('# TYPE aoc_emergency_stop gauge', `aoc_emergency_stop ${(await getEmergencyStop(ctx.db)).engaged ? 1 : 0}`);
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  // ──────────────────────────────────────────────────────── dashboard ──
  app.get('/v1/dashboard', { schema: { tags: ['dashboard'], summary: 'Dashboard KPIs, top opportunities, activity' } }, async () => dashboard(ctx));

  // ────────────────────────────────────────────────────── experiments ──
  app.get(
    '/v1/experiments',
    {
      schema: {
        tags: ['experiments'],
        summary: 'List experiments with filters',
        querystring: z.object({
          category: csv,
          status: csv,
          kind: z.enum(['TRADING', 'PREDICTION_MARKET', 'ARBITRAGE', 'BUSINESS']).optional(),
          riskLevel: csv,
          minScore: numQ,
          maxScore: numQ,
          minProfit: numQ,
          maxCapital: numQ,
          minAutomation: numQ,
          minScalability: numQ,
          sinceDays: numQ,
          search: z.string().max(200).optional(),
          sort: z.enum(['rank', 'score', 'pnl', 'created', 'name', 'activity']).optional(),
          dir: z.enum(['asc', 'desc']).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
          includeArchived: z.coerce.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      return listExperiments(ctx, { ...q, since: q.sinceDays ? new Date(Date.now() - q.sinceDays * 86_400_000) : undefined });
    },
  );

  app.post(
    '/v1/experiments',
    {
      schema: {
        tags: ['experiments'],
        summary: 'Create an experiment from a strategy module (status DISCOVERED)',
        body: z.object({
          strategyId: z.string().min(3),
          name: z.string().min(3).max(200).optional(),
          description: z.string().max(5000).optional(),
          hypothesis: z.string().max(5000).optional(),
          params: z.record(z.string(), z.unknown()).optional(),
          capital: z.number().positive().max(1_000_000).optional(),
          riskLevel: z.enum(RISK_LEVELS).optional(),
          sourceIds: z.array(uuid).max(50).optional(),
          seed: z.string().min(1).max(64).optional(),
          startResearch: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { startResearch: start, ...input } = req.body;
      const exp = await createExperiment(ctx, input, req.actor);
      if (start) await startResearch(ctx, exp.id, req.actor);
      return reply.code(201).send(await experimentDetail(ctx, exp.id));
    },
  );

  app.get('/v1/experiments/:id', { schema: { tags: ['experiments'], summary: 'Experiment detail (by id or slug)', params: z.object({ id: z.string().min(1).max(200) }) } }, async (req) => experimentDetail(ctx, req.params.id));

  app.post(
    '/v1/experiments/:id/actions',
    {
      schema: {
        tags: ['experiments'],
        summary: 'Lifecycle action: start research, pause, resume, archive, revive, or run the next pipeline step now',
        params: z.object({ id: uuid }),
        body: z.object({ action: z.enum(['start', 'pause', 'resume', 'archive', 'revive', 'advance']), reason: z.string().max(1000).default('') }),
      },
    },
    async (req) => {
      const { action, reason } = req.body;
      if (action === 'start') await startResearch(ctx, req.params.id, req.actor);
      else if (action === 'advance') return { step: await advanceExperiment(ctx, req.params.id, { actor: req.actor, force: true }) };
      else await setStatusByUser(ctx, req.params.id, action, reason, req.actor);
      return experimentDetail(ctx, req.params.id);
    },
  );

  app.get('/v1/experiments/:id/versions', { schema: { tags: ['experiments'], summary: 'All versions with their results (v4 vs v3 …)', params: z.object({ id: uuid }) } }, async (req) => versionComparison(ctx, req.params.id));

  app.post(
    '/v1/experiments/:id/versions',
    {
      schema: {
        tags: ['experiments'],
        summary: 'Create a new immutable version (parameter or assumption change); an ACTIVE version restarts evaluation from a backtest',
        params: z.object({ id: uuid }),
        body: z.object({
          params: z.record(z.string(), z.unknown()).optional(),
          assumptions: z
            .array(z.object({ key: z.string(), label: z.string(), unit: z.string(), low: z.number(), mode: z.number(), high: z.number(), distribution: z.enum(['fixed', 'uniform', 'triangular', 'pert']), source: z.string().url().nullable(), note: z.string().optional(), stressRole: z.enum(['conversion', 'cost', 'churn', 'demand', 'price']).optional() }))
            .max(100)
            .optional(),
          changeNote: z.string().min(3).max(1000),
          bump: z.enum(['minor', 'major']).optional(),
          status: z.enum(['ACTIVE', 'CANDIDATE']).optional(),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(await createVersion(ctx, req.params.id, req.body, req.actor)),
  );

  app.post('/v1/experiments/:id/versions/:versionId/promote', { schema: { tags: ['experiments'], summary: 'Promote a CANDIDATE version (e.g. from the Strategy Lab) to ACTIVE', params: z.object({ id: uuid, versionId: uuid }) } }, async (req) => {
    await promoteVersion(ctx, req.params.id, req.params.versionId, req.actor);
    return experimentDetail(ctx, req.params.id);
  });

  app.put(
    '/v1/experiments/:id/risk-limits',
    {
      schema: {
        tags: ['risk'],
        summary: 'Change risk limits (validated; audited)',
        params: z.object({ id: uuid }),
        body: z
          .object({
            maxCapital: z.number().min(0),
            maxDailyLoss: z.number().min(0),
            maxDrawdownPct: z.number().gt(0).max(1),
            maxExposure: z.number().min(0),
            maxPositions: z.number().int().min(0),
            maxOrdersPerDay: z.number().int().min(0),
            maxOrderNotional: z.number().min(0),
            maxApiSpend: z.number().min(0),
            maxExperimentSpend: z.number().min(0),
          })
          .partial(),
      },
    },
    async (req) => updateRiskLimits(ctx, req.params.id, req.body, req.actor),
  );

  app.put(
    '/v1/experiments/:id/compliance/:item',
    {
      schema: {
        tags: ['experiments'],
        summary: 'Record a compliance review (BLOCKER fails the experiment)',
        params: z.object({ id: uuid, item: z.enum(COMPLIANCE_ITEMS) }),
        body: z.object({ state: z.enum(COMPLIANCE_STATES), note: z.string().max(2000).default('') }),
      },
    },
    async (req) => updateCompliance(ctx, req.params.id, req.params.item, req.body.state, req.body.note, req.actor),
  );

  app.post('/v1/experiments/:id/lab', { schema: { tags: ['lab'], summary: 'Queue a Strategy Lab run for this experiment', params: z.object({ id: uuid }) } }, async (req, reply) => {
    const job = await queue.enqueue('lab.run', { experimentId: req.params.id }, { dedupeKey: `lab.run:${req.params.id}:${Math.floor(Date.now() / 60_000)}`, priority: 60 });
    await audit(ctx.db, req.actor, 'STRATEGY_STARTED', { type: 'lab', id: req.params.id, experimentId: req.params.id }, { queued: job.created });
    return reply.code(202).send({ queued: job.created, jobId: job.id });
  });

  app.post(
    '/v1/experiments/:id/flatten',
    { schema: { tags: ['experiments'], summary: 'Close all paper positions at their last mark (manual, risk-reducing only)', params: z.object({ id: uuid }), body: z.object({ reason: z.string().min(3).max(500) }) } },
    async (req) => {
      const [account] = await ctx.db.select().from(paperAccounts).where(and(eq(paperAccounts.experimentId, req.params.id), eq(paperAccounts.status, 'ACTIVE')));
      if (!account) throw new NotFoundError('active paper account for experiment', req.params.id);
      const closed = await withAccount(
        ctx,
        account.id,
        async (engine) => {
          const now = ctx.clock.now();
          const changes = [engine.cancelAll(now, 'manual flatten')];
          let n = 0;
          for (const p of engine.positions()) {
            const mark = (p.markPrice ?? p.avgPrice).toNumber();
            const r = engine.submitOrder(
              { clientOrderId: `flatten-${now.getTime()}-${n}`, instrument: { venue: p.venue, symbol: p.symbol, kind: p.kind, feeModel: { type: 'none' } }, side: p.quantity.isPositive() ? 'SELL' : 'BUY', type: 'MARKET', quantity: p.quantity.abs(), reduceOnly: true, reason: `manual flatten: ${req.body.reason}` },
              { ts: now, bid: mark, ask: mark, assumeInfiniteDepth: true },
            );
            changes.push(r.changes);
            n++;
          }
          return { changes, result: n };
        },
        { purpose: 'MANUAL_FLATTEN' },
      );
      await audit(ctx.db, req.actor, 'STRATEGY_STOPPED', { type: 'paper_account', id: account.id, experimentId: req.params.id }, { flatten: true, positions: closed, reason: req.body.reason });
      return { closedPositions: closed, note: 'Closed at the last mark price without fees (manual paper adjustment).' };
    },
  );

  app.get('/v1/compare', { schema: { tags: ['experiments'], summary: 'Compare experiments side by side', querystring: z.object({ ids: z.string().min(1) }) } }, async (req) => {
    const ids = req.query.ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    for (const id of ids) uuid.parse(id);
    return compareExperiments(ctx, ids);
  });

  // ─────────────────────────────────────────────────────── strategies ──
  app.get('/v1/strategies', { schema: { tags: ['strategies'], summary: 'Strategy and business modules' } }, async () => listStrategies(ctx));
  app.get('/v1/strategies/:id', { schema: { tags: ['strategies'], summary: 'One module with its experiments', params: z.object({ id: z.string().min(3).max(100) }) } }, async (req) => {
    const [s] = await ctx.db.select().from(strategies).where(eq(strategies.id, req.params.id));
    if (!s) throw new NotFoundError('strategy', req.params.id);
    const exps = await listExperiments(ctx, { includeArchived: true });
    return { strategy: s, experiments: exps.filter((e) => e.strategyId === s.id), defaultCompliance: defaultCompliance(s.category as (typeof CATEGORIES)[number]) };
  });

  app.get('/v1/runs/:id', { schema: { tags: ['experiments'], summary: 'A stored run with its full result (equity curve, trades, folds …)', params: z.object({ id: uuid }) } }, async (req) => {
    const [r] = await ctx.db.select().from(strategyRuns).where(eq(strategyRuns.id, req.params.id));
    if (!r) throw new NotFoundError('run', req.params.id);
    return r;
  });

  app.get('/v1/metrics', { schema: { tags: ['experiments'], summary: 'Metrics (long format) for an experiment', querystring: z.object({ experimentId: uuid, name: z.string().optional() }) } }, async (req) => {
    const where = req.query.name ? and(eq(metricsTable.experimentId, req.query.experimentId), eq(metricsTable.name, req.query.name)) : eq(metricsTable.experimentId, req.query.experimentId);
    return ctx.db.select().from(metricsTable).where(where).orderBy(desc(metricsTable.recordedAt)).limit(1000);
  });

  // ──────────────────────────────────────────────────────── portfolio ──
  app.get('/v1/portfolio', { schema: { tags: ['portfolio'], summary: 'Paper fund, simulation budget and every virtual account' } }, async () => portfolio(ctx));
  app.get('/v1/portfolio/accounts/:id', { schema: { tags: ['portfolio'], summary: 'Positions, orders, fills, ledger and equity curve of one account', params: z.object({ id: uuid }) } }, async (req) => accountDetail(ctx, req.params.id));
  app.get('/v1/performance', { schema: { tags: ['portfolio'], summary: 'Equity curves and category aggregates', querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }) } }, async (req) => performance(ctx, { limit: req.query.limit }));

  // ──────────────────────────────────────────────────── research/ideas ──
  app.get('/v1/research/sources', { schema: { tags: ['research'], summary: 'Research database', querystring: z.object({ search: z.string().max(200).optional(), category: z.string().optional(), sourceType: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }) } }, async (req) => research(ctx, req.query));
  app.post(
    '/v1/research/sources',
    {
      schema: {
        tags: ['research'],
        summary: 'Add a research source manually',
        body: z.object({
          sourceType: z.enum(['GITHUB', 'PAPER', 'API_DOCS', 'BLOG', 'MARKET_REPORT', 'WEBSITE', 'REGULATION', 'NEWS', 'INTERNAL']),
          title: z.string().min(3).max(500),
          url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) URLs only'),
          author: z.string().max(200).optional(),
          summary: z.string().max(4000).default(''),
          relevantConcept: z.string().max(1000).optional(),
          license: z.string().max(100).optional(),
          termsConcerns: z.string().max(2000).optional(),
          experimentId: uuid.optional(),
        }),
      },
    },
    async (req, reply) => {
      const { experimentId, ...item } = req.body;
      const res = await upsertSource(ctx.db, item, 'MANUAL');
      if (experimentId) await linkSourcesToExperiment(ctx.db, experimentId, [res.id]);
      await audit(ctx.db, req.actor, 'RESEARCH_ADDED', { type: 'research_source', id: res.id, experimentId: experimentId ?? null }, { url: item.url, created: res.created });
      return reply.code(res.created ? 201 : 200).send(res);
    },
  );
  app.post('/v1/research/monitor', { schema: { tags: ['research'], summary: 'Queue a research monitor run' } }, async (_req, reply) => {
    const job = await queue.enqueue('research.monitor', {}, { dedupeKey: `research.monitor:manual:${Math.floor(Date.now() / 60_000)}` });
    return reply.code(202).send({ queued: job.created, jobId: job.id });
  });

  app.get('/v1/ideas', { schema: { tags: ['research'], summary: 'Idea database', querystring: z.object({ status: z.string().optional(), category: z.string().optional(), search: z.string().max(200).optional() }) } }, async (req) => listIdeas(ctx, req.query));
  app.get('/v1/ideas/prompts', { schema: { tags: ['research'], summary: 'Idea generator prompts by focus' } }, async () => GENERATOR_PROMPTS);
  app.post(
    '/v1/ideas/generate',
    { schema: { tags: ['research'], summary: 'Queue the idea generator (catalogue, or Claude when configured)', body: z.object({ focus: z.enum(['any', 'low-capital', 'prediction-markets', 'ai-agents', 'trading', 'business']).default('any'), count: z.number().int().min(1).max(25).default(10), maxConvert: z.number().int().min(0).max(10).default(2) }) } },
    async (req, reply) => {
      const job = await queue.enqueue('ideas.generate', req.body, { dedupeKey: `ideas.generate:manual:${req.body.focus}:${Math.floor(Date.now() / 60_000)}`, priority: 70 });
      return reply.code(202).send({ queued: job.created, jobId: job.id });
    },
  );
  app.post(
    '/v1/ideas',
    {
      schema: {
        tags: ['research'],
        summary: 'Add an idea manually',
        body: z.object({
          name: z.string().min(3).max(200),
          category: z.enum(CATEGORIES),
          description: z.string().min(10).max(5000),
          revenueSource: z.string().max(500).default(''),
          estimatedCapital: z.number().min(0).nullable().default(null),
          automationScore: z.number().int().min(0).max(100).nullable().default(null),
          complexityScore: z.number().int().min(0).max(100).nullable().default(null),
          scalabilityScore: z.number().int().min(0).max(100).nullable().default(null),
          testabilityScore: z.number().int().min(0).max(100).nullable().default(null),
          risks: z.array(z.string().max(300)).max(20).default([]),
          dependencies: z.array(z.string().max(300)).max(20).default([]),
          regulatoryRisks: z.array(z.string().max(300)).max(20).default([]),
          suggestedStrategyId: z.string().nullable().default(null),
          sourceUrl: z.string().url().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { sourceUrl, ...rest } = req.body;
      if (rest.suggestedStrategyId && !ctx.registry.has(rest.suggestedStrategyId)) throw new ValidationError(`unknown strategy module ${rest.suggestedStrategyId}`);
      const res = await insertIdea(ctx.db, { ...rest, origin: 'MANUAL', sources: sourceUrl ? [{ sourceType: 'WEBSITE', title: sourceUrl, url: sourceUrl, summary: 'Added with a manual idea' }] : [], notes: ['Added manually.'] }, req.actor);
      return reply.code(res.created ? 201 : 409).send(res);
    },
  );
  app.post('/v1/ideas/:id/convert', { schema: { tags: ['research'], summary: 'Create an experiment from an idea', params: z.object({ id: uuid }), body: z.object({ strategyId: z.string().optional(), startResearch: z.boolean().default(false) }) } }, async (req, reply) => {
    const [idea] = (await listIdeas(ctx)).filter((i) => i.id === req.params.id);
    if (!idea) throw new NotFoundError('idea', req.params.id);
    const strategyId = req.body.strategyId ?? idea.suggestedStrategyId;
    if (!strategyId) throw new ValidationError('this idea has no strategy module; choose one (strategyId) or keep it as a research note');
    const exp = await createExperiment(ctx, { strategyId, name: idea.name, description: idea.description, ideaId: idea.id }, req.actor);
    await ctx.db.update(ideasTable).set({ status: 'CONVERTED', experimentId: exp.id }).where(eq(ideasTable.id, idea.id));
    await audit(ctx.db, req.actor, 'IDEA_CONVERTED', { type: 'idea', id: idea.id, experimentId: exp.id }, { strategyId });
    if (req.body.startResearch) await startResearch(ctx, exp.id, req.actor);
    return reply.code(201).send({ experimentId: exp.id });
  });

  // ──────────────────────────────────────────────────────── logs/risk ──
  app.get('/v1/logs/audit', { schema: { tags: ['logs'], summary: 'Audit log (append-only)', querystring: z.object({ experimentId: uuid.optional(), action: z.string().optional(), search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).optional(), before: z.coerce.date().optional() }) } }, async (req) => logs(ctx, { kind: 'audit', ...req.query }));
  app.get('/v1/logs/events', { schema: { tags: ['logs'], summary: 'System events', querystring: z.object({ experimentId: uuid.optional(), level: z.enum(['INFO', 'WARN', 'ERROR']).optional(), component: z.string().optional(), search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).optional(), before: z.coerce.date().optional() }) } }, async (req) => logs(ctx, { kind: 'events', ...req.query }));

  app.get('/v1/risk', { schema: { tags: ['risk'], summary: 'Risk overview: limits, utilisation, events, emergency stop' } }, async () => riskOverview(ctx));
  app.post('/v1/risk/emergency-stop', { schema: { tags: ['risk'], summary: 'EMERGENCY STOP: pause every automated experiment and cancel open paper orders', body: z.object({ reason: z.string().min(3).max(500) }) } }, async (req) => engageEmergencyStop(ctx, req.body.reason, req.actor));
  app.post('/v1/risk/emergency-stop/release', { schema: { tags: ['risk'], summary: 'Release the emergency stop (experiments stay paused unless resumePaused)', body: z.object({ reason: z.string().min(3).max(500), resumePaused: z.boolean().default(false) }) } }, async (req) => releaseEmergencyStop(ctx, req.body.reason, req.actor, { resumePaused: req.body.resumePaused }));

  app.get('/v1/live/status', { schema: { tags: ['risk'], summary: 'Why live trading is disabled (always disabled in this build)' } }, async () => {
    const stop = await getEmergencyStop(ctx.db);
    return { ...evaluateLiveGate(ctx.config, { experimentStatus: 'PAPER', humanApprovalId: null, emergencyStopEngaged: stop.engaged, requestedCapitalUsd: 0 }), allowed: false };
  });

  // ─────────────────────────────────────────────────── data/jobs/etc ──
  app.get('/v1/data-sources', { schema: { tags: ['system'], summary: 'Data sources with health (CONNECTED, STALE, DEGRADED, OFFLINE)' } }, async () => listDataSources(ctx));
  app.post('/v1/data-sources/probe', { schema: { tags: ['system'], summary: 'Queue a connectivity probe of every market data source' } }, async (_req, reply) => {
    const job = await queue.enqueue('data.health', { probe: true }, { dedupeKey: `data.health:probe:${Math.floor(Date.now() / 30_000)}` });
    return reply.code(202).send({ queued: job.created, jobId: job.id });
  });
  app.get('/v1/jobs', { schema: { tags: ['system'], summary: 'Recent jobs and workers' } }, async () => listJobs(ctx));
  app.post('/v1/jobs/:name', { schema: { tags: ['system'], summary: 'Queue a job now', params: z.object({ name: z.enum(JOB_NAMES) }), body: z.record(z.string(), z.unknown()).default({}) } }, async (req, reply) => {
    const job = await queue.enqueue(req.params.name, req.body, { dedupeKey: `${req.params.name}:manual:${Math.floor(Date.now() / 10_000)}`, priority: 40 });
    return reply.code(202).send({ queued: job.created, jobId: job.id });
  });
  app.get('/v1/notifications', { schema: { tags: ['system'], summary: 'Notifications', querystring: z.object({ unread: z.coerce.boolean().optional() }) } }, async (req) => listNotifications(ctx, req.query.unread));
  app.post('/v1/notifications/read', { schema: { tags: ['system'], summary: 'Mark notifications read', body: z.object({ ids: z.array(uuid).max(500).optional() }) } }, async (req) => {
    await markNotificationsRead(ctx, req.body.ids);
    return { ok: true };
  });

  app.get('/v1/settings', { schema: { tags: ['settings'], summary: 'Configuration (secrets redacted) and runtime settings' } }, async () => settingsView(ctx));
  app.put(
    '/v1/settings/scoring-weights',
    { schema: { tags: ['settings'], summary: 'Override opportunity-score weights', body: z.object(Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, z.number().min(0).max(1).optional()]))) } },
    async (req) => {
      const body = req.body as Record<string, number | undefined>;
      const merged = { ...DEFAULT_WEIGHTS, ...body };
      if (Object.values(merged).reduce((a, b) => a + (b ?? 0), 0) <= 0) throw new ValidationError('weights must not all be zero');
      await putSetting(ctx.db, SETTING_KEYS.scoringWeights, body, req.actor.id);
      await audit(ctx.db, req.actor, 'SETTINGS_CHANGED', { type: 'settings', id: SETTING_KEYS.scoringWeights }, body);
      return settingsView(ctx);
    },
  );
  app.put(
    '/v1/settings/gate-thresholds',
    { schema: { tags: ['settings'], summary: 'Override quality-gate thresholds', body: z.object(Object.fromEntries(Object.keys(DEFAULT_THRESHOLDS).map((k) => [k, z.number().min(0).optional()]))) } },
    async (req) => {
      await putSetting(ctx.db, SETTING_KEYS.gateThresholds, req.body, req.actor.id);
      await audit(ctx.db, req.actor, 'SETTINGS_CHANGED', { type: 'settings', id: SETTING_KEYS.gateThresholds }, req.body as Record<string, unknown>);
      return settingsView(ctx);
    },
  );

}

import { loadConfig, silentLogger } from '@aoc/core';
import { createTestDatabase, experiments, jobRuns, type DatabaseHandle } from '@aoc/database';
import { JobQueue } from '@aoc/jobs';
import { createContext, seed, type PlatformContext } from '@aoc/platform';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };

let h: DatabaseHandle;
let ctx: PlatformContext;
let app: FastifyInstance;

beforeAll(async () => {
  h = await createTestDatabase();
  const config = loadConfig({ DATABASE_URL: 'memory://', API_TOKEN: TOKEN, MARKET_DATA_ENABLED: 'false', RESEARCH_MONITOR_ENABLED: 'false', ANTHROPIC_API_KEY: 'sk-ant-should-never-leak' });
  ctx = createContext({ db: h.db, config, logger: silentLogger(), fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch });
  await seed(ctx, { startStarters: false });
  app = await buildApp({ ctx, queue: new JobQueue(h.db, { workerId: 'test', leaseMs: 60_000 }), logger: false });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

const get = (url: string, headers: Record<string, string> = auth) => app.inject({ method: 'GET', url, headers });
const post = (url: string, payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers });
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as Record<string, unknown>, headers: auth });

async function newExperiment(strategyId = 'trading.momentum', name?: string) {
  const res = await post('/v1/experiments', { strategyId, name: name ?? `API test ${strategyId} ${Math.random().toString(36).slice(2, 8)}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().experiment as { id: string; slug: string; status: string };
}

describe('authentication', () => {
  it('leaves liveness, readiness and docs open', async () => {
    expect((await get('/health', {})).statusCode).toBe(200);
    expect((await get('/health/ready', {})).json()).toEqual({ status: 'ready' });
    const spec = await get('/docs/json', {});
    expect(spec.statusCode).toBe(200);
    expect(Object.keys(spec.json().paths)).toContain('/v1/experiments');
  });

  it('rejects requests without or with a wrong token', async () => {
    expect((await get('/v1/dashboard', {})).statusCode).toBe(401);
    expect((await get('/v1/dashboard', { authorization: 'Bearer wrong-token-0123456789ab' })).statusCode).toBe(401);
    expect((await get('/v1/dashboard', { authorization: TOKEN })).statusCode).toBe(401);
    expect((await get('/v1/dashboard')).statusCode).toBe(200);
  });

  it('records the API user as the actor in the audit log', async () => {
    const exp = await newExperiment();
    const res = await get(`/v1/logs/audit?experimentId=${exp.id}`);
    expect(res.json().some((r: { actorType: string; actorId: string }) => r.actorType === 'USER' && r.actorId === 'api-token')).toBe(true);
  });
});

describe('validation and errors', () => {
  it('returns 400 with issues for an invalid body', async () => {
    const res = await post('/v1/experiments', { strategyId: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('returns 404 for unknown experiments and strategy modules', async () => {
    expect((await get('/v1/experiments/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await post('/v1/experiments', { strategyId: 'trading.does-not-exist' })).statusCode).toBe(404);
  });

  it('rejects invalid strategy parameters', async () => {
    const res = await post('/v1/experiments', { strategyId: 'trading.momentum', params: { lookbackBars: -5 } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-http source URLs', async () => {
    const res = await post('/v1/research/sources', { sourceType: 'WEBSITE', title: 'bad link', url: 'javascript:alert(1)' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown job names', async () => {
    expect((await post('/v1/jobs/not.a.job', {})).statusCode).toBe(400);
  });
});

describe('experiments', () => {
  it('creates, reads by id and slug, and lists with filters', async () => {
    const exp = await newExperiment('trading.mean-reversion', 'API mean reversion probe');
    expect(exp.status).toBe('DISCOVERED');
    expect((await get(`/v1/experiments/${exp.id}`)).json().experiment.id).toBe(exp.id);
    expect((await get(`/v1/experiments/${exp.slug}`)).json().experiment.id).toBe(exp.id);
    const list = (await get('/v1/experiments?search=mean%20reversion%20probe')).json();
    expect(list.map((e: { id: string }) => e.id)).toContain(exp.id);
    const byStatus = (await get('/v1/experiments?status=DISCOVERED&kind=TRADING')).json();
    expect(byStatus.every((e: { status: string; kind: string }) => e.status === 'DISCOVERED' && e.kind === 'TRADING')).toBe(true);
  });

  it('enforces the lifecycle: start, pause, resume, archive; invalid moves are 409', async () => {
    const exp = await newExperiment();
    const act = (action: string) => post(`/v1/experiments/${exp.id}/actions`, { action, reason: 'api test' });
    expect((await act('resume')).statusCode).toBe(409);
    expect((await act('start')).json().experiment.status).toBe('RESEARCHING');
    expect((await act('pause')).json().experiment.status).toBe('PAUSED');
    expect((await act('resume')).json().experiment.status).toBe('RESEARCHING');
    expect((await act('archive')).json().experiment.status).toBe('ARCHIVED');
    expect((await act('revive')).json().experiment.status).toBe('RESEARCHING');
  });

  it('versions are immutable and numbered', async () => {
    const exp = await newExperiment();
    const res = await post(`/v1/experiments/${exp.id}/versions`, { params: { lookbackBars: 48 }, changeNote: 'shorter lookback' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().label).toBe('v1.1');
    const major = await post(`/v1/experiments/${exp.id}/versions`, { params: { lookbackBars: 96 }, changeNote: 'rethink', bump: 'major', status: 'CANDIDATE' });
    expect(major.json().label).toBe('v2');
    const versions = (await get(`/v1/experiments/${exp.id}/versions`)).json();
    expect(versions.map((v: { version: { label: string; status: string } }) => `${v.version.label}:${v.version.status}`).sort()).toEqual(['v1.1:ACTIVE', 'v1:SUPERSEDED', 'v2:CANDIDATE']);
    const promoted = await post(`/v1/experiments/${exp.id}/versions/${major.json().id}/promote`, {});
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().currentVersion.label).toBe('v2');
    // Parameters of a stored version cannot be changed, even directly in the database.
    await expect(h.db.execute(sql`UPDATE experiment_versions SET params = '{}'::jsonb WHERE id = ${major.json().id}`)).rejects.toThrow();
  });

  it('validates risk limits and records a compliance blocker as FAILED', async () => {
    const exp = await newExperiment();
    expect((await put(`/v1/experiments/${exp.id}/risk-limits`, { maxDrawdownPct: 2 })).statusCode).toBe(400);
    const ok = await put(`/v1/experiments/${exp.id}/risk-limits`, { maxDrawdownPct: 0.1, maxPositions: 3 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ maxDrawdownPct: 0.1, maxPositions: 3 });
    const blocked = await put(`/v1/experiments/${exp.id}/compliance/TERMS_OF_SERVICE`, { state: 'BLOCKER', note: 'venue forbids automated access' });
    expect(blocked.statusCode, blocked.body).toBe(200);
    const after = (await get(`/v1/experiments/${exp.id}`)).json().experiment;
    expect(after.status).toBe('FAILED');
    expect(after.failureReasons).toContain('COMPLIANCE_BLOCKER');
  });

  it('compares experiments', async () => {
    const a = await newExperiment();
    const b = await newExperiment('trading.breakout');
    const res = await get(`/v1/compare?ids=${a.id},${b.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows ?? res.json()).toHaveLength(2);
    expect((await get('/v1/compare?ids=not-a-uuid')).statusCode).toBe(400);
  });

  it('queues a Strategy Lab run (deduplicated)', async () => {
    const exp = await newExperiment();
    const first = await post(`/v1/experiments/${exp.id}/lab`, {});
    expect(first.statusCode).toBe(202);
    expect(first.json().queued).toBe(true);
    const second = await post(`/v1/experiments/${exp.id}/lab`, {});
    expect(second.json().queued).toBe(false);
    const jobs = await h.db.select().from(jobRuns).where(eq(jobRuns.name, 'lab.run'));
    expect(jobs.filter((j) => (j.payload as { experimentId?: string }).experimentId === exp.id)).toHaveLength(1);
  });
});

describe('ideas and research', () => {
  it('adds an idea once; duplicates are 409', async () => {
    const idea = { name: 'Invoice reminder agent for freelancers', category: 'AI_AGENT_SERVICE', description: 'Chases overdue invoices politely by email with an opt-out link.', suggestedStrategyId: 'business.ai-support-agent' };
    const first = await post('/v1/ideas', idea);
    expect(first.statusCode, first.body).toBe(201);
    expect((await post('/v1/ideas', { ...idea, name: 'invoice  reminder agent for FREELANCERS' })).statusCode).toBe(409);
    const conv = await post(`/v1/ideas/${first.json().id}/convert`, { startResearch: true });
    expect(conv.statusCode, conv.body).toBe(201);
    const exp = (await get(`/v1/experiments/${conv.json().experimentId}`)).json().experiment;
    expect(exp.status).toBe('RESEARCHING');
  });

  it('adds a research source and links it to an experiment', async () => {
    const exp = await newExperiment();
    const res = await post('/v1/research/sources', { sourceType: 'PAPER', title: 'Time series momentum', url: 'https://example.org/tsmom-paper', experimentId: exp.id, summary: 'reference' });
    expect(res.statusCode, res.body).toBe(201);
    const detail = (await get(`/v1/experiments/${exp.id}`)).json();
    expect(detail.sources.map((s: { url: string }) => s.url)).toContain('https://example.org/tsmom-paper');
  });
});

describe('safety', () => {
  it('reports live trading as disabled with reasons, whatever the configuration', async () => {
    const res = (await get('/v1/live/status')).json();
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/no live executor/);
  });

  it('never exposes secrets in settings', async () => {
    const body = (await get('/v1/settings')).body;
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain('sk-ant-should-never-leak');
    expect(JSON.parse(body).mode.liveEnabled).toBe(false);
  });

  it('emergency stop pauses automated experiments and blocks resuming until released', async () => {
    const exp = await newExperiment();
    await post(`/v1/experiments/${exp.id}/actions`, { action: 'start' });
    const idle = await newExperiment();
    const stop = await post('/v1/risk/emergency-stop', { reason: 'api test stop' });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json().state.engaged).toBe(true);
    const [row] = await h.db.select().from(experiments).where(eq(experiments.id, exp.id));
    expect(row!.status).toBe('PAUSED');
    const [untouched] = await h.db.select().from(experiments).where(eq(experiments.id, idle.id));
    expect(untouched!.status).toBe('DISCOVERED');
    expect((await get('/v1/risk')).json().emergencyStop.engaged).toBe(true);
    expect((await post(`/v1/experiments/${idle.id}/actions`, { action: 'start' })).statusCode).toBe(423);
    expect((await post(`/v1/experiments/${exp.id}/actions`, { action: 'resume' })).statusCode).toBe(423);
    const release = await post('/v1/risk/emergency-stop/release', { reason: 'all clear' });
    expect(release.json().state.engaged).toBe(false);
    expect((await post(`/v1/experiments/${exp.id}/actions`, { action: 'resume' })).json().experiment.status).toBe('RESEARCHING');
  });

  it('validates and audits settings changes', async () => {
    const res = await put('/v1/settings/scoring-weights', { profit: 0.3 });
    expect(res.statusCode).toBe(200);
    expect(res.json().scoringWeights.overrides).toEqual({ profit: 0.3 });
    expect((await put('/v1/settings/scoring-weights', { profit: 3 })).statusCode).toBe(400);
  });
});

describe('read models', () => {
  it('serves every page model', async () => {
    for (const url of ['/v1/dashboard', '/v1/system/health', '/v1/strategies', '/v1/strategies/trading.momentum', '/v1/portfolio', '/v1/performance', '/v1/research/sources', '/v1/ideas', '/v1/ideas/prompts', '/v1/logs/events', '/v1/risk', '/v1/data-sources', '/v1/jobs', '/v1/notifications', '/v1/settings']) {
      const res = await get(url);
      expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
    }
  });

  it('dashboard shows NO DATA instead of invented profit before any run', async () => {
    const res = (await get('/v1/dashboard')).json();
    expect(JSON.stringify(res)).not.toMatch(/guaranteed/i);
    expect(res.totalSimulatedProfit.paper).toBeNull();
    expect(res.totalSimulatedProfit.simulatedOperations).toBeNull();
    expect(res.totalCapitalSimulated).toBeNull();
    expect(res.averageScore).toBeNull();
    expect(res.bestStrategy).toBeNull();
  });

  it('exposes Prometheus metrics', async () => {
    const res = await get('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/aoc_experiments\{status="DISCOVERED"\} \d+/);
    expect(res.body).toMatch(/aoc_emergency_stop [01]/);
  });
});

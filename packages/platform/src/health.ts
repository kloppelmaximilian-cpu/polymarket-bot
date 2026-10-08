import type { ComponentHealth } from '@aoc/core';
import { dataSources, jobRuns, workerHeartbeats } from '@aoc/database';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PlatformContext } from './context';
import { getEmergencyStop } from './settings';

export interface ComponentStatus {
  component: 'System' | 'API' | 'Database' | 'Workers' | 'Data Sources' | 'Research Agent' | 'Paper Engine';
  status: ComponentHealth;
  detail: string;
}

const worst = (xs: ComponentHealth[]): ComponentHealth => (xs.includes('OFFLINE') ? 'OFFLINE' : xs.includes('DEGRADED') ? 'DEGRADED' : 'ONLINE');

/** Latest run and latest successful run of a job; runs that only skipped themselves do not count. */
async function lastJob(ctx: PlatformContext, name: string) {
  const ran = and(eq(jobRuns.name, name), sql`${jobRuns.result}->>'skipped' IS NULL`);
  const [row] = await ctx.db.select().from(jobRuns).where(ran).orderBy(desc(jobRuns.createdAt)).limit(1);
  const [ok] = await ctx.db
    .select()
    .from(jobRuns)
    .where(and(ran, eq(jobRuns.status, 'SUCCEEDED')))
    .orderBy(desc(jobRuns.finishedAt))
    .limit(1);
  return { last: row ?? null, lastOk: ok ?? null };
}

/** Health of every component, each ONLINE / DEGRADED / OFFLINE with a reason. */
export async function systemHealth(ctx: PlatformContext, apiStatus: ComponentHealth = 'ONLINE'): Promise<{ components: ComponentStatus[]; emergencyStop: boolean; mode: string }> {
  const now = ctx.clock.now().getTime();
  const out: ComponentStatus[] = [{ component: 'API', status: apiStatus, detail: apiStatus === 'ONLINE' ? 'responding' : 'not responding' }];

  let dbStatus: ComponentHealth = 'OFFLINE';
  let dbDetail = '';
  try {
    const started = performance.now();
    await ctx.db.select({ k: dataSources.id }).from(dataSources).limit(1);
    const ms = Math.round(performance.now() - started);
    dbStatus = ms > 1000 ? 'DEGRADED' : 'ONLINE';
    dbDetail = `query ${ms} ms`;
  } catch (e) {
    dbDetail = `unreachable: ${(e as Error).message}`;
  }
  out.push({ component: 'Database', status: dbStatus, detail: dbDetail });
  if (dbStatus === 'OFFLINE') {
    return { components: [{ component: 'System', status: 'OFFLINE', detail: 'database unreachable' }, ...out], emergencyStop: false, mode: 'PAPER' };
  }

  const beats = await ctx.db.select().from(workerHeartbeats);
  const alive = beats.filter((b) => b.status === 'RUNNING' && now - b.lastSeenAt.getTime() < 60_000);
  const late = beats.filter((b) => b.status === 'RUNNING' && now - b.lastSeenAt.getTime() < 300_000);
  out.push({
    component: 'Workers',
    status: alive.length > 0 ? 'ONLINE' : late.length > 0 ? 'DEGRADED' : 'OFFLINE',
    detail: alive.length > 0 ? `${alive.length} worker(s) running` : late.length > 0 ? 'heartbeat late' : 'no worker heartbeat — start the worker',
  });

  const sources = await ctx.db.select().from(dataSources).where(eq(dataSources.kind, 'MARKET_DATA'));
  const enabled = sources.filter((s) => s.enabled);
  const connected = enabled.filter((s) => s.status === 'CONNECTED');
  out.push({
    component: 'Data Sources',
    status: enabled.length === 0 ? 'OFFLINE' : connected.length === enabled.length ? 'ONLINE' : connected.length > 0 || enabled.some((s) => s.status === 'DEGRADED' || s.status === 'STALE') ? 'DEGRADED' : 'OFFLINE',
    detail: !ctx.config.MARKET_DATA_ENABLED ? 'disabled by configuration (MARKET_DATA_ENABLED=false): finance experiments use DEMO data' : enabled.length === 0 ? 'not yet checked' : `${connected.length}/${enabled.length} connected`,
  });

  const research = await lastJob(ctx, 'research.monitor');
  out.push({
    component: 'Research Agent',
    status: !ctx.config.RESEARCH_MONITOR_ENABLED ? 'OFFLINE' : research.last?.status === 'SUCCEEDED' ? 'ONLINE' : research.last && ['FAILED', 'DEAD'].includes(research.last.status) ? 'DEGRADED' : research.lastOk ? 'ONLINE' : 'OFFLINE',
    detail: !ctx.config.RESEARCH_MONITOR_ENABLED ? 'disabled by configuration' : research.lastOk?.finishedAt ? `last successful run ${research.lastOk.finishedAt.toISOString()}` : 'no successful run yet',
  });

  const paper = await lastJob(ctx, 'paper.tick');
  const okAge = paper.lastOk?.finishedAt ? now - paper.lastOk.finishedAt.getTime() : Infinity;
  out.push({
    component: 'Paper Engine',
    status: okAge < 10 * 60_000 ? (paper.last && ['FAILED', 'DEAD'].includes(paper.last.status) ? 'DEGRADED' : 'ONLINE') : paper.last ? 'DEGRADED' : 'OFFLINE',
    detail: paper.lastOk?.finishedAt ? `last tick ${paper.lastOk.finishedAt.toISOString()}` : 'no paper tick yet',
  });

  const stop = await getEmergencyStop(ctx.db);
  // The platform is OFFLINE only when a core component is; anything else degrades it.
  const core = out.filter((c) => c.component === 'API' || c.component === 'Database' || c.component === 'Workers');
  const system: ComponentHealth = stop.engaged || worst(out.map((c) => c.status)) !== 'ONLINE' ? (worst(core.map((c) => c.status)) === 'OFFLINE' ? 'OFFLINE' : 'DEGRADED') : 'ONLINE';
  const notOnline = out.filter((c) => c.status !== 'ONLINE').map((c) => `${c.component} ${c.status}`);
  return {
    components: [{ component: 'System', status: system, detail: stop.engaged ? `EMERGENCY STOP engaged: ${stop.reason}` : system === 'ONLINE' ? 'all components online' : notOnline.join(', ') }, ...out],
    emergencyStop: stop.engaged,
    mode: ctx.config.TRADING_MODE === 'live' ? 'LIVE REQUESTED — DISABLED (no live executor)' : 'PAPER',
  };
}

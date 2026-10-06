import { ConflictError, ManualClock, loadConfig, silentLogger, d } from '@aoc/core';
import { createTestDatabase, experimentVersions, experiments, paperAccounts, paperTransactions, riskEvents, scores, strategyRuns, type DatabaseHandle } from '@aoc/database';
import { verifyLedger } from '@aoc/paper-engine';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SYSTEM,
  advanceAll,
  advanceExperiment,
  createContext,
  createVersion,
  dashboard,
  engageEmergencyStop,
  experimentDetail,
  generateIdeas,
  getEmergencyStop,
  listExperiments,
  paperTickAll,
  persistChanges,
  promoteVersion,
  releaseEmergencyStop,
  runLab,
  scoreAll,
  seed,
  setStatusByUser,
  systemHealth,
  triageIdeas,
  updateRiskLimits,
  versionComparison,
  withAccount,
  loadEngineState,
  type PlatformContext,
} from '../src';
import { PaperAccount } from '@aoc/paper-engine';

let h: DatabaseHandle;
let ctx: PlatformContext;
const clock = new ManualClock('2026-06-01T00:00:00Z');
const user = { type: 'USER' as const, id: 'tester' };

beforeAll(async () => {
  h = await createTestDatabase();
  // Market data disabled: finance experiments must fall back to clearly labelled DEMO data.
  const config = loadConfig({ DATABASE_URL: 'memory://', MARKET_DATA_ENABLED: 'false', RESEARCH_MONITOR_ENABLED: 'false', BUSINESS_PAPER_DAYS_PER_TICK: '5' });
  ctx = createContext({ db: h.db, config, logger: silentLogger(), clock, fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch });
}, 120_000);

afterAll(async () => h?.close());

async function runPipelineUntilStable(max = 10) {
  for (let i = 0; i < max; i++) {
    const steps = await advanceAll(ctx, { maxBacktests: 20 });
    if (!steps.some((s) => s.to)) return;
  }
}

describe('platform end to end (embedded Postgres, no network)', () => {
  it('seeds the starter experiments idempotently', async () => {
    const first = await seed(ctx);
    expect(first.created).toHaveLength(19);
    const second = await seed(ctx);
    expect(second.created).toHaveLength(0);
    const rows = await h.db.select().from(experiments);
    expect(rows.filter((r) => r.status === 'RESEARCHING')).toHaveLength(11);
    expect(rows.filter((r) => r.status === 'DISCOVERED')).toHaveLength(8);
  }, 60_000);

  it('runs research → backtest suite → paper for every starter, labelling DEMO results', async () => {
    await runPipelineUntilStable();
    const rows = await h.db.select().from(experiments);
    const starters = rows.filter((r) => r.status !== 'DISCOVERED');
    // DEMO results can never fail a finance experiment: all six reach paper testing.
    for (const r of starters.filter((x) => x.kind !== 'BUSINESS')) expect(r.status, `${r.name}: ${r.statusReason}`).toBe('PAPER');
    // Business models either start their simulated operation or were rejected by their own estimate.
    for (const r of starters.filter((x) => x.kind === 'BUSINESS')) {
      expect(['PAPER', 'FAILED', 'PROBATION'], `${r.name}: ${r.statusReason}`).toContain(r.status);
      if (r.status === 'FAILED') expect(r.failureReasons.every((f) => ['NEGATIVE_EV', 'HIGH_COST'].includes(f))).toBe(true);
    }
    const accounts = await h.db.select().from(paperAccounts);
    expect(accounts.filter((a) => a.provenance === 'PAPER')).toHaveLength(6);
    expect(accounts.filter((a) => a.provenance === 'SIMULATED').length).toBe(starters.filter((x) => x.kind === 'BUSINESS' && x.status === 'PAPER').length);
    // Finance backtests ran on DEMO data because market data is disabled.
    const runs = await h.db.select().from(strategyRuns).where(eq(strategyRuns.runType, 'BACKTEST'));
    expect(runs.length).toBe(6);
    for (const r of runs) {
      expect(r.provenance).toBe('DEMO');
      expect(JSON.stringify(r.result)).toMatch(/DEMO/);
    }
    const sims = await h.db.select().from(strategyRuns).where(eq(strategyRuns.runType, 'SIMULATION'));
    expect(sims).toHaveLength(5);
    for (const s of sims) expect(s.provenance).toBe('ESTIMATED');
    const tradingFund = accounts.filter((a) => a.provenance === 'PAPER').reduce((s, a) => s.plus(a.startingCapital), d(0));
    expect(tradingFund.toNumber()).toBe(6000);
    const simBudget = accounts.filter((a) => a.provenance === 'SIMULATED').reduce((s, a) => s.plus(a.startingCapital), d(0));
    expect(simBudget.toNumber()).toBeLessThanOrEqual(20_000);
  }, 300_000);

  it('paper ticks advance simulated businesses and keep every ledger exact', async () => {
    for (let i = 0; i < 6; i++) {
      clock.advance(60_000);
      await paperTickAll(ctx);
    }
    const accounts = await h.db.select().from(paperAccounts);
    for (const a of accounts) {
      const tx = await h.db.select().from(paperTransactions).where(eq(paperTransactions.accountId, a.id));
      const check = verifyLedger(tx.map((t) => ({ seq: t.seq, amount: t.amount, balanceAfter: t.balanceAfter })), a.cash);
      expect(check.problems, a.name).toEqual([]);
      const [e] = await h.db.select().from(experiments).where(eq(experiments.id, a.experimentId));
      if (a.provenance === 'SIMULATED' && e!.status === 'PAPER') expect(a.simulatedDays).toBe(30);
    }
    // With market data disabled, finance accounts record the data problem instead of trading on nothing.
    const fin = accounts.find((a) => a.provenance === 'PAPER')!;
    expect((fin.strategyState as { meta: { ticks: number; dataTicks: number } }).meta.ticks).toBe(6);
    expect((fin.strategyState as { meta: { ticks: number; dataTicks: number } }).meta.dataTicks).toBe(0);
  }, 120_000);

  it('scores without inventing profit: DEMO finance has NO DATA profit and LOW confidence', async () => {
    await scoreAll(ctx);
    const list = await listExperiments(ctx);
    const finance = list.filter((e) => e.kind !== 'BUSINESS' && e.status === 'PAPER');
    for (const e of finance) {
      expect(e.score, e.name).not.toBeNull();
      expect(e.score!.components.profit).toBeNull();
      expect(e.score!.confidence).toBe('LOW');
      expect(e.evidence).toBe('DEMO');
    }
    const biz = list.filter((e) => e.kind === 'BUSINESS');
    for (const e of biz) expect(e.score!.evidence).toBe('ESTIMATED');
    const ranks = list.filter((e) => e.score).map((e) => e.score!.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  }, 120_000);

  it('builds the dashboard with paper and simulated money kept apart', async () => {
    const dash = await dashboard(ctx);
    const running = (await h.db.select().from(experiments)).filter((e) => e.status === 'PAPER');
    expect(dash.totals.totalExperiments).toBe(19);
    expect(dash.totals.activeExperiments).toBe(running.length + (await h.db.select().from(experiments).where(eq(experiments.status, 'PROBATION'))).length);
    expect(dash.paperPortfolio.activeAccounts).toBe(6);
    // A business stopped by its risk limits keeps its (frozen) account, so count accounts, not experiments.
    const simAccounts = (await h.db.select().from(paperAccounts)).filter((a) => a.provenance === 'SIMULATED' && a.status === 'ACTIVE');
    expect(dash.simulatedBusiness.activeAccounts).toBe(simAccounts.length);
    expect(dash.totalSimulatedProfit.note).toMatch(/never added together/);
    expect(dash.mode).toBe('PAPER');
    const detail = await experimentDetail(ctx, dash.topOpportunities[0]!.id);
    expect(detail.versions).toHaveLength(1);
    expect(detail.compliance.length).toBeGreaterThan(0);
  }, 60_000);

  it('emergency stop pauses everything, blocks paper orders, and release does not auto-resume', async () => {
    const before = await h.db.select().from(experiments);
    const running = before.filter((e) => !['DISCOVERED', 'PAUSED', 'FAILED', 'ARCHIVED'].includes(e.status)).length;
    const pausedBefore = before.filter((e) => e.status === 'PAUSED').length;
    const res = await engageEmergencyStop(ctx, 'test drill', user);
    expect(res.paused).toBe(running);
    expect((await getEmergencyStop(h.db)).engaged).toBe(true);
    const [acct] = await h.db.select().from(paperAccounts).where(eq(paperAccounts.provenance, 'PAPER')).limit(1);
    const outcome = await withAccount(ctx, acct!.id, async (engine) => {
      const r = engine.submitOrder({ clientOrderId: 'manual-test', instrument: { venue: 'binance', symbol: 'BTCUSDT', kind: 'SPOT', feeModel: { type: 'none' } }, side: 'BUY', type: 'MARKET', quantity: '0.001' }, { ts: clock.now(), bid: 100, ask: 101, assumeInfiniteDepth: true });
      return { changes: [r.changes], result: r.order };
    });
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.rejectReason).toMatch(/emergency stop/);
    const health = await systemHealth(ctx);
    expect(health.emergencyStop).toBe(true);
    const [anyPaused] = await h.db.select().from(experiments).where(eq(experiments.status, 'PAUSED')).limit(1);
    await expect(setStatusByUser(ctx, anyPaused!.id, 'resume', 'too early', user)).rejects.toThrow(/emergency stop is engaged/);
    await releaseEmergencyStop(ctx, 'drill over', user);
    expect((await h.db.select().from(experiments).where(eq(experiments.status, 'PAUSED'))).length).toBe(running + pausedBefore);
    // Resume by hand what the drill paused (not what a risk limit stopped before).
    const drill = (await h.db.select().from(experiments).where(eq(experiments.status, 'PAUSED'))).filter((e) => e.statusReason?.includes('test drill'));
    expect(drill).toHaveLength(running);
    const resumed = await setStatusByUser(ctx, drill[0]!.id, 'resume', 'checked', user);
    expect(resumed.status).toBe(drill[0]!.statusBeforePause);
    for (const e of drill.slice(1)) await setStatusByUser(ctx, e.id, 'resume', 'checked', user);
  }, 120_000);

  it('stops an experiment when a risk limit is breached', async () => {
    const [biz] = await h.db.select().from(experiments).where(and(eq(experiments.kind, 'BUSINESS'), eq(experiments.status, 'PAPER'))).limit(1);
    await updateRiskLimits(ctx, biz!.id, { maxApiSpend: 0.01 }, user);
    clock.advance(60_000);
    await paperTickAll(ctx);
    const [after] = await h.db.select().from(experiments).where(eq(experiments.id, biz!.id));
    expect(after!.status).toBe('PAUSED');
    expect(after!.statusReason).toMatch(/risk limit/);
    const ev = await h.db.select().from(riskEvents).where(eq(riskEvents.experimentId, biz!.id));
    expect(ev.some((e) => e.limitName === 'maxApiSpend')).toBe(true);
  }, 120_000);

  it('versions are immutable, comparable and promoted only on request', async () => {
    const [mom] = await h.db.select().from(experiments).where(eq(experiments.strategyId, 'trading.momentum'));
    const v2 = await createVersion(ctx, mom!.id, { params: { lookbackBars: 72 }, changeNote: 'longer lookback', status: 'CANDIDATE' }, user);
    expect(v2.label).toBe('v1.1');
    await expect(h.db.update(experimentVersions).set({ params: { lookbackBars: 1 } }).where(eq(experimentVersions.id, v2.id))).rejects.toThrow();
    const cmp = await versionComparison(ctx, mom!.id);
    expect(cmp.map((c) => c.version.label)).toEqual(['v1', 'v1.1']);
    await promoteVersion(ctx, mom!.id, v2.id, user);
    const [after] = await h.db.select().from(experiments).where(eq(experiments.id, mom!.id));
    expect(after!.currentVersionId).toBe(v2.id);
    expect(after!.status).toBe('EVALUATING');
    // The pipeline re-runs the suite for the new version, then paper-tests it with a fresh account.
    await advanceExperiment(ctx, mom!.id);
    await advanceExperiment(ctx, mom!.id);
    await advanceExperiment(ctx, mom!.id);
    const [final] = await h.db.select().from(experiments).where(eq(experiments.id, mom!.id));
    expect(final!.status).toBe('PAPER');
    const accts = await h.db.select().from(paperAccounts).where(eq(paperAccounts.experimentId, mom!.id));
    expect(accts.filter((a) => a.status === 'ACTIVE')).toHaveLength(1);
    expect(accts.find((a) => a.status === 'ACTIVE')!.versionId).toBe(v2.id);
  }, 180_000);

  it('the Strategy Lab records its trials and does not promote anything by itself', async () => {
    const [mr] = await h.db.select().from(experiments).where(eq(experiments.strategyId, 'trading.mean-reversion'));
    const before = mr!.currentVersionId;
    const res = await runLab(ctx, mr!.id, user, 4);
    expect(res.trials).toBeGreaterThan(1);
    const lab = await h.db.select().from(strategyRuns).where(and(eq(strategyRuns.experimentId, mr!.id), eq(strategyRuns.runType, 'LAB')));
    expect(lab).toHaveLength(1);
    const [after] = await h.db.select().from(experiments).where(eq(experiments.id, mr!.id));
    expect(after!.currentVersionId).toBe(before);
    expect((after!.evaluation as { labTrials: number }).labTrials).toBeGreaterThan(1);
  }, 180_000);

  it('generates catalogue ideas and converts testable ones into DISCOVERED experiments', async () => {
    const gen = await generateIdeas(ctx, { focus: 'low-capital', count: 6 }, user);
    expect(gen.added).toBe(6);
    const tri = await triageIdeas(ctx, user, 2);
    expect(tri.converted).toBe(2);
    const fresh = await h.db.select().from(experiments).where(eq(experiments.status, 'DISCOVERED'));
    expect(fresh.length).toBe(10);
    const again = await generateIdeas(ctx, { focus: 'low-capital', count: 6 }, user);
    expect(again.added).toBeLessThanOrEqual(6);
  }, 60_000);

  it('detects concurrent writers to the same paper account', async () => {
    const [acct] = await h.db.select().from(paperAccounts).where(eq(paperAccounts.status, 'ACTIVE')).limit(1);
    const engine = PaperAccount.restore(await loadEngineState(h.db, acct!));
    const c = engine.mark('x', 'y', 1, clock.now());
    // Simulate another writer bumping the version first.
    await h.db.update(paperAccounts).set({ lockVersion: sql`${paperAccounts.lockVersion} + 1` }).where(eq(paperAccounts.id, acct!.id));
    await expect(h.db.transaction((tx) => persistChanges(tx, acct!, engine, [c], clock.now()))).rejects.toBeInstanceOf(ConflictError);
  });

  it('keeps score history', async () => {
    await scoreAll(ctx);
    const rows = await h.db.select().from(scores);
    expect(rows.length).toBeGreaterThanOrEqual(19);
  }, 120_000);
});

export { SYSTEM };

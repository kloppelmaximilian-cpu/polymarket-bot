import { mean, stdev, type ComplianceEntry, type Provenance, type RiskLevel, type RiskLimits } from '@aoc/core';
import { TradeTracker, maxDrawdown } from '@aoc/backtest';
import { paperAccounts, paperFills, paperOrders, performanceSnapshots, riskEvents, strategyRuns, type DbOrTx } from '@aoc/database';
import type { BusinessPaperEvidence, EvaluationEvidence, FinanceBacktestEvidence, FinancePaperEvidence } from '@aoc/experiments';
import { d } from '@aoc/core';
import type { FillState } from '@aoc/paper-engine';
import type { BusinessEvidence, FinanceEvidence, ScoringInput } from '@aoc/scoring';
import type { QualitativeProfile, TradeRecord } from '@aoc/strategies';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { PlatformContext } from './context';
import type { ExperimentRow, VersionRow } from './experiments';

type RunRow = typeof strategyRuns.$inferSelect;

export async function latestRuns(db: DbOrTx, versionId: string): Promise<Partial<Record<string, RunRow>>> {
  const rows = await db.select().from(strategyRuns).where(and(eq(strategyRuns.versionId, versionId), eq(strategyRuns.status, 'SUCCEEDED'))).orderBy(desc(strategyRuns.createdAt)).limit(50);
  const out: Partial<Record<string, RunRow>> = {};
  for (const r of rows) if (!out[r.runType]) out[r.runType] = r;
  return out;
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface PaperStats {
  accountId: string;
  provenance: Provenance;
  days: number;
  simulatedDays: number;
  trades: TradeRecord[];
  equity: number;
  startingCapital: number;
  netProfit: number;
  maxDrawdownPct: number;
  ordersTotal: number;
  ordersRejected: number;
  riskBreaches: number;
  dataUptime: number | null;
  equityCurve: Array<{ ts: number; equity: number }>;
}

/** The active (or most recent) paper account of an experiment and its record. */
export async function paperStats(ctx: PlatformContext, exp: ExperimentRow): Promise<PaperStats | null> {
  const [account] = await ctx.db
    .select()
    .from(paperAccounts)
    .where(eq(paperAccounts.experimentId, exp.id))
    .orderBy(sql`case when ${paperAccounts.status} = 'ACTIVE' then 0 else 1 end`, desc(paperAccounts.createdAt))
    .limit(1);
  if (!account) return null;
  const fills = await ctx.db.select().from(paperFills).where(eq(paperFills.accountId, account.id)).orderBy(asc(paperFills.ts));
  const tracker = new TradeTracker();
  for (const f of fills) {
    tracker.onFill({ id: f.id, orderId: f.orderId, venue: f.venue, symbol: f.symbol, side: f.side as FillState['side'], quantity: d(f.quantity), price: d(f.price), fee: d(f.fee), slippageCost: d(f.slippageCost), liquidity: f.liquidity as FillState['liquidity'], realizedPnl: d(f.realizedPnl), ts: f.ts });
  }
  const snaps = await ctx.db.select({ ts: performanceSnapshots.ts, equity: performanceSnapshots.equity }).from(performanceSnapshots).where(eq(performanceSnapshots.accountId, account.id)).orderBy(asc(performanceSnapshots.ts));
  const curve = snaps.map((s) => ({ ts: s.ts.getTime(), equity: Number(s.equity) }));
  const [orders] = await ctx.db
    .select({ total: sql<number>`count(*)::int`, rejected: sql<number>`count(*) filter (where ${paperOrders.status} = 'REJECTED')::int` })
    .from(paperOrders)
    .where(eq(paperOrders.accountId, account.id));
  const since = exp.paperStartedAt ?? account.createdAt;
  const [breaches] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(riskEvents)
    .where(and(eq(riskEvents.experimentId, exp.id), inArray(riskEvents.severity, ['BREACH', 'CRITICAL']), gte(riskEvents.createdAt, since)));
  const meta = ((account.strategyState as Record<string, unknown>).meta ?? {}) as { ticks?: number; dataTicks?: number };
  const starting = Number(account.startingCapital);
  const equity = curve.length > 0 ? curve[curve.length - 1]!.equity : Number(account.cash);
  return {
    accountId: account.id,
    provenance: account.provenance as Provenance,
    days: Math.max(0, (ctx.clock.now().getTime() - since.getTime()) / 86_400_000),
    simulatedDays: account.simulatedDays,
    trades: tracker.trades,
    equity,
    startingCapital: starting,
    netProfit: equity - starting,
    maxDrawdownPct: maxDrawdown(curve).pct,
    ordersTotal: orders?.total ?? 0,
    ordersRejected: orders?.rejected ?? 0,
    riskBreaches: breaches?.n ?? 0,
    dataUptime: meta.ticks ? (meta.dataTicks ?? 0) / meta.ticks : null,
    equityCurve: curve,
  };
}

export interface Evidence {
  evaluation: EvaluationEvidence;
  scoring: ScoringInput;
  paper: PaperStats | null;
  backtestProvenance: Provenance | null;
}

export async function buildEvidence(ctx: PlatformContext, exp: ExperimentRow, version: VersionRow): Promise<Evidence> {
  const m = ctx.registry.get(exp.strategyId);
  const runs = await latestRuns(ctx.db, version.id);
  const paper = await paperStats(ctx, exp);
  const limits = exp.riskLimits as unknown as RiskLimits;
  const compliance = exp.compliance as ComplianceEntry[];
  const qualitative = { ...m.meta.qualitative, ...(exp.qualitative as Partial<QualitativeProfile>) };
  const base = { kind: m.meta.kind, status: exp.status as ScoringInput['status'], riskLevel: exp.riskLevel as RiskLevel, capitalRequirement: Number(exp.capitalRequirement), qualitative, failureReasons: exp.failureReasons as ScoringInput['failureReasons'] };

  if (m.meta.kind === 'BUSINESS') {
    const sim = runs.SIMULATION;
    const s = (sim?.summary ?? null) as Record<string, any> | null;
    const estimate = s
      ? {
          probProfitableAtHorizon: s.probProfitableAtHorizon,
          breakEvenMonthP50: n(s.breakEvenMonthP50),
          cumulativeProfitP50: s.cumulativeProfit.p50,
          ltvToCac: n(s.ltvToCac),
          probRuin: s.probRuin,
          stressedProfitP50: s.stressedProfitP50,
          grossMarginPct: n(s.grossMarginPct),
          verifiedAssumptionShare: n(s.verifiedAssumptionShare) ?? 0,
        }
      : null;
    const businessPaper: BusinessPaperEvidence | null = paper ? { simulatedDays: paper.simulatedDays, cumulativeProfit: paper.netProfit, riskBreaches: paper.riskBreaches } : null;
    const businessScore: BusinessEvidence | null = s
      ? {
          provenance: 'ESTIMATED',
          probProfitableAtHorizon: s.probProfitableAtHorizon,
          breakEvenMonthP50: n(s.breakEvenMonthP50),
          cumulativeProfitP10: s.cumulativeProfit.p10,
          cumulativeProfitP50: s.cumulativeProfit.p50,
          cumulativeProfitP90: s.cumulativeProfit.p90,
          maxCashNeedP50: s.maxCashNeed.p50,
          ltvToCac: n(s.ltvToCac),
          probRuin: s.probRuin,
          stressedProfitP50: s.stressedProfitP50,
          horizonMonths: s.horizonMonths,
          verifiedAssumptionShare: n(s.verifiedAssumptionShare) ?? 0,
        }
      : null;
    return {
      evaluation: { kind: 'BUSINESS', estimate, businessPaper, compliance, maxDrawdownLimit: limits.maxDrawdownPct, supportsWalkForward: false },
      scoring: { ...base, business: businessScore },
      paper,
      backtestProvenance: sim ? 'ESTIMATED' : null,
    };
  }

  const bt = runs.BACKTEST;
  const s = (bt?.summary ?? null) as Record<string, any> | null;
  const wf = runs.WALK_FORWARD?.summary as Record<string, any> | undefined;
  const mc = runs.MONTE_CARLO?.summary as Record<string, any> | undefined;
  const sens = runs.SENSITIVITY?.summary as Record<string, any> | undefined;
  const evaluationSummary = (exp.evaluation ?? {}) as Record<string, any>;
  const backtest: FinanceBacktestEvidence | null =
    bt && s
      ? {
          provenance: bt.provenance as Provenance,
          trades: s.trades ?? 0,
          netProfit: s.netProfit ?? 0,
          expectancy: n(s.expectancy),
          grossExpectancy: n(s.grossExpectancy),
          tStat: n(s.tStat),
          sharpe: n(s.sharpe),
          maxDrawdownPct: s.maxDrawdownPct ?? 0,
          isSharpe: n(s.train?.sharpe),
          oosSharpe: n(s.test?.sharpe),
          oosNetReturnPct: n(s.test?.totalReturnPct),
          oosTrades: n(s.test?.trades),
          oosPsr: n(s.test?.psr),
          folds: n(wf?.folds),
          profitableFolds: n(wf?.profitableFolds),
          mcProbLoss: n(mc?.probLoss),
          mcDrawdownP95: n(mc?.maxDrawdownP95),
          costBreakEvenMultiplier: n(sens?.costBreakEvenMultiplier),
          profitableAt1_5x: typeof sens?.profitableAt1_5x === 'boolean' ? sens.profitableAt1_5x : null,
          dsr: n(evaluationSummary.dsr),
          paramStability: n(sens?.paramStability),
          capacityUsd: n(s.capacityUsd),
        }
      : null;

  let paperEvidence: FinancePaperEvidence | null = null;
  if (paper) {
    const pnl = paper.trades.map((t) => t.netPnl);
    const sd = stdev(pnl);
    paperEvidence = {
      days: paper.days,
      trades: paper.trades.length,
      netProfit: paper.netProfit,
      expectancy: pnl.length > 0 ? mean(pnl) : null,
      tStat: pnl.length >= 5 && sd > 0 ? mean(pnl) / (sd / Math.sqrt(pnl.length)) : null,
      maxDrawdownPct: paper.maxDrawdownPct,
      rejectedOrderShare: paper.ordersTotal > 0 ? paper.ordersRejected / paper.ordersTotal : null,
      riskBreaches: paper.riskBreaches,
      dataUptime: paper.dataUptime,
      returnPerTrade: paper.trades.length > 0 ? mean(paper.trades.map((t) => t.returnPct)) : null,
    };
  }

  // Scoring uses paper evidence once it is substantial, otherwise the backtest.
  const usePaper = paper && paper.trades.length >= 30;
  const finance: FinanceEvidence | null = usePaper
    ? {
        provenance: 'PAPER',
        trades: paper!.trades.length,
        annualizedReturnPct: paper!.days >= 7 && paper!.startingCapital > 0 && paper!.equity > 0 ? Math.pow(paper!.equity / paper!.startingCapital, 365 / paper!.days) - 1 : null,
        totalReturnPct: paper!.startingCapital > 0 ? paper!.netProfit / paper!.startingCapital : null,
        sharpe: null,
        maxDrawdownPct: paper!.maxDrawdownPct,
        expectancy: paperEvidence!.expectancy,
        psr: null,
        mcProbLoss: backtest?.mcProbLoss ?? null,
        profitableFoldsShare: null,
        capacityUsd: backtest?.capacityUsd ?? null,
        executionReliability: paperEvidence!.rejectedOrderShare !== null ? 1 - paperEvidence!.rejectedOrderShare : null,
        dataUptime: paper!.dataUptime,
      }
    : backtest && s
      ? {
          provenance: backtest.provenance,
          trades: backtest.trades,
          annualizedReturnPct: n(s.annualizedReturnPct),
          totalReturnPct: n(s.totalReturnPct),
          sharpe: backtest.sharpe,
          maxDrawdownPct: backtest.maxDrawdownPct,
          expectancy: backtest.expectancy,
          psr: n(s.psr),
          mcProbLoss: backtest.mcProbLoss,
          profitableFoldsShare: backtest.folds ? (backtest.profitableFolds ?? 0) / backtest.folds : null,
          capacityUsd: backtest.capacityUsd,
          executionReliability: null,
          dataUptime: null,
        }
      : null;

  return {
    evaluation: { kind: 'FINANCE', backtest, paper: paperEvidence, compliance, maxDrawdownLimit: limits.maxDrawdownPct, supportsWalkForward: m.meta.capabilities.walkForward },
    scoring: { ...base, finance },
    paper,
    backtestProvenance: (bt?.provenance as Provenance | undefined) ?? null,
  };
}

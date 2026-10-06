import { describeError, finiteOrNull, kurtosis, skewness, toDb, type Assumption, type Provenance, type RunType } from '@aoc/core';
import { blockBootstrapReturns, bootstrapTrades, costSensitivity, deflatedSharpe, neighbours, periodReturns, periodSharpe, stitchFolds, type CostSensitivity, type MonteCarloSummary } from '@aoc/backtest';
import { experiments, metrics as metricsTable, strategyRuns, type DbOrTx } from '@aoc/database';
import { eq } from 'drizzle-orm';
import type { RiskLimits } from '@aoc/core';
import type { AnyStrategyModule, BacktestResult, BusinessSimulationResult, DataBundle, EquityPoint, PerformanceMetrics, TradeRecord } from '@aoc/strategies';
import { acquireData } from './data';
import type { PlatformContext } from './context';
import type { ExperimentRow, VersionRow } from './experiments';

export function downsample(curve: EquityPoint[], max = 400): EquityPoint[] {
  if (curve.length <= max) return curve;
  const step = curve.length / max;
  const out: EquityPoint[] = [];
  for (let i = 0; i < max; i++) out.push(curve[Math.floor(i * step)]!);
  out.push(curve[curve.length - 1]!);
  return out;
}

function timeFolds(start: number, end: number, k: number): Array<{ index: number; startTs: number; endTs: number }> {
  const size = (end - start) / k;
  return Array.from({ length: k }, (_, i) => ({ index: i, startTs: Math.round(start + i * size), endTs: i === k - 1 ? end + 1 : Math.round(start + (i + 1) * size) }));
}

function compactMetrics(m: PerformanceMetrics): Record<string, number | null> {
  return {
    trades: m.trades,
    winRate: finiteOrNull(m.winRate),
    totalReturnPct: finiteOrNull(m.totalReturnPct),
    annualizedReturnPct: finiteOrNull(m.annualizedReturnPct),
    netProfit: finiteOrNull(m.netProfit),
    profitFactor: finiteOrNull(m.profitFactor),
    expectancy: finiteOrNull(m.expectancy),
    sharpe: finiteOrNull(m.sharpe),
    sortino: finiteOrNull(m.sortino),
    maxDrawdownPct: finiteOrNull(m.maxDrawdownPct),
    fees: finiteOrNull(m.fees),
    slippage: finiteOrNull(m.slippage),
    carry: finiteOrNull(m.carry),
    tStat: finiteOrNull(m.tStat),
    psr: finiteOrNull(m.psr),
  };
}

function tradeSample(trades: TradeRecord[]): TradeRecord[] {
  return trades.slice(-200);
}

interface RunInsert {
  runType: RunType;
  provenance: Provenance;
  datasetId: string | null;
  seed: string;
  config: Record<string, unknown>;
  summary: Record<string, unknown>;
  result: Record<string, unknown>;
  startedAt: Date;
  error?: string | null;
}

async function insertRun(db: DbOrTx, exp: ExperimentRow, version: VersionRow, r: RunInsert): Promise<string> {
  const finishedAt = new Date();
  const [row] = await db
    .insert(strategyRuns)
    .values({
      experimentId: exp.id,
      versionId: version.id,
      runType: r.runType,
      provenance: r.provenance,
      status: r.error ? 'FAILED' : 'SUCCEEDED',
      datasetId: r.datasetId,
      seed: r.seed,
      config: r.config,
      summary: r.summary,
      result: r.result,
      error: r.error ?? null,
      startedAt: r.startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - r.startedAt.getTime(),
    })
    .returning({ id: strategyRuns.id });
  return row!.id;
}

async function insertMetrics(db: DbOrTx, exp: ExperimentRow, version: VersionRow, runId: string, provenance: Provenance, values: Record<string, number | null | undefined>, period: string): Promise<void> {
  const rows = Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([name, value]) => ({ experimentId: exp.id, versionId: version.id, runId, name, value: finiteOrNull(value as number | null), provenance, period }));
  if (rows.length > 0) await db.insert(metricsTable).values(rows);
}

export interface FinanceSuiteResult {
  kind: 'FINANCE';
  provenance: Provenance;
  dataNotes: string[];
  realDataError: string | null;
  full: BacktestResult;
  train: BacktestResult | null;
  test: BacktestResult | null;
  walkForward: { folds: number; profitableFolds: number; oos: PerformanceMetrics } | null;
  monteCarlo: MonteCarloSummary | null;
  cost: CostSensitivity | null;
  paramStability: number | null;
  dsr: number | null;
  runIds: string[];
}

export interface BusinessSuiteResult {
  kind: 'BUSINESS';
  provenance: 'ESTIMATED';
  simulation: BusinessSimulationResult;
  runIds: string[];
}

/**
 * Everything the gates need, computed once per version and stored as runs.
 * Sub-steps that cannot run (e.g. a window too short) are recorded as notes;
 * they never fail the whole suite and never fake a value.
 */
export async function runEvaluationSuite(ctx: PlatformContext, exp: ExperimentRow, version: VersionRow, opts: { trials?: number; trialSharpeVariance?: number; keepAlive?: () => Promise<void> } = {}): Promise<FinanceSuiteResult | BusinessSuiteResult> {
  const m: AnyStrategyModule = ctx.registry.get(exp.strategyId);
  const params = version.params as Record<string, unknown>;
  const seed = `${exp.seed}/${version.label}`;
  const capital = Number(exp.paperCapital);
  const startedAt = new Date();

  if (m.meta.kind === 'BUSINESS') {
    if (!m.simulate) throw new Error(`${m.meta.id} cannot simulate`);
    const assumptions = version.assumptions as Assumption[];
    const limits = exp.riskLimits as unknown as RiskLimits;
    const simulate = (startingCapital: number) => m.simulate!({ params, assumptions, runs: 1000, horizonMonths: 24, seed, startingCapital });
    let simulation = simulate(capital);
    // The capital a business needs is an output of the estimate, not an input: size the
    // simulated budget to roughly the 70th percentile of the cash need, within the risk limit.
    const need = simulation.summary.maxCashNeed;
    const target = Math.ceil((need.p50 + 0.5 * (need.p90 - need.p50)) / 100) * 100;
    const budget = Math.min(Math.max(capital, target), limits.maxCapital);
    const capitalNote =
      target > limits.maxCapital
        ? `Estimated cash need (≈P70 ${target} USD) exceeds the experiment's max capital (${limits.maxCapital} USD); simulated with ${budget} USD.`
        : budget > capital
          ? `Simulated budget raised from ${capital} to ${budget} USD to cover the estimated cash need (≈P70).`
          : `Budget of ${capital} USD covers the estimated cash need (≈P70 ${target} USD).`;
    if (budget !== capital) simulation = simulate(budget);
    await ctx.db
      .update(experiments)
      .set({ paperCapital: toDb(budget), capitalRequirement: toDb(Math.ceil(need.p50 / 100) * 100), updatedAt: new Date() })
      .where(eq(experiments.id, exp.id));
    const s = simulation.summary;
    const runId = await insertRun(ctx.db, exp, version, {
      runType: 'SIMULATION',
      provenance: 'ESTIMATED',
      datasetId: null,
      seed,
      config: { params, runs: 1000, horizonMonths: 24, startingCapital: budget, assumptions },
      summary: { ...s, stressedProfitP50: simulation.stressedProfitP50, verifiedAssumptionShare: verifiedShare(assumptions), budget, estimatedCashNeedP50: need.p50, capitalNote },
      result: { months: simulation.months, sensitivity: simulation.sensitivity, notes: [...simulation.notes, capitalNote] },
      startedAt,
    });
    await insertMetrics(ctx.db, exp, version, runId, 'ESTIMATED', {
      prob_profitable_24m: s.probProfitableAtHorizon,
      prob_breakeven_12m: s.probBreakEvenWithin12m,
      breakeven_month_p50: s.breakEvenMonthP50,
      cumulative_profit_p10: s.cumulativeProfit.p10,
      cumulative_profit_p50: s.cumulativeProfit.p50,
      cumulative_profit_p90: s.cumulativeProfit.p90,
      max_cash_need_p50: s.maxCashNeed.p50,
      revenue_month12_p50: s.revenueMonth12.p50,
      ltv_to_cac: s.ltvToCac,
      prob_ruin: s.probRuin,
      stressed_profit_p50: simulation.stressedProfitP50,
    }, '24m');
    return { kind: 'BUSINESS', provenance: 'ESTIMATED', simulation, runIds: [runId] };
  }

  if (!m.backtest) throw new Error(`${m.meta.id} cannot backtest`);
  const data = await acquireData(ctx, m, params, seed);
  const bundle: DataBundle = data.bundle;
  const provenance: Provenance = bundle.provenance === 'HISTORICAL' ? 'HISTORICAL' : 'DEMO';
  const datasetId = data.datasetIds[0] ?? null;
  const notes = [...data.notes];
  const run = (window?: { startTs: number; endTs: number }, costMultiplier = 1) => m.backtest!({ params, data: bundle, initialCapital: capital, seed, window, costMultiplier });
  const runIds: string[] = [];
  const config = { params, capital, data: bundle.label, assumptions: version.assumptions, realDataError: data.realDataError };

  const full = run();
  await opts.keepAlive?.();
  const span = { start: full.startTs, end: full.endTs };
  const boundary = Math.round(span.start + (span.end - span.start) * 0.7);
  let train: BacktestResult | null = null;
  let test: BacktestResult | null = null;
  try {
    train = run({ startTs: span.start, endTs: boundary });
    test = run({ startTs: boundary, endTs: span.end + 1 });
  } catch (e) {
    notes.push(`train/test split skipped: ${describeError(e).message}`);
  }

  const fullRun = await insertRun(ctx.db, exp, version, {
    runType: 'BACKTEST',
    provenance,
    datasetId,
    seed,
    config,
    summary: {
      ...compactMetrics(full.metrics),
      capacityUsd: full.capacityUsd,
      grossExpectancy: full.grossExpectancy,
      train: train ? compactMetrics(train.metrics) : null,
      test: test ? compactMetrics(test.metrics) : null,
      splitAt: boundary,
    },
    result: { equityCurve: downsample(full.equityCurve), trades: tradeSample(full.trades), notes: [...notes, ...full.notes], testEquity: test ? downsample(test.equityCurve, 200) : null },
    startedAt,
  });
  runIds.push(fullRun);
  await insertMetrics(ctx.db, exp, version, fullRun, provenance, {
    ...Object.fromEntries(Object.entries(compactMetrics(full.metrics)).map(([k, v]) => [`full_${k}`, v])),
    oos_net_return: test?.metrics.totalReturnPct ?? null,
    oos_sharpe: test?.metrics.sharpe ?? null,
    is_sharpe: train?.metrics.sharpe ?? null,
    oos_trades: test?.metrics.trades ?? null,
  }, 'full');

  // Walk-forward over contiguous folds (no parameter fitting: the version's parameters are fixed).
  let walkForward: FinanceSuiteResult['walkForward'] = null;
  if (m.meta.capabilities.walkForward) {
    try {
      const folds = timeFolds(span.start, span.end, 5).map((fold) => ({ fold, result: run({ startTs: fold.startTs, endTs: fold.endTs }) }));
      const wf = stitchFolds(folds, capital, full.metrics.periodMs);
      walkForward = { folds: folds.length, profitableFolds: wf.profitableFolds, oos: wf.oosMetrics };
      runIds.push(
        await insertRun(ctx.db, exp, version, {
          runType: 'WALK_FORWARD',
          provenance,
          datasetId,
          seed,
          config: { ...config, folds: 5 },
          summary: { folds: folds.length, profitableFolds: wf.profitableFolds, ...compactMetrics(wf.oosMetrics) },
          result: { folds: folds.map((f) => ({ startTs: f.fold.startTs, endTs: f.fold.endTs, ...compactMetrics(f.result.metrics) })), oosEquity: downsample(wf.oosEquity, 300) },
          startedAt: new Date(),
        }),
      );
    } catch (e) {
      notes.push(`walk-forward skipped: ${describeError(e).message}`);
    }
  }
  await opts.keepAlive?.();

  // Monte Carlo: trade bootstrap if there are enough trades, else block bootstrap of period returns.
  const limits = exp.riskLimits as unknown as RiskLimits;
  const monteCarlo =
    bootstrapTrades(full.trades, capital, { seed, drawdownLimit: limits.maxDrawdownPct, paths: 2000 }) ??
    blockBootstrapReturns(periodReturns(full.equityCurve), capital, { seed, drawdownLimit: limits.maxDrawdownPct, paths: 1000 });
  if (monteCarlo) {
    runIds.push(await insertRun(ctx.db, exp, version, { runType: 'MONTE_CARLO', provenance, datasetId, seed, config, summary: { ...monteCarlo }, result: {}, startedAt: new Date() }));
  } else {
    notes.push('Monte Carlo skipped: fewer than 5 trades and fewer than 20 return periods');
  }

  // Cost and parameter sensitivity.
  let cost: CostSensitivity | null = null;
  let paramStability: number | null = null;
  try {
    cost = costSensitivity((mult) => {
      const r = run(undefined, mult);
      return { netProfit: r.metrics.netProfit, trades: r.trades.length };
    }, [0.5, 1, 1.5, 2]);
    const ns = neighbours(params, m.meta.paramSpace).slice(0, 6);
    if (ns.length > 0 && full.trades.length > 0) {
      const base = full.metrics.netProfit;
      const results = ns.map((n) => {
        const r = m.backtest!({ params: ctx.registry.parseParams(exp.strategyId, n.params), data: bundle, initialCapital: capital, seed });
        return { param: n.param, value: n.value, netProfit: r.metrics.netProfit };
      });
      const stable = results.filter((r) => Math.sign(r.netProfit) === Math.sign(base) && Math.abs(r.netProfit) >= 0.5 * Math.abs(base)).length;
      paramStability = stable / results.length;
      runIds.push(
        await insertRun(ctx.db, exp, version, {
          runType: 'SENSITIVITY',
          provenance,
          datasetId,
          seed,
          config,
          summary: { costBreakEvenMultiplier: cost.breakEvenMultiplier, profitableAt1_5x: cost.profitableAt1_5x, paramStability },
          result: { cost: cost.points, params: results },
          startedAt: new Date(),
        }),
      );
    } else {
      runIds.push(
        await insertRun(ctx.db, exp, version, {
          runType: 'SENSITIVITY',
          provenance,
          datasetId,
          seed,
          config,
          summary: { costBreakEvenMultiplier: cost.breakEvenMultiplier, profitableAt1_5x: cost.profitableAt1_5x, paramStability: null },
          result: { cost: cost.points, params: [] },
          startedAt: new Date(),
        }),
      );
    }
  } catch (e) {
    notes.push(`sensitivity skipped: ${describeError(e).message}`);
  }

  // Deflated Sharpe of the out-of-sample curve for the number of variants tried so far.
  const curve = test?.equityCurve ?? full.equityCurve;
  const rets = periodReturns(curve);
  const sr = periodSharpe(curve);
  const dsr = Number.isFinite(sr) ? deflatedSharpe(sr, rets.length, skewness(rets), kurtosis(rets), opts.trials ?? 1, opts.trialSharpeVariance ?? 0) : null;

  return { kind: 'FINANCE', provenance, dataNotes: notes, realDataError: data.realDataError, full, train, test, walkForward, monteCarlo, cost, paramStability, dsr, runIds };
}

export function verifiedShare(assumptions: Assumption[]): number {
  const relevant = assumptions.filter((a) => a.distribution !== 'fixed' || a.source !== null);
  if (relevant.length === 0) return 0;
  return relevant.filter((a) => a.source !== null).length / relevant.length;
}

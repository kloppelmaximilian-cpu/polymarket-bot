import type { ComplianceEntry, FailureReason, Provenance } from '@aoc/core';

// ───────────────────────────────────────────────────────────── evidence ──

export interface FinanceBacktestEvidence {
  provenance: Provenance;
  trades: number;
  netProfit: number;
  expectancy: number | null;
  grossExpectancy: number | null;
  tStat: number | null;
  sharpe: number | null;
  maxDrawdownPct: number;
  /** In-sample (train) vs out-of-sample (test) split. */
  isSharpe: number | null;
  oosSharpe: number | null;
  oosNetReturnPct: number | null;
  oosTrades: number | null;
  oosPsr: number | null;
  folds: number | null;
  profitableFolds: number | null;
  mcProbLoss: number | null;
  mcDrawdownP95: number | null;
  costBreakEvenMultiplier: number | null;
  profitableAt1_5x: boolean | null;
  dsr: number | null;
  paramStability: number | null;
  capacityUsd: number | null;
}

export interface FinancePaperEvidence {
  days: number;
  trades: number;
  netProfit: number;
  expectancy: number | null;
  tStat: number | null;
  maxDrawdownPct: number;
  rejectedOrderShare: number | null;
  riskBreaches: number;
  dataUptime: number | null;
  returnPerTrade: number | null;
}

export interface BusinessEstimateEvidence {
  probProfitableAtHorizon: number;
  breakEvenMonthP50: number | null;
  cumulativeProfitP50: number;
  ltvToCac: number | null;
  probRuin: number;
  stressedProfitP50: number;
  grossMarginPct: number | null;
  verifiedAssumptionShare: number;
}

export interface BusinessPaperEvidence {
  simulatedDays: number;
  cumulativeProfit: number;
  riskBreaches: number;
}

export interface EvaluationEvidence {
  kind: 'FINANCE' | 'BUSINESS';
  backtest?: FinanceBacktestEvidence | null;
  paper?: FinancePaperEvidence | null;
  estimate?: BusinessEstimateEvidence | null;
  businessPaper?: BusinessPaperEvidence | null;
  compliance: ComplianceEntry[];
  maxDrawdownLimit: number;
  supportsWalkForward: boolean;
  /** A data requirement that can never be met (e.g. the instrument does not exist). */
  permanentNoData?: boolean;
}

// ──────────────────────────────────────────────────────────── thresholds ──

export interface GateThresholds {
  minTradesForVerdict: number;
  minOosTrades: number;
  minProfitableFoldShare: number;
  minOosPsr: number;
  minDsr: number;
  maxMcProbLoss: number;
  maxOverfitDegradation: number;
  minParamStability: number;
  minCapacityUsd: number;
  paperMinDaysPromising: number;
  paperMinTradesPromising: number;
  paperMinDaysLive: number;
  paperMinTradesLive: number;
  paperMinTStatLive: number;
  maxRejectedOrderShare: number;
  minDataUptime: number;
  businessMinProbProfit: number;
  businessMaxBreakEvenMonths: number;
  businessMinLtvCac: number;
  businessMaxProbRuin: number;
  businessPaperMinDays: number;
  businessPaperMinDaysLive: number;
  businessMinVerifiedAssumptions: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  minTradesForVerdict: 30,
  minOosTrades: 30,
  minProfitableFoldShare: 0.6,
  minOosPsr: 0.8,
  minDsr: 0.8,
  maxMcProbLoss: 0.3,
  maxOverfitDegradation: 0.7,
  minParamStability: 0.5,
  minCapacityUsd: 5_000,
  paperMinDaysPromising: 14,
  paperMinTradesPromising: 20,
  paperMinDaysLive: 30,
  paperMinTradesLive: 50,
  paperMinTStatLive: 1.5,
  maxRejectedOrderShare: 0.3,
  minDataUptime: 0.95,
  businessMinProbProfit: 0.6,
  businessMaxBreakEvenMonths: 12,
  businessMinLtvCac: 3,
  businessMaxProbRuin: 0.3,
  businessPaperMinDays: 90,
  businessPaperMinDaysLive: 180,
  businessMinVerifiedAssumptions: 0.5,
};

// ───────────────────────────────────────────────────────────────── checks ──

export interface GateCheck {
  id: string;
  label: string;
  /** null = not applicable or not enough evidence yet. */
  passed: boolean | null;
  value: number | string | null;
  threshold: number | string | null;
  /** If true, a null result also blocks the gate. */
  required: boolean;
}

export interface GateResult {
  gate: 'PRE_PAPER' | 'PROMISING' | 'LIVE_REVIEW';
  passed: boolean;
  checks: GateCheck[];
  blocking: string[];
}

export interface RejectionResult {
  reasons: FailureReason[];
  details: Partial<Record<FailureReason, string>>;
}

const check = (id: string, label: string, passed: boolean | null, value: GateCheck['value'], threshold: GateCheck['threshold'], required = true): GateCheck => ({ id, label, passed, value, threshold, required });

function finish(gate: GateResult['gate'], checks: GateCheck[]): GateResult {
  const blocking = checks.filter((c) => c.passed === false || (c.required && c.passed === null)).map((c) => c.label);
  return { gate, passed: blocking.length === 0, checks, blocking };
}

const hasRealBacktest = (b: FinanceBacktestEvidence | null | undefined): boolean => !!b && (b.provenance === 'HISTORICAL' || b.provenance === 'PAPER');

// ─────────────────────────────────────────────────────────── auto-reject ──

/**
 * Reasons to stop an experiment for good. Verdicts need evidence: a reason is
 * only raised from real (HISTORICAL/PAPER) results with enough trades, or
 * from the business estimate. DEMO results can never fail an experiment.
 */
export function rejectionReasons(e: EvaluationEvidence, t: GateThresholds = DEFAULT_THRESHOLDS): RejectionResult {
  const details: RejectionResult['details'] = {};
  const add = (r: FailureReason, why: string) => {
    if (!details[r]) details[r] = why;
  };

  if (e.compliance.some((c) => c.state === 'BLOCKER')) add('COMPLIANCE_BLOCKER', 'a compliance item is marked BLOCKER');
  if (e.permanentNoData) add('NO_DATA', 'the required data cannot be obtained');

  if (e.kind === 'FINANCE') {
    const b = e.backtest;
    if (b && hasRealBacktest(b) && b.trades >= t.minTradesForVerdict) {
      if (b.grossExpectancy !== null && b.grossExpectancy <= 0) add('NO_EDGE', `gross expectancy ${b.grossExpectancy.toFixed(4)} ≤ 0 before costs over ${b.trades} trades`);
      else if (b.grossExpectancy !== null && b.grossExpectancy > 0 && b.expectancy !== null && b.expectancy < 0) add('HIGH_COST', `positive before costs (${b.grossExpectancy.toFixed(4)}), negative after (${b.expectancy.toFixed(4)})`);
      if (b.expectancy !== null && b.expectancy < 0 && b.tStat !== null && b.tStat < -1) add('NEGATIVE_EV', `expectancy ${b.expectancy.toFixed(4)} with t = ${b.tStat.toFixed(2)}`);
      if (b.maxDrawdownPct > e.maxDrawdownLimit * 1.5) add('HIGH_DRAWDOWN', `max drawdown ${(b.maxDrawdownPct * 100).toFixed(1)}% > 1.5 × limit ${(e.maxDrawdownLimit * 100).toFixed(0)}%`);
      if ((b.mcDrawdownP95 !== null && b.mcDrawdownP95 > 0.5) || (b.mcProbLoss !== null && b.mcProbLoss > 0.7)) {
        add('EXCESSIVE_RISK', `Monte Carlo: P(loss) ${pct(b.mcProbLoss)}, 95th percentile drawdown ${pct(b.mcDrawdownP95)}`);
      }
      if (b.isSharpe !== null && b.oosSharpe !== null && b.isSharpe > 1 && b.oosSharpe < b.isSharpe * (1 - t.maxOverfitDegradation)) {
        add('OVERFITTING', `in-sample Sharpe ${b.isSharpe.toFixed(2)} vs out-of-sample ${b.oosSharpe.toFixed(2)}`);
      }
      if (b.dsr !== null && b.dsr < 0.5 && (b.sharpe ?? 0) > 1) add('OVERFITTING', `deflated Sharpe probability ${b.dsr.toFixed(2)} despite Sharpe ${b.sharpe?.toFixed(2)}`);
      if (b.capacityUsd !== null && b.capacityUsd < t.minCapacityUsd && b.netProfit > 0) add('LOW_SCALABILITY', `estimated capacity ${b.capacityUsd.toFixed(0)} USD < ${t.minCapacityUsd}`);
    }
    const p = e.paper;
    if (p && p.trades >= t.minTradesForVerdict) {
      if (p.expectancy !== null && p.expectancy < 0 && p.tStat !== null && p.tStat < -1) add('NEGATIVE_EV', `paper expectancy ${p.expectancy.toFixed(4)} with t = ${p.tStat.toFixed(2)}`);
      if (p.rejectedOrderShare !== null && p.rejectedOrderShare > t.maxRejectedOrderShare) add('UNRELIABLE_EXECUTION', `${pct(p.rejectedOrderShare)} of paper orders rejected`);
    }
    if (p && p.maxDrawdownPct >= e.maxDrawdownLimit * 1.5) add('HIGH_DRAWDOWN', `paper drawdown ${pct(p.maxDrawdownPct)}`);
  } else {
    const s = e.estimate;
    if (s) {
      if (s.cumulativeProfitP50 < 0 && s.probProfitableAtHorizon < 0.25) add('NEGATIVE_EV', `median outcome ${s.cumulativeProfitP50.toFixed(0)} USD, P(profit) ${pct(s.probProfitableAtHorizon)}`);
      if (s.probRuin > 0.6) add('EXCESSIVE_RISK', `P(running out of the allocated capital) ${pct(s.probRuin)}`);
      if (s.grossMarginPct !== null && s.grossMarginPct < 0) add('HIGH_COST', `negative gross margin ${pct(s.grossMarginPct)}`);
    }
  }
  return { reasons: Object.keys(details) as FailureReason[], details };
}

// ─────────────────────────────────────────────────────────────────── gates ──

/** May the experiment start (or continue) paper testing? */
export function prePaperGate(e: EvaluationEvidence, t: GateThresholds = DEFAULT_THRESHOLDS): GateResult {
  const rej = rejectionReasons(e, t);
  const checks: GateCheck[] = [check('no-rejection', 'No auto-reject reason', rej.reasons.length === 0, rej.reasons.join(', ') || 'none', 'none')];
  if (e.kind === 'FINANCE') {
    const b = e.backtest;
    checks.push(check('backtest-ran', 'A backtest or simulation has run', !!b, b ? b.provenance : null, 'any'));
    if (b && !hasRealBacktest(b)) checks.push(check('demo-only', 'Backtest used real data (DEMO only so far — paper testing collects real evidence)', null, b.provenance, 'HISTORICAL', false));
  } else {
    checks.push(check('estimate-ran', 'A Monte Carlo estimate has run', !!e.estimate, e.estimate ? 'ESTIMATED' : null, 'any'));
  }
  return finish('PRE_PAPER', checks);
}

/** Has the experiment earned PROMISING? Several independent periods are required. */
export function promisingGate(e: EvaluationEvidence, t: GateThresholds = DEFAULT_THRESHOLDS): GateResult {
  const rej = rejectionReasons(e, t);
  const checks: GateCheck[] = [check('no-rejection', 'No auto-reject reason', rej.reasons.length === 0, rej.reasons.join(', ') || 'none', 'none')];
  if (e.kind === 'FINANCE') {
    const b = e.backtest;
    const real = hasRealBacktest(b);
    checks.push(check('real-data', 'Backtest on real historical data', real, b?.provenance ?? null, 'HISTORICAL'));
    checks.push(check('oos-trades', 'Out-of-sample trades', b?.oosTrades != null ? b.oosTrades >= t.minOosTrades : null, b?.oosTrades ?? null, t.minOosTrades));
    checks.push(check('oos-return', 'Out-of-sample net return > 0', b?.oosNetReturnPct != null ? b.oosNetReturnPct > 0 : null, b?.oosNetReturnPct ?? null, '> 0'));
    checks.push(check('oos-psr', 'Probabilistic Sharpe (OOS)', b?.oosPsr != null ? b.oosPsr >= t.minOosPsr : null, b?.oosPsr ?? null, t.minOosPsr, false));
    if (e.supportsWalkForward) {
      const share = b?.folds && b.profitableFolds !== null ? b.profitableFolds / b.folds : null;
      checks.push(check('walk-forward', 'Profitable walk-forward folds', share !== null ? share >= t.minProfitableFoldShare : null, share, t.minProfitableFoldShare));
    }
    checks.push(check('monte-carlo', 'Monte Carlo P(loss)', b?.mcProbLoss != null ? b.mcProbLoss <= t.maxMcProbLoss : null, b?.mcProbLoss ?? null, `≤ ${t.maxMcProbLoss}`));
    checks.push(check('cost-sensitivity', 'Still profitable at 1.5× costs', b?.profitableAt1_5x ?? null, b?.costBreakEvenMultiplier ?? null, '≥ 1.5×'));
    checks.push(check('drawdown', 'Max drawdown within limit', b ? b.maxDrawdownPct <= e.maxDrawdownLimit : null, b?.maxDrawdownPct ?? null, e.maxDrawdownLimit));
    checks.push(check('dsr', 'Deflated Sharpe (multiple testing)', b?.dsr != null ? b.dsr >= t.minDsr : null, b?.dsr ?? null, t.minDsr, false));
    checks.push(check('stability', 'Parameter stability', b?.paramStability != null ? b.paramStability >= t.minParamStability : null, b?.paramStability ?? null, t.minParamStability, false));
    const p = e.paper;
    const minDays = e.supportsWalkForward ? t.paperMinDaysPromising : t.paperMinDaysPromising * 2;
    checks.push(check('paper-days', 'Paper test duration (days)', p ? p.days >= minDays : null, p?.days ?? null, minDays));
    checks.push(check('paper-trades', 'Paper trades', p ? p.trades >= t.paperMinTradesPromising : null, p?.trades ?? null, t.paperMinTradesPromising));
    checks.push(check('paper-net', 'Paper net P&L ≥ 0', p ? p.netProfit >= 0 : null, p?.netProfit ?? null, '≥ 0'));
    checks.push(check('paper-risk', 'No risk-limit breaches in paper', p ? p.riskBreaches === 0 : null, p?.riskBreaches ?? null, 0));
  } else {
    const s = e.estimate;
    checks.push(check('p-profit', 'P(profitable at horizon)', s ? s.probProfitableAtHorizon >= t.businessMinProbProfit : null, s?.probProfitableAtHorizon ?? null, t.businessMinProbProfit));
    checks.push(check('break-even', 'Median break-even month', s ? s.breakEvenMonthP50 !== null && s.breakEvenMonthP50 <= t.businessMaxBreakEvenMonths : null, s?.breakEvenMonthP50 ?? 'never', `≤ ${t.businessMaxBreakEvenMonths}`));
    checks.push(check('stress', 'Median profit under stress (conversion −30%, costs +30%) > 0', s ? s.stressedProfitP50 > 0 : null, s?.stressedProfitP50 ?? null, '> 0'));
    checks.push(check('ltv-cac', 'LTV / CAC', s?.ltvToCac != null ? s.ltvToCac >= t.businessMinLtvCac : null, s?.ltvToCac ?? null, t.businessMinLtvCac, false));
    checks.push(check('ruin', 'P(running out of capital)', s ? s.probRuin <= t.businessMaxProbRuin : null, s?.probRuin ?? null, `≤ ${t.businessMaxProbRuin}`));
    const bp = e.businessPaper;
    checks.push(check('paper-days', 'Simulated operating days', bp ? bp.simulatedDays >= t.businessPaperMinDays : null, bp?.simulatedDays ?? null, t.businessPaperMinDays));
    checks.push(check('paper-risk', 'No risk-limit breaches in simulated operation', bp ? bp.riskBreaches === 0 : null, bp?.riskBreaches ?? null, 0));
  }
  return finish('PROMISING', checks);
}

/**
 * READY_FOR_LIVE_REVIEW: the experiment met the pre-defined criteria and a
 * human can review it. It does not enable anything; the live gate in
 * @aoc/core still refuses.
 */
export function liveReviewGate(e: EvaluationEvidence, t: GateThresholds = DEFAULT_THRESHOLDS): GateResult {
  const promising = promisingGate(e, t);
  const checks: GateCheck[] = [check('promising', 'All PROMISING criteria met', promising.passed, promising.blocking.join('; ') || 'yes', 'yes')];
  const reviewed = e.compliance.length > 0 && e.compliance.every((c) => c.state === 'OK' || c.state === 'NOT_APPLICABLE');
  checks.push(check('compliance', 'Every compliance item reviewed and OK', reviewed, e.compliance.filter((c) => c.state !== 'OK' && c.state !== 'NOT_APPLICABLE').map((c) => c.item).join(', ') || 'all OK', 'all OK'));
  if (e.kind === 'FINANCE') {
    const p = e.paper;
    const b = e.backtest;
    checks.push(check('paper-days', 'Paper test duration (days)', p ? p.days >= t.paperMinDaysLive : null, p?.days ?? null, t.paperMinDaysLive));
    checks.push(check('paper-trades', 'Paper trades', p ? p.trades >= t.paperMinTradesLive : null, p?.trades ?? null, t.paperMinTradesLive));
    checks.push(check('paper-t', 'Paper expectancy t-statistic', p?.tStat != null ? p.tStat >= t.paperMinTStatLive : null, p?.tStat ?? null, t.paperMinTStatLive));
    const ratio = p?.returnPerTrade != null && b?.oosNetReturnPct != null && b.oosTrades ? p.returnPerTrade / (b.oosNetReturnPct / b.oosTrades) : null;
    checks.push(check('consistency', 'Paper return per trade ≥ 50% of backtest', ratio !== null ? ratio >= 0.5 : null, ratio, 0.5));
    checks.push(check('uptime', 'Data uptime', p?.dataUptime != null ? p.dataUptime >= t.minDataUptime : null, p?.dataUptime ?? null, t.minDataUptime));
    checks.push(check('execution', 'Rejected order share', p?.rejectedOrderShare != null ? p.rejectedOrderShare <= 0.1 : null, p?.rejectedOrderShare ?? null, '≤ 0.1'));
  } else {
    const s = e.estimate;
    checks.push(check('verified', 'Share of assumptions backed by a source', s ? s.verifiedAssumptionShare >= t.businessMinVerifiedAssumptions : null, s?.verifiedAssumptionShare ?? null, t.businessMinVerifiedAssumptions));
    checks.push(check('paper-days', 'Simulated operating days', e.businessPaper ? e.businessPaper.simulatedDays >= t.businessPaperMinDaysLive : null, e.businessPaper?.simulatedDays ?? null, t.businessPaperMinDaysLive));
  }
  return finish('LIVE_REVIEW', checks);
}

function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

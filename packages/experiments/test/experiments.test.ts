import { EXPERIMENT_STATUSES, InvalidTransitionError, type ComplianceEntry } from '@aoc/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  PAPER_TRADING_STATUSES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  liveReviewGate,
  nextVersionLabel,
  prePaperGate,
  promisingGate,
  proposeVariants,
  rejectionReasons,
  resumeTarget,
  selectVariant,
  type EvaluationEvidence,
  type FinanceBacktestEvidence,
  type FinancePaperEvidence,
  type VariantResult,
} from '../src';

const okCompliance: ComplianceEntry[] = [
  { item: 'TERMS_OF_SERVICE', state: 'OK', note: '' },
  { item: 'REGULATORY', state: 'OK', note: '' },
];

const goodBacktest = (over: Partial<FinanceBacktestEvidence> = {}): FinanceBacktestEvidence => ({
  provenance: 'HISTORICAL',
  trades: 150,
  netProfit: 900,
  expectancy: 6,
  grossExpectancy: 9,
  tStat: 2.6,
  sharpe: 1.4,
  maxDrawdownPct: 0.09,
  isSharpe: 1.5,
  oosSharpe: 1.2,
  oosNetReturnPct: 0.06,
  oosTrades: 45,
  oosPsr: 0.91,
  folds: 5,
  profitableFolds: 4,
  mcProbLoss: 0.12,
  mcDrawdownP95: 0.18,
  costBreakEvenMultiplier: 2.4,
  profitableAt1_5x: true,
  dsr: 0.92,
  paramStability: 0.75,
  capacityUsd: 500_000,
  ...over,
});

const goodPaper = (over: Partial<FinancePaperEvidence> = {}): FinancePaperEvidence => ({
  days: 40,
  trades: 60,
  netProfit: 220,
  expectancy: 3.6,
  tStat: 1.9,
  maxDrawdownPct: 0.05,
  rejectedOrderShare: 0.02,
  riskBreaches: 0,
  dataUptime: 0.99,
  returnPerTrade: 0.0012,
  ...over,
});

const finance = (over: Partial<EvaluationEvidence> = {}): EvaluationEvidence => ({
  kind: 'FINANCE',
  backtest: goodBacktest(),
  paper: goodPaper(),
  compliance: okCompliance,
  maxDrawdownLimit: 0.2,
  supportsWalkForward: true,
  ...over,
});

describe('lifecycle', () => {
  it('defines transitions for every status', () => {
    for (const s of EXPERIMENT_STATUSES) expect(TRANSITIONS[s]).toBeDefined();
  });
  it('blocks shortcuts', () => {
    expect(canTransition('FAILED', 'READY_FOR_LIVE_REVIEW')).toBe(false);
    expect(canTransition('DISCOVERED', 'PAPER')).toBe(false);
    expect(canTransition('PAPER', 'READY_FOR_LIVE_REVIEW')).toBe(false);
    expect(() => assertTransition('DISCOVERED', 'PROMISING')).toThrow(InvalidTransitionError);
  });
  it('lets only a human revive a failed experiment', () => {
    expect(() => assertTransition('FAILED', 'RESEARCHING', 'PIPELINE')).toThrow(/human/);
    expect(() => assertTransition('FAILED', 'RESEARCHING', 'USER')).not.toThrow();
  });
  it('resumes to the status before the pause', () => {
    expect(resumeTarget('PAPER')).toBe('PAPER');
    expect(resumeTarget(null)).toBe('RESEARCHING');
  });
  it('never allows paper orders outside the paper statuses', () => {
    expect(PAPER_TRADING_STATUSES).not.toContain('FAILED');
    expect(PAPER_TRADING_STATUSES).not.toContain('PAUSED');
    expect(PAPER_TRADING_STATUSES).not.toContain('ARCHIVED');
  });
});

describe('auto-reject', () => {
  it('raises nothing for a sound experiment', () => {
    expect(rejectionReasons(finance()).reasons).toEqual([]);
  });
  it('never fails an experiment on DEMO results', () => {
    const demo = finance({ backtest: goodBacktest({ provenance: 'DEMO', expectancy: -50, grossExpectancy: -50, tStat: -9, maxDrawdownPct: 0.9 }), paper: null });
    expect(rejectionReasons(demo).reasons).toEqual([]);
  });
  it('needs enough trades for a verdict', () => {
    expect(rejectionReasons(finance({ backtest: goodBacktest({ trades: 10, expectancy: -5, grossExpectancy: -5, tStat: -3 }), paper: null })).reasons).toEqual([]);
  });
  it('distinguishes no edge from an edge eaten by costs', () => {
    expect(rejectionReasons(finance({ backtest: goodBacktest({ grossExpectancy: -1, expectancy: -3, tStat: -2 }) })).reasons).toEqual(expect.arrayContaining(['NO_EDGE', 'NEGATIVE_EV']));
    const r = rejectionReasons(finance({ backtest: goodBacktest({ grossExpectancy: 2, expectancy: -1, tStat: -0.5 }) }));
    expect(r.reasons).toContain('HIGH_COST');
    expect(r.reasons).not.toContain('NEGATIVE_EV');
  });
  it('detects drawdown, tail risk, overfitting, scalability and execution problems', () => {
    expect(rejectionReasons(finance({ backtest: goodBacktest({ maxDrawdownPct: 0.35 }) })).reasons).toContain('HIGH_DRAWDOWN');
    expect(rejectionReasons(finance({ backtest: goodBacktest({ mcProbLoss: 0.8 }) })).reasons).toContain('EXCESSIVE_RISK');
    expect(rejectionReasons(finance({ backtest: goodBacktest({ isSharpe: 2.5, oosSharpe: 0.3 }) })).reasons).toContain('OVERFITTING');
    expect(rejectionReasons(finance({ backtest: goodBacktest({ capacityUsd: 1000 }) })).reasons).toContain('LOW_SCALABILITY');
    expect(rejectionReasons(finance({ paper: goodPaper({ rejectedOrderShare: 0.5 }) })).reasons).toContain('UNRELIABLE_EXECUTION');
  });
  it('treats a compliance blocker as final', () => {
    expect(rejectionReasons(finance({ compliance: [{ item: 'SPAM_RULES', state: 'BLOCKER', note: 'no lawful basis' }] })).reasons).toContain('COMPLIANCE_BLOCKER');
  });
  it('rejects business models with a negative median and low odds', () => {
    const r = rejectionReasons({ kind: 'BUSINESS', compliance: okCompliance, maxDrawdownLimit: 0.5, supportsWalkForward: false, estimate: { probProfitableAtHorizon: 0.1, breakEvenMonthP50: null, cumulativeProfitP50: -5000, ltvToCac: 0.5, probRuin: 0.8, stressedProfitP50: -9000, grossMarginPct: -0.1, verifiedAssumptionShare: 0 } });
    expect(r.reasons).toEqual(expect.arrayContaining(['NEGATIVE_EV', 'EXCESSIVE_RISK', 'HIGH_COST']));
  });
});

describe('quality gates', () => {
  it('lets DEMO-only experiments into paper testing, flagged', () => {
    const g = prePaperGate(finance({ backtest: goodBacktest({ provenance: 'DEMO' }), paper: null }));
    expect(g.passed).toBe(true);
    expect(g.checks.find((c) => c.id === 'demo-only')).toBeDefined();
  });

  it('promotes a well-evidenced experiment to PROMISING', () => {
    const g = promisingGate(finance());
    expect(g.blocking).toEqual([]);
    expect(g.passed).toBe(true);
  });

  it('does not promote a short lucky streak', () => {
    const lucky = finance({ backtest: goodBacktest({ oosTrades: 8, folds: 5, profitableFolds: 2 }), paper: goodPaper({ days: 3, trades: 6, netProfit: 900 }) });
    const g = promisingGate(lucky);
    expect(g.passed).toBe(false);
    expect(g.blocking).toEqual(expect.arrayContaining(['Out-of-sample trades', 'Profitable walk-forward folds', 'Paper test duration (days)', 'Paper trades']));
  });

  it('requires real historical data for PROMISING', () => {
    expect(promisingGate(finance({ backtest: goodBacktest({ provenance: 'DEMO' }) })).blocking).toContain('Backtest on real historical data');
  });

  it('requires a paper phase: missing paper evidence blocks (null is not a pass)', () => {
    expect(promisingGate(finance({ paper: null })).passed).toBe(false);
  });

  it('doubles the paper period when walk-forward is not possible', () => {
    const g = promisingGate(finance({ supportsWalkForward: false, paper: goodPaper({ days: 20 }) }));
    expect(g.blocking).toContain('Paper test duration (days)');
  });

  it('requires reviewed compliance and a longer, consistent paper record for live review', () => {
    expect(liveReviewGate(finance()).passed).toBe(true);
    expect(liveReviewGate(finance({ compliance: [{ item: 'REGULATORY', state: 'UNREVIEWED', note: '' }] })).blocking).toContain('Every compliance item reviewed and OK');
    expect(liveReviewGate(finance({ paper: goodPaper({ returnPerTrade: 0.0001 }) })).blocking).toContain('Paper return per trade ≥ 50% of backtest');
    expect(liveReviewGate(finance({ paper: goodPaper({ days: 20 }) })).passed).toBe(false);
  });

  it('requires verified assumptions before a business model can reach live review', () => {
    const e: EvaluationEvidence = {
      kind: 'BUSINESS',
      compliance: okCompliance,
      maxDrawdownLimit: 0.5,
      supportsWalkForward: false,
      estimate: { probProfitableAtHorizon: 0.75, breakEvenMonthP50: 7, cumulativeProfitP50: 20000, ltvToCac: 4, probRuin: 0.1, stressedProfitP50: 4000, grossMarginPct: 0.7, verifiedAssumptionShare: 0 },
      businessPaper: { simulatedDays: 200, cumulativeProfit: 3000, riskBreaches: 0 },
    };
    expect(promisingGate(e).passed).toBe(true);
    expect(liveReviewGate(e).blocking).toContain('Share of assumptions backed by a source');
    expect(liveReviewGate({ ...e, estimate: { ...e.estimate!, verifiedAssumptionShare: 0.6 } }).passed).toBe(true);
  });

  it('exposes default thresholds', () => {
    expect(DEFAULT_THRESHOLDS.minOosTrades).toBeGreaterThanOrEqual(30);
  });
});

describe('strategy lab', () => {
  const space = { lookbackBars: { type: 'int' as const, min: 24, max: 96, step: 24 }, entryThreshold: { type: 'float' as const, min: 0.01, max: 0.03, step: 0.01 } };

  it('proposes distinct variants excluding the current version', () => {
    const base = { lookbackBars: 48, entryThreshold: 0.02, other: 1 };
    const vs = proposeVariants(base, space, 20);
    expect(vs).toHaveLength(11); // 12-point grid minus the baseline
    expect(vs.every((v) => v.other === 1)).toBe(true);
    expect(new Set(vs.map((v) => JSON.stringify(v))).size).toBe(vs.length);
  });

  const v = (trainSharpe: number, testNetReturn: number, testTrades = 40): VariantResult => ({ params: { s: trainSharpe }, trainSharpe, trainNetReturn: trainSharpe, testNetReturn, testTrades, testSharpe: null, trainPeriods: 3000, trainSkew: 0, trainKurtosis: 3 });

  it('refuses improvements that are plausibly selection luck', () => {
    const rec = selectVariant(v(0.01, 0.01), [v(0.012, 0.02), v(0.011, 0.015), v(0.013, 0.03)]);
    expect(rec.recommend).toBe(false);
    expect(rec.reasons.join()).toMatch(/deflated Sharpe/);
  });

  it('recommends a variant that is clearly better in training and better out of sample', () => {
    const rec = selectVariant(v(0.0, 0.01), [v(0.15, 0.08), v(0.01, 0.0), v(-0.02, -0.01)]);
    expect(rec.recommend).toBe(true);
    expect(rec.best!.testNetReturn).toBe(0.08);
  });

  it('does not recommend when the out-of-sample result is worse', () => {
    const rec = selectVariant(v(0.0, 0.05), [v(0.15, 0.01)]);
    expect(rec.recommend).toBe(false);
  });

  it('labels versions monotonically', () => {
    expect(nextVersionLabel([])).toBe('v1');
    expect(nextVersionLabel(['v1'])).toBe('v1.1');
    expect(nextVersionLabel(['v1', 'v1.1', 'v1.2'])).toBe('v1.3');
    expect(nextVersionLabel(['v1', 'v1.4', 'v2'])).toBe('v2.1');
    expect(nextVersionLabel(['v1', 'v1.1'], 'major')).toBe('v2');
  });
});

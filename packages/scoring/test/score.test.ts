import { describe, expect, it } from 'vitest';
import { computeScore, rank, scoreIdea, interp, type FinanceEvidence, type ScoringInput } from '../src';

const q = { automation: 80, scalability: 60, operationalSimplicity: 70, recurringRevenue: 20, competition: 30, dependencySafety: 50, dataAvailability: 90, executionSafety: 70, timeToRevenueDays: 30 };

const fin = (over: Partial<FinanceEvidence> = {}): FinanceEvidence => ({
  provenance: 'HISTORICAL',
  trades: 120,
  annualizedReturnPct: 0.25,
  totalReturnPct: 0.25,
  sharpe: 1.4,
  maxDrawdownPct: 0.1,
  expectancy: 4,
  psr: 0.9,
  mcProbLoss: 0.1,
  profitableFoldsShare: 0.8,
  capacityUsd: 200_000,
  executionReliability: 0.98,
  dataUptime: 0.99,
  ...over,
});

const input = (over: Partial<ScoringInput> = {}): ScoringInput => ({ kind: 'TRADING', status: 'EVALUATING', riskLevel: 'MEDIUM', capitalRequirement: 1000, qualitative: q, finance: fin(), ...over });

describe('opportunity score', () => {
  it('stays within 0..100 and explains itself', () => {
    const s = computeScore(input());
    expect(s.overall).toBeGreaterThan(0);
    expect(s.overall).toBeLessThanOrEqual(100);
    expect(s.confidence).toBe('MEDIUM');
    expect(s.explanation.length).toBeGreaterThan(0);
  });

  it('does not let higher profit with extreme risk outrank a safer opportunity', () => {
    const safe = computeScore(input({ finance: fin({ annualizedReturnPct: 0.25, sharpe: 1.5, maxDrawdownPct: 0.08, mcProbLoss: 0.08 }) }));
    const wild = computeScore(input({ riskLevel: 'EXTREME', finance: fin({ annualizedReturnPct: 0.9, sharpe: 1.1, maxDrawdownPct: 0.55, mcProbLoss: 0.4 }) }));
    expect(wild.components.profit!).toBeGreaterThan(safe.components.profit!);
    expect(safe.overall).toBeGreaterThan(wild.overall);
    expect(wild.caps.join()).toMatch(/Extreme risk/);
  });

  it('never scores profit from DEMO evidence (NO DATA instead)', () => {
    const s = computeScore(input({ finance: fin({ provenance: 'DEMO', annualizedReturnPct: 3, sharpe: 5 }) }));
    expect(s.components.profit).toBeNull();
    expect(s.overall).toBeLessThanOrEqual(60);
    expect(s.confidence).toBe('LOW');
    expect(s.explanation.join()).toMatch(/DEMO/);
  });

  it('keeps untested experiments below tested ones (HYPOTHETICAL ≤ 50)', () => {
    const excellent = { ...q, automation: 100, scalability: 100, operationalSimplicity: 100, recurringRevenue: 100, competition: 100, dependencySafety: 100, dataAvailability: 100, executionSafety: 100, timeToRevenueDays: 0 };
    const untested = computeScore(input({ riskLevel: 'LOW', qualitative: excellent, finance: undefined }));
    expect(untested.evidence).toBe('HYPOTHETICAL');
    expect(untested.overall).toBeLessThanOrEqual(50);
    expect(untested.caps.join()).toMatch(/Untested/);
  });

  it('treats too few trades as NO DATA', () => {
    expect(computeScore(input({ finance: fin({ trades: 3 }) })).components.profit).toBeNull();
  });

  it('caps negative expectancy and failed experiments', () => {
    expect(computeScore(input({ finance: fin({ expectancy: -1, annualizedReturnPct: -0.1, sharpe: -0.3 }) })).overall).toBeLessThanOrEqual(25);
    expect(computeScore(input({ status: 'FAILED' })).overall).toBeLessThanOrEqual(15);
  });

  it('is monotonic in drawdown and in return', () => {
    const dd = [0.05, 0.15, 0.3, 0.5].map((x) => computeScore(input({ finance: fin({ maxDrawdownPct: x }) })).overall);
    for (let i = 1; i < dd.length; i++) expect(dd[i]!).toBeLessThanOrEqual(dd[i - 1]!);
    const ret = [-0.2, 0, 0.2, 0.6].map((x) => computeScore(input({ finance: fin({ annualizedReturnPct: x, expectancy: x }) })).overall);
    for (let i = 1; i < ret.length; i++) expect(ret[i]!).toBeGreaterThanOrEqual(ret[i - 1]!);
  });

  it('gives PAPER evidence with enough trades HIGH confidence', () => {
    expect(computeScore(input({ finance: fin({ provenance: 'PAPER', trades: 40 }) })).confidence).toBe('HIGH');
  });

  it('scores business estimates with at most MEDIUM confidence', () => {
    const s = computeScore({
      kind: 'BUSINESS',
      status: 'EVALUATING',
      riskLevel: 'MEDIUM',
      capitalRequirement: 2000,
      qualitative: q,
      business: { provenance: 'ESTIMATED', probProfitableAtHorizon: 0.7, breakEvenMonthP50: 8, cumulativeProfitP10: -3000, cumulativeProfitP50: 9000, cumulativeProfitP90: 30000, maxCashNeedP50: 2500, ltvToCac: 3.5, probRuin: 0.2, stressedProfitP50: 1000, horizonMonths: 24, verifiedAssumptionShare: 0.6 },
    });
    expect(s.components.profit).not.toBeNull();
    expect(s.confidence).toBe('MEDIUM');
    expect(s.evidence).toBe('ESTIMATED');
  });

  it('keeps estimates on unverified assumptions at LOW confidence and capped', () => {
    const s = computeScore({
      kind: 'BUSINESS',
      status: 'EVALUATING',
      riskLevel: 'LOW',
      capitalRequirement: 500,
      qualitative: { ...q, automation: 100, scalability: 100 },
      business: { provenance: 'ESTIMATED', probProfitableAtHorizon: 0.95, breakEvenMonthP50: 3, cumulativeProfitP10: 5000, cumulativeProfitP50: 50000, cumulativeProfitP90: 90000, maxCashNeedP50: 500, ltvToCac: 9, probRuin: 0, stressedProfitP50: 20000, horizonMonths: 24, verifiedAssumptionShare: 0 },
    });
    expect(s.confidence).toBe('LOW');
    expect(s.overall).toBeLessThanOrEqual(60);
    expect(s.caps.join()).toMatch(/unverified/);
  });

  it('ranks by score, then confidence', () => {
    const items = [
      { id: 'a', score: computeScore(input({ finance: fin({ provenance: 'DEMO' }) })) },
      { id: 'b', score: computeScore(input()) },
    ];
    const r = rank(items);
    expect(r[0]!.id).toBe('b');
    expect(r.map((x) => x.rank)).toEqual([1, 2]);
  });

  it('interpolates and clamps', () => {
    expect(interp(5, [[0, 0], [10, 100]])).toBe(50);
    expect(interp(-5, [[0, 0], [10, 100]])).toBe(0);
    expect(interp(50, [[0, 0], [10, 100]])).toBe(100);
  });

  it('keeps idea pre-screens low-confidence and capped', () => {
    const s = scoreIdea({ automation: 100, complexity: 0, scalability: 100, testability: 100, estimatedCapital: 100, regulatoryRiskCount: 0 });
    expect(s.score).toBeLessThanOrEqual(50);
    expect(s.confidence).toBe('LOW');
    expect(scoreIdea({ automation: 80, complexity: 40, scalability: 80, testability: 80, estimatedCapital: 500, regulatoryRiskCount: 3 }).score).toBeLessThan(
      scoreIdea({ automation: 80, complexity: 40, scalability: 80, testability: 80, estimatedCapital: 500, regulatoryRiskCount: 0 }).score,
    );
  });
});

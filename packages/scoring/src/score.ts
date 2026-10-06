import { EVIDENCE_RANK, clamp, type ExperimentStatus, type FailureReason, type Provenance, type RiskLevel, type StrategyKind } from '@aoc/core';
import type { QualitativeProfile } from '@aoc/strategies';

/**
 * Opportunity Score (0–100).
 *
 *  1. Seven component scores, each 0–100 or null (= NO DATA):
 *       profit, risk (higher = safer), automation, scalability,
 *       capital efficiency, reliability, time to revenue
 *     plus a context score from recurring revenue, competition, dependency
 *     risk, data availability, execution risk and operational complexity.
 *  2. Weighted mean of the components that have data.
 *  3. Non-compensatory risk adjustment: × (0.5 + 0.5 · risk/100), so high
 *     profit cannot buy back high risk.
 *  4. Hard caps: no profit evidence ≤ 60, untested ≤ 50, extreme risk ≤ 40, negative
 *     expectancy ≤ 25, FAILED ≤ 15.
 *
 * Profit is only scored from evidence that can carry it: HISTORICAL or PAPER
 * results for finance, ESTIMATED (assumption Monte Carlo) for business. DEMO
 * results never contribute to profit.
 */

export const COMPONENT_KEYS = ['profit', 'risk', 'automation', 'scalability', 'capitalEfficiency', 'reliability', 'timeToRevenue', 'context'] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export const DEFAULT_WEIGHTS: Record<ComponentKey, number> = {
  profit: 0.25,
  risk: 0.2,
  automation: 0.1,
  scalability: 0.1,
  capitalEfficiency: 0.1,
  reliability: 0.15,
  timeToRevenue: 0.1,
  context: 0.1,
};

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  profit: 'Profit',
  risk: 'Risk (higher = safer)',
  automation: 'Automation',
  scalability: 'Scalability',
  capitalEfficiency: 'Capital efficiency',
  reliability: 'Reliability',
  timeToRevenue: 'Time to revenue',
  context: 'Context (competition, dependencies, data, execution, recurring revenue, complexity)',
};

export interface FinanceEvidence {
  provenance: Provenance;
  trades: number;
  annualizedReturnPct: number | null;
  totalReturnPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number | null;
  expectancy: number | null;
  psr: number | null;
  mcProbLoss: number | null;
  profitableFoldsShare: number | null;
  capacityUsd: number | null;
  /** Share of orders that were not rejected / legs that filled, 0..1. */
  executionReliability: number | null;
  /** Share of time the data feeds were CONNECTED, 0..1. */
  dataUptime: number | null;
}

export interface BusinessEvidence {
  provenance: Provenance;
  probProfitableAtHorizon: number;
  breakEvenMonthP50: number | null;
  cumulativeProfitP10: number;
  cumulativeProfitP50: number;
  cumulativeProfitP90: number;
  maxCashNeedP50: number;
  ltvToCac: number | null;
  probRuin: number;
  stressedProfitP50: number;
  horizonMonths: number;
  /** Share of the assumptions that cite a source (0..1). */
  verifiedAssumptionShare: number;
}

export interface ScoringInput {
  kind: StrategyKind;
  status: ExperimentStatus;
  riskLevel: RiskLevel;
  capitalRequirement: number;
  qualitative: QualitativeProfile;
  finance?: FinanceEvidence | null;
  business?: BusinessEvidence | null;
  failureReasons?: FailureReason[];
  weights?: Partial<Record<ComponentKey, number>>;
}

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ScoreResult {
  overall: number;
  components: Record<ComponentKey, number | null>;
  confidence: Confidence;
  evidence: Provenance;
  riskMultiplier: number;
  caps: string[];
  explanation: string[];
}

const RISK_LEVEL_SCORE: Record<RiskLevel, number> = { LOW: 85, MEDIUM: 65, HIGH: 40, EXTREME: 15 };

/** Piecewise-linear interpolation through (x, y) knots, clamped at the ends. */
export function interp(x: number, knots: Array<[number, number]>): number {
  if (!Number.isFinite(x)) return NaN;
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i]!;
    const [x0, y0] = knots[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

const avg = (xs: Array<number | null | undefined>): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

const round1 = (x: number) => Math.round(x * 10) / 10;

export function returnScore(annualized: number): number {
  return interp(annualized, [
    [-0.5, 0],
    [0, 30],
    [0.1, 50],
    [0.2, 65],
    [0.5, 85],
    [1, 95],
  ]);
}

export function sharpeScore(sharpe: number): number {
  return interp(sharpe, [
    [-1, 0],
    [0, 30],
    [1, 60],
    [2, 80],
    [3, 95],
  ]);
}

export function drawdownSafety(dd: number): number {
  return interp(dd, [
    [0, 100],
    [0.1, 75],
    [0.2, 50],
    [0.4, 15],
    [0.6, 0],
  ]);
}

export function capitalScore(capital: number): number {
  return clamp(100 - 15 * Math.log10(Math.max(100, capital) / 100), 20, 100);
}

export function timeToRevenueScore(days: number): number {
  return interp(days, [
    [7, 95],
    [30, 80],
    [90, 55],
    [180, 35],
    [365, 15],
    [730, 5],
  ]);
}

export function capacityScore(usd: number): number {
  return interp(Math.log10(Math.max(1, usd)), [
    [3, 20],
    [4, 40],
    [5, 60],
    [6, 80],
    [7, 95],
  ]);
}

/** Which evidence counts as profit evidence for this kind of experiment. */
export function profitEvidenceOk(kind: StrategyKind, p: Provenance): boolean {
  if (kind === 'BUSINESS') return p === 'ESTIMATED' || p === 'SIMULATED' || p === 'PAPER';
  return p === 'HISTORICAL' || p === 'PAPER';
}

export function computeScore(input: ScoringInput): ScoreResult {
  const q = input.qualitative;
  const explanation: string[] = [];
  const caps: string[] = [];
  const c: Record<ComponentKey, number | null> = {
    profit: null,
    risk: null,
    automation: clamp(q.automation, 0, 100),
    scalability: clamp(q.scalability, 0, 100),
    capitalEfficiency: null,
    reliability: null,
    timeToRevenue: timeToRevenueScore(q.timeToRevenueDays),
    context: avg([q.recurringRevenue, q.competition, q.dependencySafety, q.dataAvailability, q.executionSafety, q.operationalSimplicity]),
  };
  let evidence: Provenance = 'HYPOTHETICAL';
  let expectancyNegative = false;
  const capScore = capitalScore(input.capitalRequirement);
  const levelSafety = RISK_LEVEL_SCORE[input.riskLevel];

  const f = input.finance;
  if (f && input.kind !== 'BUSINESS') {
    evidence = f.provenance;
    const usable = profitEvidenceOk(input.kind, f.provenance) && f.trades >= 5;
    if (usable) {
      const ret = f.annualizedReturnPct ?? f.totalReturnPct;
      c.profit = avg([ret !== null ? returnScore(ret) : null, f.sharpe !== null ? sharpeScore(f.sharpe) : null]);
      if (c.profit !== null) explanation.push(`Profit from ${f.provenance} results over ${f.trades} trades.`);
      expectancyNegative = f.expectancy !== null && f.expectancy < 0;
      c.capitalEfficiency = avg([capScore, ret !== null ? returnScore(ret) : null]);
      c.reliability = avg([
        f.executionReliability !== null ? f.executionReliability * 100 : null,
        f.dataUptime !== null ? f.dataUptime * 100 : null,
        f.profitableFoldsShare !== null ? f.profitableFoldsShare * 100 : null,
        f.psr !== null ? f.psr * 100 : null,
      ]);
    } else {
      explanation.push(
        f.provenance === 'DEMO'
          ? 'Only DEMO results exist: they test the machinery, not the strategy, so profit is NO DATA.'
          : `Too few trades (${f.trades}) for a profit score: NO DATA.`,
      );
      c.capitalEfficiency = capScore;
    }
    const safety = avg([
      usable && f.maxDrawdownPct !== null ? drawdownSafety(f.maxDrawdownPct) : null,
      usable && f.mcProbLoss !== null ? interp(f.mcProbLoss, [[0, 100], [0.5, 30], [1, 0]]) : null,
      levelSafety,
    ]);
    c.risk = safety;
    if (f.capacityUsd !== null && f.capacityUsd !== undefined) c.scalability = avg([q.scalability, capacityScore(f.capacityUsd)]);
  }

  const b = input.business;
  if (b && input.kind === 'BUSINESS') {
    evidence = b.provenance;
    const base = Math.max(input.capitalRequirement, b.maxCashNeedP50, 1000);
    const roi = b.cumulativeProfitP50 / base;
    const roiScore = interp(roi, [
      [-1, 0],
      [0, 30],
      [1, 60],
      [3, 80],
      [10, 95],
    ]);
    c.profit = avg([roiScore, b.probProfitableAtHorizon * 100]);
    expectancyNegative = b.cumulativeProfitP50 < 0;
    explanation.push(`Profit estimated from assumption Monte Carlo (${b.horizonMonths} months): P50 ${Math.round(b.cumulativeProfitP50)} USD, P(profit) ${(b.probProfitableAtHorizon * 100).toFixed(0)}%.`);
    c.risk = avg([(1 - b.probRuin) * 100, b.probProfitableAtHorizon * 100, interp(b.stressedProfitP50 / base, [[-1, 0], [0, 40], [1, 80], [3, 100]]), levelSafety]);
    c.capitalEfficiency = avg([capitalScore(Math.max(input.capitalRequirement, b.maxCashNeedP50)), roiScore]);
    const spread = Math.abs(b.cumulativeProfitP90 - b.cumulativeProfitP10) / Math.max(base, Math.abs(b.cumulativeProfitP50), 1);
    c.reliability = avg([interp(spread, [[0, 90], [2, 60], [5, 35], [10, 15]]), q.dataAvailability]);
    if (b.breakEvenMonthP50 !== null) c.timeToRevenue = avg([timeToRevenueScore(q.timeToRevenueDays), timeToRevenueScore(b.breakEvenMonthP50 * 30)]);
  }

  if (c.risk === null) {
    c.risk = levelSafety;
    explanation.push(`Risk from the declared risk level (${input.riskLevel}) only.`);
  }
  if (c.capitalEfficiency === null) c.capitalEfficiency = capScore;

  // Weighted mean of components with data.
  const w = { ...DEFAULT_WEIGHTS, ...input.weights };
  let num = 0;
  let den = 0;
  for (const k of COMPONENT_KEYS) {
    const v = c[k];
    if (v === null || !Number.isFinite(v)) continue;
    num += v * (w[k] ?? 0);
    den += w[k] ?? 0;
  }
  const base = den > 0 ? num / den : 0;
  const riskMultiplier = 0.5 + 0.5 * ((c.risk ?? 0) / 100);
  let overall = base * riskMultiplier;

  const cap = (limit: number, why: string) => {
    if (overall > limit) {
      overall = limit;
      caps.push(`${why} (capped at ${limit})`);
    }
  };
  if (c.profit === null) cap(60, 'No profit evidence');
  // Nothing has been run yet: an untested idea must not outrank a tested one (same cap as the idea pre-screen).
  if (evidence === 'HYPOTHETICAL') cap(50, 'Untested: no backtest or simulation yet');
  const unverified = !!b && input.kind === 'BUSINESS' && b.verifiedAssumptionShare < 0.5;
  if (unverified) cap(60, 'Estimate rests mostly on unverified assumptions');
  if (input.riskLevel === 'EXTREME') cap(40, 'Extreme risk level');
  if (expectancyNegative) cap(25, 'Negative expectancy in the evidence');
  if ((input.failureReasons ?? []).includes('NEGATIVE_EV')) cap(25, 'Failed: negative expected value');
  if (input.status === 'FAILED') cap(15, 'Experiment FAILED');

  let confidence: Confidence = 'LOW';
  if (c.profit !== null) {
    const rank = EVIDENCE_RANK[evidence];
    if (input.kind === 'BUSINESS') confidence = unverified ? 'LOW' : 'MEDIUM';
    else if (rank >= EVIDENCE_RANK.PAPER && (f?.trades ?? 0) >= 30) confidence = 'HIGH';
    else if (rank >= EVIDENCE_RANK.HISTORICAL && (f?.trades ?? 0) >= 30) confidence = 'MEDIUM';
  }

  const components = Object.fromEntries(COMPONENT_KEYS.map((k) => [k, c[k] === null ? null : round1(c[k] as number)])) as Record<ComponentKey, number | null>;
  return { overall: round1(clamp(overall, 0, 100)), components, confidence, evidence, riskMultiplier: Math.round(riskMultiplier * 1000) / 1000, caps, explanation };
}

const CONF_RANK: Record<Confidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Rank by score; ties broken by confidence, then by evidence strength. */
export function rank<T extends { score: ScoreResult }>(items: T[]): Array<T & { rank: number }> {
  return items
    .slice()
    .sort((a, b) => b.score.overall - a.score.overall || CONF_RANK[b.score.confidence] - CONF_RANK[a.score.confidence] || EVIDENCE_RANK[b.score.evidence] - EVIDENCE_RANK[a.score.evidence])
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

export interface IdeaScoringInput {
  automation: number | null;
  complexity: number | null;
  scalability: number | null;
  testability: number | null;
  estimatedCapital: number | null;
  regulatoryRiskCount: number;
}

/**
 * Hypothetical pre-screen for an idea that has no experiment yet. Clearly
 * not an opportunity score: confidence is always LOW and the result is
 * capped at 50 until the idea is tested.
 */
export function scoreIdea(i: IdeaScoringInput): { score: number; confidence: 'LOW'; notes: string[] } {
  const parts = [i.automation, i.complexity !== null ? 100 - i.complexity : null, i.scalability, i.testability, i.estimatedCapital !== null ? capitalScore(i.estimatedCapital) : null];
  const base = avg(parts) ?? 0;
  const penalty = Math.min(30, i.regulatoryRiskCount * 8);
  return { score: round1(Math.min(50, Math.max(0, base - penalty) * 0.6)), confidence: 'LOW', notes: ['Hypothetical pre-screen from the idea description; untested.'] };
}

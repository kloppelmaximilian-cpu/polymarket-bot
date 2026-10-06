import type {
  Assumption,
  Bar,
  Category,
  FundingRatePoint,
  OrderBook,
  OutcomeBook,
  Provenance,
  Quote,
  RiskLevel,
  StrategyKind,
} from '@aoc/core';
import type { EngineChanges, PaperAccount } from '@aoc/paper-engine';
import type { z } from 'zod';

// ─────────────────────────────────────────────────────────────── metadata ──

export type ParamRange =
  | { type: 'int'; min: number; max: number; step: number }
  | { type: 'float'; min: number; max: number; step: number }
  | { type: 'choice'; values: Array<string | number | boolean> };

/** The pre-registered search space for the Strategy Lab (kept small on purpose). */
export type ParamSpace = Record<string, ParamRange>;

export interface StrategyMeta<P = Record<string, unknown>> {
  id: string;
  name: string;
  kind: StrategyKind;
  category: Category;
  /** Semver of the module code. Results are tied to it. */
  version: string;
  description: string;
  /** Why this could work, phrased as a falsifiable hypothesis. */
  hypothesis: string;
  /** Where the edge would come from, and why it may not exist. */
  edgeRationale: string;
  knownRisks: string[];
  defaultParams: P;
  paramsSchema: z.ZodType<P>;
  paramSpace: ParamSpace;
  defaultRiskLevel: RiskLevel;
  capabilities: {
    backtest: boolean;
    walkForward: boolean;
    paper: boolean;
    monteCarlo: boolean;
    /** True if a meaningful test needs real historical data (finance). */
    requiresRealData: boolean;
  };
  /** Qualitative inputs to the opportunity score (0–100, higher is better). */
  qualitative: QualitativeProfile;
}

export interface QualitativeProfile {
  automation: number;
  scalability: number;
  /** Higher = simpler to operate. */
  operationalSimplicity: number;
  recurringRevenue: number;
  /** Higher = less competition. */
  competition: number;
  /** Higher = fewer/safer third-party dependencies. */
  dependencySafety: number;
  dataAvailability: number;
  /** Higher = lower execution risk. */
  executionSafety: number;
  /** Expected days until first revenue (business) or first trade (finance). */
  timeToRevenueDays: number;
}

// ─────────────────────────────────────────────────────────────────── data ──

export type DataRequirement =
  | { kind: 'BARS'; venue: string; symbol: string; interval: string; minBars: number }
  | { kind: 'FUNDING'; venue: string; symbol: string; minPoints: number }
  | { kind: 'QUOTES'; venues: string[]; symbol: string }
  | { kind: 'PM_MARKETS'; query: string; maxMarkets: number }
  | { kind: 'NONE' };

/** Cross-venue quote snapshot at one instant. */
export interface QuoteSnapshot {
  ts: number;
  quotes: Quote[];
}

/** Prediction-market state at one instant: books for a set of outcome tokens. */
export interface PredictionMarketSnapshot {
  ts: number;
  markets: Array<{
    marketId: string;
    question: string;
    negRisk: boolean;
    outcomes: OutcomeBook[];
    /** Resolution, when known at this instant (for settlement in simulations). */
    resolvedOutcome?: string | null;
  }>;
  /**
   * Optional external probability estimates per outcome token (value trading).
   * Never derived from the future of this series.
   */
  fair?: Record<string, number>;
}

/** Everything a module may need for a backtest or a paper step. */
export interface DataBundle {
  provenance: Extract<Provenance, 'HISTORICAL' | 'DEMO' | 'PAPER'>;
  label: string;
  bars?: Record<string, Bar[]>;
  funding?: Record<string, FundingRatePoint[]>;
  quoteSeries?: QuoteSnapshot[];
  pmSeries?: PredictionMarketSnapshot[];
  books?: Record<string, OrderBook>;
}

// ──────────────────────────────────────────────────────────────── results ──

export interface TradeRecord {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  /** Funding or carry received (+) / paid (−) while open. */
  carry: number;
  netPnl: number;
  /** Net P&L relative to the capital committed to the trade. */
  returnPct: number;
  reason: string;
}

export interface EquityPoint {
  ts: number;
  equity: number;
}

export interface PerformanceMetrics {
  trades: number;
  winRate: number | null;
  totalReturnPct: number | null;
  annualizedReturnPct: number | null;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number | null;
  avgTradeReturnPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number;
  maxDrawdownDurationMs: number;
  exposurePct: number | null;
  fees: number;
  slippage: number;
  carry: number;
  /** t-statistic of mean trade P&L. */
  tStat: number | null;
  /** Probabilistic Sharpe ratio vs 0 (Bailey & López de Prado). */
  psr: number | null;
  periods: number;
  periodMs: number;
}

export interface BacktestResult {
  provenance: Provenance;
  datasetLabel: string;
  startTs: number;
  endTs: number;
  initialCapital: number;
  equityCurve: EquityPoint[];
  trades: TradeRecord[];
  metrics: PerformanceMetrics;
  /** Estimated capacity in USD notional before the edge would be competed away / moved. */
  capacityUsd: number | null;
  notes: string[];
  /** Gross (pre-cost) expectancy per trade, to separate "no edge" from "too expensive". */
  grossExpectancy: number | null;
}

export interface BacktestInput<P> {
  params: P;
  data: DataBundle;
  initialCapital: number;
  /** Multiplier on all transaction costs (sensitivity analysis). */
  costMultiplier?: number;
  seed: string;
  /** Restrict the run to [startTs, endTs) while using earlier data for warm-up. */
  window?: { startTs: number; endTs: number };
}

// ─────────────────────────────────────────────────────── business results ──

export interface Percentiles {
  p10: number;
  p50: number;
  p90: number;
  mean: number;
}

export interface BusinessMonth {
  month: number;
  revenue: Percentiles;
  costs: Percentiles;
  profit: Percentiles;
  cumulativeCash: Percentiles;
  customers: Percentiles;
  mrr: Percentiles;
}

export interface BusinessSummary {
  horizonMonths: number;
  runs: number;
  probProfitableAtHorizon: number;
  probBreakEvenWithin12m: number;
  breakEvenMonthP50: number | null;
  cumulativeProfit: Percentiles;
  profitMonth12: Percentiles;
  maxCashNeed: Percentiles;
  revenueMonth12: Percentiles;
  ltv: number | null;
  cac: number | null;
  ltvToCac: number | null;
  paybackMonths: number | null;
  grossMarginPct: number | null;
  annualRunRateMonth12: Percentiles;
  probRuin: number;
}

export interface SensitivityRow {
  key: string;
  label: string;
  lowValue: number;
  highValue: number;
  profitAtLow: number;
  profitAtHigh: number;
  swing: number;
}

export interface BusinessSimulationResult {
  provenance: 'ESTIMATED';
  seed: string;
  months: BusinessMonth[];
  summary: BusinessSummary;
  sensitivity: SensitivityRow[];
  /** Stress: conversion −30% and costs +30% together, at the median. */
  stressedProfitP50: number;
  assumptions: Assumption[];
  notes: string[];
}

export interface SimulationInput<P> {
  params: P;
  assumptions: Assumption[];
  runs: number;
  horizonMonths: number;
  seed: string;
  startingCapital: number;
}

// ─────────────────────────────────────────────────────────────────── paper ──

export interface DecisionLog {
  ts: number;
  action: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface PaperStepInput<P> {
  params: P;
  account: PaperAccount;
  now: Date;
  live: DataBundle;
  /** Strategy scratch state persisted between ticks. */
  state: Record<string, unknown>;
  seed: string;
  assumptions: Assumption[];
  /** Business models: simulated days to advance in this tick. */
  daysToSimulate?: number;
}

export interface PaperStepOutput {
  changes: EngineChanges[];
  state: Record<string, unknown>;
  decisions: DecisionLog[];
  /** Business modules: simulated days advanced in this step. */
  simulatedDays?: number;
}

// ──────────────────────────────────────────────────────────────── modules ──

/**
 * A strategy or business model as the platform sees it. Implementations
 * provide whichever capabilities make sense for them; the pipeline only calls
 * what `meta.capabilities` declares.
 */
export interface StrategyModule<P = Record<string, unknown>> {
  meta: StrategyMeta<P>;
  dataRequirements(params: P): DataRequirement[];
  /** Deterministic demo data shaped like the real requirement. Always provenance DEMO. */
  syntheticData?(params: P, seed: string): DataBundle;
  backtest?(input: BacktestInput<P>): BacktestResult;
  simulate?(input: SimulationInput<P>): BusinessSimulationResult;
  paperStep?(input: PaperStepInput<P>): PaperStepOutput;
  /** Default assumptions (business models). */
  defaultAssumptions?(): Assumption[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStrategyModule = StrategyModule<any>;

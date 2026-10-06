import type { ComplianceItem, ComplianceState, Provenance, SourceType } from './enums';

/** OHLCV bar. `ts` is the bar's open time in epoch milliseconds (UTC). */
export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  venue: string;
  symbol: string;
  bid: number;
  ask: number;
  bidSize?: number | undefined;
  askSize?: number | undefined;
  last?: number | undefined;
  /** Exchange timestamp (ms). */
  ts: number;
  /** Local receive timestamp (ms); staleness is measured from this. */
  receivedAt: number;
}

export interface BookLevel {
  price: number;
  size: number;
}

/** Bids sorted best (highest) first, asks best (lowest) first. */
export interface OrderBook {
  venue: string;
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
  receivedAt: number;
  tickSize?: number | undefined;
}

export interface FundingRatePoint {
  venue: string;
  symbol: string;
  /** Funding settlement time (ms). */
  fundingTime: number;
  /** Rate per funding interval, as a fraction (0.0001 = 0.01%). */
  rate: number;
  markPrice?: number | undefined;
}

/** A binary prediction-market outcome token with its live book. */
export interface OutcomeBook {
  marketId: string;
  question: string;
  outcome: string;
  tokenId: string;
  book: OrderBook;
  /** Taker fee model for this market. */
  feeRate: number;
  feeModel: 'polymarket_pq' | 'none' | 'bps';
  negRisk?: boolean | undefined;
  endDate?: string | undefined;
}

/**
 * Risk limits, per experiment. Absolute amounts in USD. A limit of `null`
 * means "not applicable to this experiment type", never "unlimited by
 * accident": the defaults below are always populated.
 */
export interface RiskLimits {
  maxCapital: number;
  maxDailyLoss: number;
  /** Fraction of peak equity, e.g. 0.2 = 20%. */
  maxDrawdownPct: number;
  maxExposure: number;
  maxPositions: number;
  maxOrdersPerDay: number;
  maxOrderNotional: number;
  maxApiSpend: number;
  maxExperimentSpend: number;
}

export function defaultRiskLimits(capital: number): RiskLimits {
  return {
    maxCapital: capital,
    maxDailyLoss: round2(capital * 0.05),
    maxDrawdownPct: 0.2,
    maxExposure: capital,
    maxPositions: 10,
    maxOrdersPerDay: 200,
    maxOrderNotional: round2(capital * 0.25),
    maxApiSpend: 50,
    maxExperimentSpend: round2(capital * 0.5),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export interface ComplianceEntry {
  item: ComplianceItem;
  state: ComplianceState;
  note: string;
  reviewedAt?: string | null | undefined;
  reviewer?: string | null | undefined;
}

export type AssumptionDistribution = 'fixed' | 'uniform' | 'triangular' | 'pert';

/**
 * An input to an estimate. Business models are made of these; each carries
 * a range (never only a point), a unit, and either a source or the explicit
 * marker that it is an unverified assumption.
 */
export interface Assumption {
  key: string;
  label: string;
  unit: string;
  low: number;
  mode: number;
  high: number;
  distribution: AssumptionDistribution;
  /** URL or citation, or null when this is an unverified assumption. */
  source: string | null;
  note?: string | undefined;
  /** How the stress test moves this input (conversion ↓, cost ↑, churn ↑ …). */
  stressRole?: 'conversion' | 'cost' | 'churn' | 'demand' | 'price' | undefined;
}

export interface SourceRef {
  title: string;
  url: string;
  type: SourceType;
  note?: string | undefined;
}

/** A metric value tagged with where it came from. */
export interface TaggedMetric {
  name: string;
  value: number | null;
  unit?: string | undefined;
  provenance: Provenance;
}

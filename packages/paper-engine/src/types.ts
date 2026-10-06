import type { Decimal, DecimalLike } from '@aoc/core';

export type InstrumentKind = 'SPOT' | 'PERP' | 'OUTCOME';
export type Side = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type Liquidity = 'MAKER' | 'TAKER';
export type OrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

/**
 * Fee schedules.
 *  - bps:        notional × bps / 10 000 (maker and taker separately)
 *  - polymarket: shares × rate × p × (1 − p), takers only (Polymarket's
 *                published crypto-market schedule; makers pay nothing)
 *  - none:       no fees (only for tests or venues that are genuinely free)
 */
export type FeeModel =
  | { type: 'bps'; makerBps: number; takerBps: number }
  | { type: 'polymarket'; rate: number }
  | { type: 'none' };

/**
 * Slippage applied when only a top-of-book quote is available (with a full
 * book, fills walk the levels instead and slippage is measured, not assumed).
 * extra bps = fixedBps + impactBpsPer10k × notional / 10 000
 */
export interface SlippageModel {
  fixedBps: number;
  impactBpsPer10k: number;
}

export interface Instrument {
  venue: string;
  symbol: string;
  kind: InstrumentKind;
  feeModel: FeeModel;
  tickSize?: string | undefined;
  minQuantity?: string | undefined;
}

export interface BookSide {
  price: number;
  size: number;
}

/** What the engine knows about the market at the moment of an action. */
export interface MarketSnapshot {
  ts: Date;
  bid?: number | undefined;
  ask?: number | undefined;
  bidSize?: number | undefined;
  askSize?: number | undefined;
  /** Full book, best first on both sides. Preferred over the quote when present. */
  bids?: BookSide[] | undefined;
  asks?: BookSide[] | undefined;
  /** If true, a quote without sizes is treated as infinitely deep. */
  assumeInfiniteDepth?: boolean | undefined;
}

export interface OrderRequest {
  clientOrderId: string;
  instrument: Instrument;
  side: Side;
  type: OrderType;
  quantity: DecimalLike;
  limitPrice?: DecimalLike | undefined;
  reduceOnly?: boolean | undefined;
  postOnly?: boolean | undefined;
  reason?: string | undefined;
}

export interface OrderState {
  id: string;
  clientOrderId: string;
  instrument: Instrument;
  side: Side;
  type: OrderType;
  quantity: Decimal;
  limitPrice: Decimal | null;
  status: OrderStatus;
  filledQuantity: Decimal;
  avgFillPrice: Decimal | null;
  /** Cash held back for an open buy (or margin for a perp). */
  reserved: Decimal;
  rejectReason: string | null;
  reduceOnly: boolean;
  postOnly: boolean;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FillState {
  id: string;
  orderId: string;
  venue: string;
  symbol: string;
  side: Side;
  quantity: Decimal;
  price: Decimal;
  fee: Decimal;
  slippageCost: Decimal;
  liquidity: Liquidity;
  realizedPnl: Decimal;
  ts: Date;
}

export interface PositionState {
  venue: string;
  symbol: string;
  kind: InstrumentKind;
  /** Signed: positive long, negative short (perps only). */
  quantity: Decimal;
  avgPrice: Decimal;
  realizedPnl: Decimal;
  markPrice: Decimal | null;
  openedAt: Date;
  updatedAt: Date;
}

export type TransactionType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'TRADE'
  | 'FEE'
  | 'FUNDING'
  | 'SETTLEMENT'
  | 'REALIZED_PNL'
  | 'REVENUE'
  | 'COST';

export interface TransactionState {
  id: string;
  seq: number;
  type: TransactionType;
  /** Signed cash effect. */
  amount: Decimal;
  balanceAfter: Decimal;
  category: string | null;
  description: string;
  refOrderId: string | null;
  refFillId: string | null;
  ts: Date;
}

export type AccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';

export interface AccountSnapshot {
  id: string;
  startingCapital: Decimal;
  cash: Decimal;
  reservedCash: Decimal;
  availableCash: Decimal;
  equity: Decimal;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  feesPaid: Decimal;
  slippageCost: Decimal;
  fundingPnl: Decimal;
  operatingPnl: Decimal;
  exposure: Decimal;
  peakEquity: Decimal;
  drawdownPct: number;
  dayKey: string;
  dayStartEquity: Decimal;
  dayPnl: Decimal;
  ordersToday: number;
  openPositions: number;
  openOrders: number;
  spendTotal: Decimal;
  apiSpendTotal: Decimal;
  status: AccountStatus;
}

/** Everything a single engine operation changed, for persistence. */
export interface EngineChanges {
  orders: OrderState[];
  fills: FillState[];
  transactions: TransactionState[];
  positions: PositionState[];
  /** Positions that went to zero and were removed. */
  closedPositions: Array<{ venue: string; symbol: string }>;
}

/** A pre-trade hook returns violations; any violation rejects the order. */
export type PreTradeHook = (ctx: {
  account: AccountSnapshot;
  request: OrderRequest;
  estimatedNotional: Decimal;
  estimatedFee: Decimal;
  positions: readonly PositionState[];
  ts: Date;
}) => string[];

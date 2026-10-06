import { Decimal, MONEY_SCALE, d, newId, utcDayKey, type DecimalLike } from '@aoc/core';
import { computeFee, worstCaseFee } from './fees';
import { DEFAULT_SLIPPAGE, simulateTakerFill, vwap, type FillSlice } from './fills';
import type {
  AccountSnapshot,
  AccountStatus,
  EngineChanges,
  FillState,
  Instrument,
  Liquidity,
  MarketSnapshot,
  OrderRequest,
  OrderState,
  PositionState,
  PreTradeHook,
  SlippageModel,
  TransactionState,
  TransactionType,
} from './types';

const ZERO = new Decimal(0);

export interface PaperAccountOptions {
  idGen?: () => string;
  slippage?: SlippageModel;
  preTradeHooks?: PreTradeHook[];
  /**
   * When a resting limit order is considered filled:
   *  - 'through' (default, conservative): the opposite touch must trade *through*
   *    the limit (ask < buy limit). Being merely touched does not fill, because
   *    our order would have been behind the queue.
   *  - 'touch': ask <= buy limit fills.
   */
  restingFillModel?: 'through' | 'touch';
}

/** Persistable state of an account; `restore` rebuilds an identical engine. */
export interface PaperAccountState {
  id: string;
  startingCapital: string;
  cash: string;
  realizedPnl: string;
  feesPaid: string;
  slippageCost: string;
  fundingPnl: string;
  operatingPnl: string;
  peakEquity: string;
  dayKey: string;
  dayStartEquity: string;
  ordersToday: number;
  spendTotal: string;
  apiSpendTotal: string;
  ledgerSeq: number;
  status: AccountStatus;
  positions: PositionState[];
  openOrders: OrderState[];
}

export interface SubmitResult {
  order: OrderState;
  duplicate: boolean;
  changes: EngineChanges;
}

function emptyChanges(): EngineChanges {
  return { orders: [], fills: [], transactions: [], positions: [], closedPositions: [] };
}

function key(venue: string, symbol: string): string {
  return `${venue}::${symbol}`;
}

/**
 * A virtual trading/operating account.
 *
 * Accounting model (average cost):
 *   SPOT/OUTCOME  cash moves by the full notional; equity = cash + Σ qty × mark
 *   PERP          no notional changes hands; realised P&L is credited to cash
 *                 on reduction; equity = cash + Σ qty × (mark − avg).
 *                 Perps are fully collateralised (1×): leverage is deliberately
 *                 not simulated, so margin required = notional.
 * Identity (tested): equity = contributed capital + realised + unrealised
 *   − fees + funding + operating, to within rounding of the 10-dp scale
 *   (average prices are quotients and are rounded to that scale).
 * Ledger invariant (tested, exact): cash = Σ transaction amounts.
 *
 * Every mutating method takes the event time explicitly; the engine never
 * reads a clock, which keeps backtests deterministic.
 */
export class PaperAccount {
  readonly id: string;
  private startingCapital: Decimal;
  private cash: Decimal;
  private realizedPnl: Decimal;
  private feesPaid: Decimal;
  private slippageCost: Decimal;
  private fundingPnl: Decimal;
  private operatingPnl: Decimal;
  private peakEquity: Decimal;
  private dayKey: string;
  private dayStartEquity: Decimal;
  private ordersToday: number;
  private spendTotal: Decimal;
  private apiSpendTotal: Decimal;
  private ledgerSeq: number;
  private status: AccountStatus;
  private readonly positionsByKey = new Map<string, PositionState>();
  /** Open (and just-finished) orders. Terminal orders move to `finished`. */
  private readonly orders = new Map<string, OrderState>();
  /** Recently finished orders, kept for idempotent duplicate replies (bounded). */
  private readonly finished = new Map<string, OrderState>();
  private readonly clientIds = new Map<string, string>();
  private readonly idGen: () => string;
  private readonly slippage: SlippageModel;
  private readonly hooks: PreTradeHook[];
  private readonly restingFillModel: 'through' | 'touch';

  private constructor(state: PaperAccountState, opts: PaperAccountOptions) {
    this.id = state.id;
    this.startingCapital = d(state.startingCapital);
    this.cash = d(state.cash);
    this.realizedPnl = d(state.realizedPnl);
    this.feesPaid = d(state.feesPaid);
    this.slippageCost = d(state.slippageCost);
    this.fundingPnl = d(state.fundingPnl);
    this.operatingPnl = d(state.operatingPnl);
    this.peakEquity = d(state.peakEquity);
    this.dayKey = state.dayKey;
    this.dayStartEquity = d(state.dayStartEquity);
    this.ordersToday = state.ordersToday;
    this.spendTotal = d(state.spendTotal);
    this.apiSpendTotal = d(state.apiSpendTotal);
    this.ledgerSeq = state.ledgerSeq;
    this.status = state.status;
    for (const p of state.positions) this.positionsByKey.set(key(p.venue, p.symbol), clonePosition(p));
    for (const o of state.openOrders) {
      const copy = cloneOrder(o);
      this.orders.set(copy.id, copy);
      this.clientIds.set(copy.clientOrderId, copy.id);
    }
    this.idGen = opts.idGen ?? newId;
    this.slippage = opts.slippage ?? DEFAULT_SLIPPAGE;
    this.hooks = opts.preTradeHooks ?? [];
    this.restingFillModel = opts.restingFillModel ?? 'through';
  }

  /** Open a new account funded with `startingCapital` (recorded as a DEPOSIT). */
  static open(
    init: { id?: string; startingCapital: DecimalLike; ts: Date },
    opts: PaperAccountOptions = {},
  ): { account: PaperAccount; changes: EngineChanges } {
    const capital = qz(d(init.startingCapital));
    if (capital.lt(0)) throw new RangeError('starting capital must be >= 0');
    const account = new PaperAccount(
      {
        id: init.id ?? (opts.idGen ?? newId)(),
        startingCapital: '0',
        cash: '0',
        realizedPnl: '0',
        feesPaid: '0',
        slippageCost: '0',
        fundingPnl: '0',
        operatingPnl: '0',
        peakEquity: '0',
        dayKey: utcDayKey(init.ts),
        dayStartEquity: '0',
        ordersToday: 0,
        spendTotal: '0',
        apiSpendTotal: '0',
        ledgerSeq: 0,
        status: 'ACTIVE',
        positions: [],
        openOrders: [],
      },
      opts,
    );
    const changes = emptyChanges();
    if (capital.gt(0)) {
      account.startingCapital = capital;
      account.post(changes, 'DEPOSIT', capital, init.ts, { description: 'Initial paper capital allocation' });
      account.peakEquity = capital;
      account.dayStartEquity = capital;
    }
    return { account, changes };
  }

  static restore(state: PaperAccountState, opts: PaperAccountOptions = {}): PaperAccount {
    return new PaperAccount(state, opts);
  }

  exportState(): PaperAccountState {
    return {
      id: this.id,
      startingCapital: this.startingCapital.toString(),
      cash: this.cash.toString(),
      realizedPnl: this.realizedPnl.toString(),
      feesPaid: this.feesPaid.toString(),
      slippageCost: this.slippageCost.toString(),
      fundingPnl: this.fundingPnl.toString(),
      operatingPnl: this.operatingPnl.toString(),
      peakEquity: this.peakEquity.toString(),
      dayKey: this.dayKey,
      dayStartEquity: this.dayStartEquity.toString(),
      ordersToday: this.ordersToday,
      spendTotal: this.spendTotal.toString(),
      apiSpendTotal: this.apiSpendTotal.toString(),
      ledgerSeq: this.ledgerSeq,
      status: this.status,
      positions: this.positions().map(clonePosition),
      openOrders: this.openOrders().map(cloneOrder),
    };
  }

  // ─────────────────────────────────────────────────────────────── reads ──

  positions(): PositionState[] {
    return [...this.positionsByKey.values()].map(clonePosition);
  }

  position(venue: string, symbol: string): PositionState | null {
    const p = this.positionsByKey.get(key(venue, symbol));
    return p ? clonePosition(p) : null;
  }

  openOrders(): OrderState[] {
    return [...this.orders.values()].filter((o) => o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED').map(cloneOrder);
  }

  getStatus(): AccountStatus {
    return this.status;
  }

  snapshot(): AccountSnapshot {
    let positionValue = ZERO;
    let unrealized = ZERO;
    let exposure = ZERO;
    let open = 0;
    for (const p of this.positionsByKey.values()) {
      if (p.quantity.isZero()) continue;
      open++;
      const mark = p.markPrice ?? p.avgPrice;
      const upnl = p.quantity.mul(mark.minus(p.avgPrice));
      unrealized = unrealized.plus(upnl);
      exposure = exposure.plus(p.quantity.mul(mark).abs());
      positionValue = positionValue.plus(p.kind === 'PERP' ? upnl : p.quantity.mul(mark));
    }
    const equity = this.cash.plus(positionValue);
    const reserved = this.reservedCash();
    const peak = Decimal.max(this.peakEquity, equity);
    const dd = peak.gt(0) ? peak.minus(equity).div(peak).toNumber() : 0;
    return {
      id: this.id,
      startingCapital: this.startingCapital,
      cash: this.cash,
      reservedCash: reserved,
      availableCash: this.cash.minus(reserved),
      equity,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      feesPaid: this.feesPaid,
      slippageCost: this.slippageCost,
      fundingPnl: this.fundingPnl,
      operatingPnl: this.operatingPnl,
      exposure,
      peakEquity: peak,
      drawdownPct: Math.max(0, dd),
      dayKey: this.dayKey,
      dayStartEquity: this.dayStartEquity,
      dayPnl: equity.minus(this.dayStartEquity),
      ordersToday: this.ordersToday,
      openPositions: open,
      openOrders: this.openOrders().length,
      spendTotal: this.spendTotal,
      apiSpendTotal: this.apiSpendTotal,
      status: this.status,
    };
  }

  // ───────────────────────────────────────────────────────── cash moves ──

  deposit(amount: DecimalLike, ts: Date, description = 'Deposit'): EngineChanges {
    const a = qz(d(amount));
    if (a.lte(0)) throw new RangeError('deposit must be positive');
    this.rollDay(ts);
    const changes = emptyChanges();
    this.post(changes, 'DEPOSIT', a, ts, { description });
    this.startingCapital = this.startingCapital.plus(a);
    this.dayStartEquity = this.dayStartEquity.plus(a);
    this.peakEquity = this.peakEquity.plus(a);
    return changes;
  }

  withdraw(amount: DecimalLike, ts: Date, description = 'Withdrawal'): EngineChanges {
    const a = qz(d(amount));
    if (a.lte(0)) throw new RangeError('withdrawal must be positive');
    this.rollDay(ts);
    if (a.gt(this.cash.minus(this.reservedCash()))) throw new RangeError('withdrawal exceeds available cash');
    const changes = emptyChanges();
    this.post(changes, 'WITHDRAWAL', a.neg(), ts, { description });
    this.startingCapital = this.startingCapital.minus(a);
    this.dayStartEquity = this.dayStartEquity.minus(a);
    this.peakEquity = Decimal.max(this.peakEquity.minus(a), 0);
    return changes;
  }

  /**
   * Operating revenue or cost for business-model paper tests. Costs may take
   * cash below zero (a business can owe money); the risk engine treats
   * negative equity as a breach.
   */
  recordOperating(
    kind: 'REVENUE' | 'COST',
    amount: DecimalLike,
    ts: Date,
    opts: { category: string; description?: string; isApiCost?: boolean },
  ): EngineChanges {
    const a = qz(d(amount));
    if (a.lt(0)) throw new RangeError('operating amounts are positive; the kind sets the sign');
    this.assertActive();
    this.rollDay(ts);
    const changes = emptyChanges();
    if (a.isZero()) return changes;
    if (kind === 'REVENUE') {
      this.post(changes, 'REVENUE', a, ts, { category: opts.category, description: opts.description ?? opts.category });
      this.operatingPnl = this.operatingPnl.plus(a);
    } else {
      this.post(changes, 'COST', a.neg(), ts, { category: opts.category, description: opts.description ?? opts.category });
      this.operatingPnl = this.operatingPnl.minus(a);
      this.spendTotal = this.spendTotal.plus(a);
      if (opts.isApiCost) this.apiSpendTotal = this.apiSpendTotal.plus(a);
    }
    this.updatePeak();
    return changes;
  }

  /** External API spend attributed to a trading experiment (e.g. a paid data feed). */
  recordApiSpend(amount: DecimalLike, ts: Date, description: string): EngineChanges {
    return this.recordOperating('COST', amount, ts, { category: 'api', description, isApiCost: true });
  }

  // ───────────────────────────────────────────────────────────── orders ──

  submitOrder(req: OrderRequest, market: MarketSnapshot): SubmitResult {
    const ts = market.ts;
    this.rollDay(ts);
    const changes = emptyChanges();

    const existingId = this.clientIds.get(req.clientOrderId);
    if (existingId) {
      const existing = this.orders.get(existingId) ?? this.finished.get(existingId);
      if (existing) return { order: cloneOrder(existing), duplicate: true, changes };
    }

    const rawQty = safeDecimal(req.quantity);
    const qty = rawQty === null ? null : qz(rawQty);
    const rawLimit = req.limitPrice === undefined || req.limitPrice === null ? null : safeDecimal(req.limitPrice);
    const limit = rawLimit === null ? null : qz(rawLimit);
    const order: OrderState = {
      id: this.idGen(),
      clientOrderId: req.clientOrderId,
      instrument: req.instrument,
      side: req.side,
      type: req.type,
      quantity: qty ?? ZERO,
      limitPrice: limit,
      status: 'OPEN',
      filledQuantity: ZERO,
      avgFillPrice: null,
      reserved: ZERO,
      rejectReason: null,
      reduceOnly: req.reduceOnly ?? false,
      postOnly: req.postOnly ?? false,
      reason: req.reason ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.orders.set(order.id, order);
    this.clientIds.set(order.clientOrderId, order.id);
    this.ordersToday++;

    const reject = (reason: string): SubmitResult => {
      order.status = 'REJECTED';
      order.rejectReason = reason;
      order.updatedAt = ts;
      changes.orders.push(cloneOrder(order));
      this.archiveIfDone(order);
      return { order: cloneOrder(order), duplicate: false, changes };
    };

    if (this.status !== 'ACTIVE') return reject(`account is ${this.status}`);
    if (qty === null || qty.lte(0)) return reject('quantity must be a positive number');
    if (req.limitPrice !== undefined && req.limitPrice !== null && limit === null) return reject('limit price is not a number');
    const inst = req.instrument;
    if (inst.minQuantity && qty.lt(inst.minQuantity)) return reject(`quantity below minimum ${inst.minQuantity}`);
    if (req.type === 'LIMIT') {
      if (limit === null || limit.lte(0)) return reject('limit order requires a positive limit price');
      if (inst.tickSize && !limit.mod(inst.tickSize).isZero()) return reject(`limit price not a multiple of tick ${inst.tickSize}`);
    }
    if (req.type === 'MARKET' && order.postOnly) return reject('post-only market orders are contradictory');
    if (inst.kind === 'OUTCOME' && limit !== null && (limit.lte(0) || limit.gte(1))) return reject('outcome prices must be in (0, 1)');

    const pos = this.positionsByKey.get(key(inst.venue, inst.symbol));
    const posQty = pos?.quantity ?? ZERO;
    const signed = req.side === 'BUY' ? qty : qty.neg();

    if (order.reduceOnly) {
      if (posQty.isZero() || sgn(posQty) === sgn(signed)) return reject('reduce-only order would not reduce a position');
      if (qty.gt(posQty.abs())) return reject('reduce-only order larger than the position');
    }
    if ((inst.kind === 'SPOT' || inst.kind === 'OUTCOME') && req.side === 'SELL') {
      const free = posQty.minus(this.reservedQuantity(inst.venue, inst.symbol, order.id));
      if (free.lt(qty)) return reject(`insufficient holdings to sell (free ${free.toString()}); short selling is not allowed for ${inst.kind}`);
    }

    // Price the order: dry-run the taker part to know what it would cost.
    const marketable = this.isMarketable(req.side, limit, market, req.type);
    if (order.postOnly && marketable) return reject('post-only order would cross the spread');
    const dry = marketable ? simulateTakerFill(req.side, qty, limit, market, this.slippage) : null;
    const refPrice = limit ?? dry?.touchPrice ?? null;
    if (refPrice === null) return reject(dry?.shortfallReason ?? 'no market price available');
    const estPrice = dry && dry.filledQuantity.gt(0) ? (vwap(dry.slices) ?? refPrice) : refPrice;
    const estNotional = qty.mul(Decimal.max(estPrice, refPrice));
    const estFee = worstCaseFee(inst.feeModel, qty, Decimal.max(estPrice, refPrice));

    // Funding checks.
    const snap = this.snapshot();
    if (inst.kind === 'PERP') {
      const reducing = !posQty.isZero() && sgn(posQty) !== sgn(signed);
      const opening = reducing ? Decimal.max(qty.minus(posQty.abs()), 0) : qty;
      const required = opening.mul(Decimal.max(estPrice, refPrice)).plus(estFee);
      const free = snap.equity.minus(this.usedMargin()).minus(snap.reservedCash);
      if (required.gt(free)) return reject(`insufficient margin (required ${required.toFixed(2)}, free ${free.toFixed(2)})`);
    } else if (req.side === 'BUY') {
      if (estNotional.plus(estFee).gt(snap.availableCash)) {
        return reject(`insufficient cash (required ${estNotional.plus(estFee).toFixed(2)}, available ${snap.availableCash.toFixed(2)})`);
      }
    }

    // Risk hooks have the final word.
    for (const hook of this.hooks) {
      const violations = hook({ account: snap, request: req, estimatedNotional: estNotional, estimatedFee: estFee, positions: this.positions(), ts });
      if (violations.length > 0) return reject(`risk: ${violations.join('; ')}`);
    }

    // Execute the aggressive part.
    if (dry && dry.filledQuantity.gt(0)) {
      this.executeSlices(order, dry.slices, 'TAKER', dry.slippageCost, ts, changes);
    }

    const remaining = order.quantity.minus(order.filledQuantity);
    if (req.type === 'MARKET') {
      if (order.filledQuantity.isZero()) {
        order.status = 'REJECTED';
        order.rejectReason = dry?.shortfallReason ?? 'no liquidity';
      } else if (remaining.gt(0)) {
        order.status = 'CANCELLED';
        order.rejectReason = `remainder ${remaining.toString()} cancelled: ${dry?.shortfallReason ?? 'insufficient depth'}`;
      } else {
        order.status = 'FILLED';
      }
    } else if (remaining.isZero()) {
      order.status = 'FILLED';
    } else {
      // Rest the remainder; reserve what it could cost.
      order.status = order.filledQuantity.gt(0) ? 'PARTIALLY_FILLED' : 'OPEN';
      order.reserved = this.reservationFor(order, remaining);
    }
    order.updatedAt = ts;
    changes.orders.push(cloneOrder(order));
    this.archiveIfDone(order);
    this.updatePeak();
    return { order: cloneOrder(order), duplicate: false, changes };
  }

  cancelOrder(orderId: string, ts: Date, reason = 'cancelled'): EngineChanges {
    const changes = emptyChanges();
    const order = this.orders.get(orderId);
    if (!order) {
      if (this.finished.has(orderId)) return changes;
      throw new RangeError(`unknown order ${orderId}`);
    }
    if (order.status !== 'OPEN' && order.status !== 'PARTIALLY_FILLED') return changes;
    order.status = 'CANCELLED';
    order.reserved = ZERO;
    order.rejectReason = reason;
    order.updatedAt = ts;
    changes.orders.push(cloneOrder(order));
    this.archiveIfDone(order);
    return changes;
  }

  cancelAll(ts: Date, reason: string): EngineChanges {
    const changes = emptyChanges();
    for (const o of this.openOrders()) merge(changes, this.cancelOrder(o.id, ts, reason));
    return changes;
  }

  /**
   * New market data for one instrument: fill resting orders that the market
   * traded through, then mark the position to the mid.
   */
  onMarket(venue: string, symbol: string, market: MarketSnapshot): EngineChanges {
    this.rollDay(market.ts);
    const changes = emptyChanges();
    const bestAsk = market.asks?.[0]?.price ?? market.ask;
    const bestBid = market.bids?.[0]?.price ?? market.bid;
    for (const o of this.orders.values()) {
      if (o.instrument.venue !== venue || o.instrument.symbol !== symbol) continue;
      if (o.status !== 'OPEN' && o.status !== 'PARTIALLY_FILLED') continue;
      if (o.limitPrice === null) continue;
      const remaining = o.quantity.minus(o.filledQuantity);
      let crosses = false;
      let available: number | undefined;
      if (o.side === 'BUY' && bestAsk !== undefined) {
        crosses = this.restingFillModel === 'through' ? d(bestAsk).lt(o.limitPrice) : d(bestAsk).lte(o.limitPrice);
        available = market.asks?.[0]?.size ?? market.askSize;
      } else if (o.side === 'SELL' && bestBid !== undefined) {
        crosses = this.restingFillModel === 'through' ? d(bestBid).gt(o.limitPrice) : d(bestBid).gte(o.limitPrice);
        available = market.bids?.[0]?.size ?? market.bidSize;
      }
      if (!crosses) continue;
      let qty = remaining;
      if (available !== undefined && !market.assumeInfiniteDepth) qty = Decimal.min(qty, d(available));
      if (qty.lte(0)) continue;
      // Spot sells must still be covered (holdings may have changed).
      if ((o.instrument.kind === 'SPOT' || o.instrument.kind === 'OUTCOME') && o.side === 'SELL') {
        const held = this.positionsByKey.get(key(venue, symbol))?.quantity ?? ZERO;
        qty = Decimal.min(qty, Decimal.max(held, 0));
        if (qty.lte(0)) {
          merge(changes, this.cancelOrder(o.id, market.ts, 'holdings no longer cover the order'));
          continue;
        }
      }
      o.reserved = ZERO; // released, then re-reserved for any remainder below
      this.executeSlices(o, [{ quantity: qty, price: o.limitPrice }], 'MAKER', ZERO, market.ts, changes);
      const left = o.quantity.minus(o.filledQuantity);
      if (left.isZero()) {
        o.status = 'FILLED';
      } else {
        o.status = 'PARTIALLY_FILLED';
        o.reserved = this.reservationFor(o, left);
      }
      o.updatedAt = market.ts;
      changes.orders.push(cloneOrder(o));
    }
    for (const o of [...this.orders.values()]) this.archiveIfDone(o);
    const mid = midPrice(bestBid, bestAsk);
    if (mid !== null) this.markInternal(venue, symbol, mid, market.ts, changes);
    this.updatePeak();
    return changes;
  }

  /** Set the mark price for a position (e.g. from a last-trade or index price). */
  mark(venue: string, symbol: string, price: DecimalLike, ts: Date): EngineChanges {
    this.rollDay(ts);
    const changes = emptyChanges();
    this.markInternal(venue, symbol, d(price), ts, changes);
    this.updatePeak();
    return changes;
  }

  /**
   * Perpetual funding. `rate` is per interval; a positive rate means longs
   * pay shorts: payment = −quantity × markPrice × rate.
   */
  applyFunding(venue: string, symbol: string, rate: number, markPrice: DecimalLike, ts: Date): EngineChanges {
    this.rollDay(ts);
    const changes = emptyChanges();
    const p = this.positionsByKey.get(key(venue, symbol));
    if (!p || p.kind !== 'PERP' || p.quantity.isZero()) return changes;
    const payment = qz(p.quantity.mul(d(markPrice)).mul(d(rate)).neg());
    if (payment.isZero()) return changes;
    this.post(changes, 'FUNDING', payment, ts, { description: `Funding ${symbol} @ ${rate}`, category: 'funding' });
    this.fundingPnl = this.fundingPnl.plus(payment);
    this.updatePeak();
    return changes;
  }

  /**
   * Resolve a prediction-market outcome token. `payout` is the per-share
   * value at resolution (1 for the winning outcome, 0 otherwise).
   */
  settleOutcome(venue: string, symbol: string, payout: DecimalLike, ts: Date): EngineChanges {
    this.rollDay(ts);
    const changes = emptyChanges();
    const pay = d(payout);
    if (pay.lt(0) || pay.gt(1)) throw new RangeError('outcome payout must be within [0, 1]');
    for (const o of this.orders.values()) {
      if (o.instrument.venue === venue && o.instrument.symbol === symbol && (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED')) {
        merge(changes, this.cancelOrder(o.id, ts, 'market resolved'));
      }
    }
    const k = key(venue, symbol);
    const p = this.positionsByKey.get(k);
    if (!p || p.quantity.isZero()) return changes;
    if (p.kind !== 'OUTCOME') throw new RangeError(`${symbol} is not an outcome token`);
    const proceeds = qz(p.quantity.mul(pay));
    const realized = qz(pay.minus(p.avgPrice).mul(p.quantity));
    this.post(changes, 'SETTLEMENT', proceeds, ts, { description: `Resolution ${symbol} @ ${pay.toString()}` });
    this.realizedPnl = this.realizedPnl.plus(realized);
    p.realizedPnl = p.realizedPnl.plus(realized);
    p.quantity = ZERO;
    p.markPrice = pay;
    p.updatedAt = ts;
    this.positionsByKey.delete(k);
    changes.closedPositions.push({ venue, symbol });
    this.updatePeak();
    return changes;
  }

  freeze(): void {
    if (this.status === 'ACTIVE') this.status = 'FROZEN';
  }

  unfreeze(): void {
    if (this.status === 'FROZEN') this.status = 'ACTIVE';
  }

  close(ts: Date): EngineChanges {
    const changes = this.cancelAll(ts, 'account closed');
    this.status = 'CLOSED';
    return changes;
  }

  // ─────────────────────────────────────────────────────────── internals ──

  private static readonly FINISHED_CAP = 5_000;

  private archiveIfDone(o: OrderState): void {
    if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') return;
    this.orders.delete(o.id);
    this.finished.set(o.id, o);
    if (this.finished.size > PaperAccount.FINISHED_CAP) {
      const oldest = this.finished.keys().next().value as string;
      const old = this.finished.get(oldest);
      this.finished.delete(oldest);
      if (old) this.clientIds.delete(old.clientOrderId);
    }
  }

  private assertActive(): void {
    if (this.status !== 'ACTIVE') throw new RangeError(`account is ${this.status}`);
  }

  private isMarketable(side: 'BUY' | 'SELL', limit: Decimal | null, market: MarketSnapshot, type: 'MARKET' | 'LIMIT'): boolean {
    if (type === 'MARKET') return true;
    if (limit === null) return false;
    if (side === 'BUY') {
      const ask = market.asks?.[0]?.price ?? market.ask;
      return ask !== undefined && d(ask).lte(limit);
    }
    const bid = market.bids?.[0]?.price ?? market.bid;
    return bid !== undefined && d(bid).gte(limit);
  }

  private reservationFor(order: OrderState, remaining: Decimal): Decimal {
    if (order.limitPrice === null) return ZERO;
    const fee = worstCaseFee(order.instrument.feeModel, remaining, order.limitPrice);
    if (order.instrument.kind === 'PERP') return qz(remaining.mul(order.limitPrice).plus(fee));
    // Spot/outcome sells reserve holdings (see reservedQuantity), not cash.
    return order.side === 'BUY' ? qz(remaining.mul(order.limitPrice).plus(fee)) : ZERO;
  }

  private reservedCash(): Decimal {
    let r = ZERO;
    for (const o of this.orders.values()) {
      if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') r = r.plus(o.reserved);
    }
    return r;
  }

  private reservedQuantity(venue: string, symbol: string, excludeOrderId?: string): Decimal {
    let r = ZERO;
    for (const o of this.orders.values()) {
      if (o.id === excludeOrderId) continue;
      if ((o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') && o.side === 'SELL' && o.instrument.venue === venue && o.instrument.symbol === symbol) {
        r = r.plus(o.quantity.minus(o.filledQuantity));
      }
    }
    return r;
  }

  private usedMargin(): Decimal {
    let m = ZERO;
    for (const p of this.positionsByKey.values()) {
      if (p.kind !== 'PERP' || p.quantity.isZero()) continue;
      m = m.plus(p.quantity.abs().mul(p.markPrice ?? p.avgPrice));
    }
    return m;
  }

  private executeSlices(order: OrderState, slices: FillSlice[], liquidity: Liquidity, slippageTotal: Decimal, ts: Date, changes: EngineChanges): void {
    const totalQty = slices.reduce((a, s) => a.plus(s.quantity), ZERO);
    for (const s of slices) {
      const share = totalQty.gt(0) ? s.quantity.div(totalQty) : ZERO;
      this.applyFill(order, s.quantity, s.price, liquidity, slippageTotal.mul(share), ts, changes);
    }
  }

  private applyFill(order: OrderState, rawQty: Decimal, rawPrice: Decimal, liquidity: Liquidity, rawSlippage: Decimal, ts: Date, changes: EngineChanges): void {
    const inst = order.instrument;
    const qty = qz(rawQty);
    const price = qz(rawPrice);
    const slippage = qz(rawSlippage);
    const fee = qz(computeFee(inst.feeModel, liquidity, qty, price));
    const k = key(inst.venue, inst.symbol);
    let p = this.positionsByKey.get(k);
    if (!p) {
      p = { venue: inst.venue, symbol: inst.symbol, kind: inst.kind, quantity: ZERO, avgPrice: ZERO, realizedPnl: ZERO, markPrice: price, openedAt: ts, updatedAt: ts };
      this.positionsByKey.set(k, p);
    }
    const signed = order.side === 'BUY' ? qty : qty.neg();
    let realized = ZERO;
    if (p.quantity.isZero() || sgn(p.quantity) === sgn(signed)) {
      const newQty = p.quantity.plus(signed);
      p.avgPrice = qz(p.quantity.abs().mul(p.avgPrice).plus(qty.mul(price)).div(newQty.abs()));
      if (p.quantity.isZero()) p.openedAt = ts;
      p.quantity = newQty;
    } else {
      const closing = Decimal.min(p.quantity.abs(), qty);
      realized = qz(closing.mul(price.minus(p.avgPrice)).mul(sgn(p.quantity)));
      const newQty = p.quantity.plus(signed);
      if (newQty.isZero()) {
        p.quantity = ZERO;
      } else if (sgn(newQty) === sgn(p.quantity)) {
        p.quantity = newQty; // reduced, average unchanged
      } else {
        p.quantity = newQty; // flipped: remainder opens at the fill price
        p.avgPrice = price;
        p.openedAt = ts;
      }
    }
    p.realizedPnl = p.realizedPnl.plus(realized);
    p.markPrice = price;
    p.updatedAt = ts;
    this.realizedPnl = this.realizedPnl.plus(realized);
    this.feesPaid = this.feesPaid.plus(fee);
    this.spendTotal = this.spendTotal.plus(fee);
    this.slippageCost = this.slippageCost.plus(slippage);

    const fill: FillState = {
      id: this.idGen(),
      orderId: order.id,
      venue: inst.venue,
      symbol: inst.symbol,
      side: order.side,
      quantity: qty,
      price,
      fee,
      slippageCost: slippage,
      liquidity,
      realizedPnl: realized,
      ts,
    };
    changes.fills.push(fill);

    const tag = { refOrderId: order.id, refFillId: fill.id };
    if (inst.kind === 'PERP') {
      if (!realized.isZero()) this.post(changes, 'REALIZED_PNL', realized, ts, { ...tag, description: `Realised ${inst.symbol}` });
    } else {
      const notional = qz(qty.mul(price));
      this.post(changes, 'TRADE', order.side === 'BUY' ? notional.neg() : notional, ts, {
        ...tag,
        description: `${order.side} ${qty.toString()} ${inst.symbol} @ ${price.toString()}`,
      });
    }
    if (fee.gt(0)) this.post(changes, 'FEE', fee.neg(), ts, { ...tag, description: `${liquidity} fee ${inst.symbol}`, category: 'trading_fee' });

    const prevFilled = order.filledQuantity;
    order.filledQuantity = prevFilled.plus(qty);
    order.avgFillPrice =
      order.avgFillPrice === null ? price : qz(order.avgFillPrice.mul(prevFilled).plus(price.mul(qty)).div(order.filledQuantity));
    order.updatedAt = ts;

    if (p.quantity.isZero()) {
      this.positionsByKey.delete(k);
      changes.closedPositions.push({ venue: inst.venue, symbol: inst.symbol });
    } else {
      upsertPosition(changes, p);
    }
  }

  private markInternal(venue: string, symbol: string, price: Decimal, ts: Date, changes: EngineChanges): void {
    const p = this.positionsByKey.get(key(venue, symbol));
    if (!p) return;
    p.markPrice = price;
    p.updatedAt = ts;
    upsertPosition(changes, p);
  }

  private post(
    changes: EngineChanges,
    type: TransactionType,
    amount: Decimal,
    ts: Date,
    opts: { description?: string; category?: string; refOrderId?: string; refFillId?: string } = {},
  ): void {
    if (!qz(amount).eq(amount)) throw new RangeError(`ledger amount ${amount.toString()} exceeds ${MONEY_SCALE} decimals`);
    this.cash = this.cash.plus(amount);
    this.ledgerSeq += 1;
    changes.transactions.push({
      id: this.idGen(),
      seq: this.ledgerSeq,
      type,
      amount,
      balanceAfter: this.cash,
      category: opts.category ?? null,
      description: opts.description ?? type,
      refOrderId: opts.refOrderId ?? null,
      refFillId: opts.refFillId ?? null,
      ts,
    });
  }

  private rollDay(ts: Date): void {
    const k = utcDayKey(ts);
    if (k === this.dayKey) return;
    if (k < this.dayKey) return; // late event from the previous day: keep the current day
    this.dayKey = k;
    this.dayStartEquity = this.snapshot().equity;
    this.ordersToday = 0;
  }

  private updatePeak(): void {
    const eq = this.snapshot().equity;
    if (eq.gt(this.peakEquity)) this.peakEquity = eq;
  }
}

/**
 * Everything that touches cash is quantised to the persisted scale (10 dp)
 * *before* it is applied, so the in-memory ledger and the database ledger are
 * identical and `cash == Σ amounts` holds exactly after a round trip.
 */
function qz(x: Decimal): Decimal {
  return x.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_EVEN);
}

function sgn(x: Decimal): number {
  return x.isZero() ? 0 : x.isNegative() ? -1 : 1;
}

function safeDecimal(v: DecimalLike): Decimal | null {
  try {
    const x = d(v);
    return x.isFinite() ? x : null;
  } catch {
    return null;
  }
}

function midPrice(bid: number | undefined, ask: number | undefined): Decimal | null {
  if (bid !== undefined && ask !== undefined && bid > 0 && ask > 0) return d(bid).plus(ask).div(2);
  if (bid !== undefined && bid > 0) return d(bid);
  if (ask !== undefined && ask > 0) return d(ask);
  return null;
}

function upsertPosition(changes: EngineChanges, p: PositionState): void {
  const i = changes.positions.findIndex((x) => x.venue === p.venue && x.symbol === p.symbol);
  const copy = clonePosition(p);
  if (i >= 0) changes.positions[i] = copy;
  else changes.positions.push(copy);
}

export function merge(into: EngineChanges, from: EngineChanges): EngineChanges {
  into.orders.push(...from.orders);
  into.fills.push(...from.fills);
  into.transactions.push(...from.transactions);
  for (const p of from.positions) upsertPosition(into, p);
  into.closedPositions.push(...from.closedPositions);
  return into;
}

function clonePosition(p: PositionState): PositionState {
  return { ...p };
}

function cloneOrder(o: OrderState): OrderState {
  return { ...o };
}

import { Decimal, Rng, d } from '@aoc/core';
import { describe, expect, it } from 'vitest';
import {
  PaperAccount,
  computeFee,
  verifyLedger,
  type EngineChanges,
  type Instrument,
  type MarketSnapshot,
  type TransactionState,
} from '../src';

const T0 = new Date('2026-03-01T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const BTC: Instrument = { venue: 'binance', symbol: 'BTCUSDT', kind: 'SPOT', feeModel: { type: 'bps', makerBps: 2, takerBps: 10 } };
const BTC_PERP: Instrument = { venue: 'binance-futures', symbol: 'BTCUSDT-PERP', kind: 'PERP', feeModel: { type: 'bps', makerBps: 2, takerBps: 5 } };
const YES: Instrument = { venue: 'polymarket', symbol: 'TOKEN-YES', kind: 'OUTCOME', feeModel: { type: 'polymarket', rate: 0.07 }, tickSize: '0.01' };
const FREE: Instrument = { venue: 'x', symbol: 'FREE', kind: 'SPOT', feeModel: { type: 'none' } };

const quote = (bid: number, ask: number, ts: Date, extra: Partial<MarketSnapshot> = {}): MarketSnapshot => ({ ts, bid, ask, assumeInfiniteDepth: true, ...extra });
const noSlip = { slippage: { fixedBps: 0, impactBpsPer10k: 0 } };

let idc = 0;
const ids = () => `id-${++idc}`;

/** Collect every transaction an account ever produced, for ledger checks. */
function tracked(account: PaperAccount, initial: EngineChanges) {
  const ledger: TransactionState[] = [...initial.transactions];
  return {
    account,
    ledger,
    track(c: EngineChanges) {
      ledger.push(...c.transactions);
      return c;
    },
  };
}

function open(capital: number | string = 10_000, opts = {}) {
  const { account, changes } = PaperAccount.open({ startingCapital: capital, ts: T0 }, { idGen: ids, ...noSlip, ...opts });
  return tracked(account, changes);
}

/**
 * equity == contributed + realised + unrealised − fees + funding + operating.
 * Exact for round numbers; within 1e-6 USD when average prices are rounded
 * quotients (the persisted scale is 10 decimals).
 */
function expectIdentity(a: PaperAccount) {
  const s = a.snapshot();
  const rhs = s.startingCapital.plus(s.realizedPnl).plus(s.unrealizedPnl).minus(s.feesPaid).plus(s.fundingPnl).plus(s.operatingPnl);
  expect(s.equity.minus(rhs).abs().lte('0.000001'), `${s.equity.toString()} vs ${rhs.toString()}`).toBe(true);
}

describe('fees', () => {
  it('computes bps fees on notional', () => {
    expect(computeFee({ type: 'bps', makerBps: 2, takerBps: 10 }, 'TAKER', 2, 50_000).toString()).toBe('100');
    expect(computeFee({ type: 'bps', makerBps: 2, takerBps: 10 }, 'MAKER', 2, 50_000).toString()).toBe('20');
  });
  it('computes the Polymarket p(1-p) taker fee and charges makers nothing', () => {
    expect(computeFee({ type: 'polymarket', rate: 0.07 }, 'TAKER', 100, '0.5').toString()).toBe('1.75');
    expect(computeFee({ type: 'polymarket', rate: 0.07 }, 'TAKER', 100, '0.9').toString()).toBe('0.63');
    expect(computeFee({ type: 'polymarket', rate: 0.07 }, 'MAKER', 100, '0.5').toString()).toBe('0');
    expect(() => computeFee({ type: 'polymarket', rate: 0.07 }, 'TAKER', 1, 1.2)).toThrow(RangeError);
  });
  it('never charges for zero quantity and rejects rebates', () => {
    expect(computeFee({ type: 'bps', makerBps: 1, takerBps: 1 }, 'TAKER', 0, 10).toString()).toBe('0');
    expect(() => computeFee({ type: 'bps', makerBps: -1, takerBps: 1 }, 'MAKER', 1, 10)).toThrow(RangeError);
  });
});

describe('opening and cash movements', () => {
  it('records the initial capital as a deposit', () => {
    const t = open(1000);
    const s = t.account.snapshot();
    expect(s.cash.toString()).toBe('1000');
    expect(s.equity.toString()).toBe('1000');
    expect(t.ledger).toHaveLength(1);
    expect(t.ledger[0]!.type).toBe('DEPOSIT');
    expect(verifyLedger(t.ledger, s.cash).ok).toBe(true);
  });

  it('rejects withdrawals beyond available cash', () => {
    const t = open(100);
    expect(() => t.account.withdraw(101, at(1))).toThrow(RangeError);
    t.track(t.account.withdraw(40, at(1)));
    expect(t.account.snapshot().cash.toString()).toBe('60');
    expect(verifyLedger(t.ledger, t.account.snapshot().cash).ok).toBe(true);
  });

  it('records operating revenue and costs for business paper tests', () => {
    const t = open(1000);
    t.track(t.account.recordOperating('REVENUE', 250, at(1), { category: 'subscriptions' }));
    t.track(t.account.recordOperating('COST', 80, at(1), { category: 'api', isApiCost: true }));
    t.track(t.account.recordOperating('COST', 20, at(1), { category: 'hosting' }));
    const s = t.account.snapshot();
    expect(s.cash.toString()).toBe('1150');
    expect(s.operatingPnl.toString()).toBe('150');
    expect(s.spendTotal.toString()).toBe('100');
    expect(s.apiSpendTotal.toString()).toBe('80');
    expectIdentity(t.account);
    expect(verifyLedger(t.ledger, s.cash).ok).toBe(true);
  });
});

describe('spot trading', () => {
  it('buys at the ask plus slippage and charges the taker fee', () => {
    const t = open(10_000, { slippage: { fixedBps: 10, impactBpsPer10k: 0 } });
    const r = t.account.submitOrder({ clientOrderId: 'c1', instrument: BTC, side: 'BUY', type: 'MARKET', quantity: '0.1' }, quote(49_990, 50_000, at(1)));
    t.track(r.changes);
    expect(r.order.status).toBe('FILLED');
    // 50 000 × 1.001 = 50 050
    expect(r.order.avgFillPrice!.toString()).toBe('50050');
    const fill = r.changes.fills[0]!;
    expect(fill.fee.toString()).toBe('5.005'); // 5005 × 10 bps
    expect(fill.slippageCost.toString()).toBe('5'); // (50050 − 50000) × 0.1
    const s = t.account.snapshot();
    expect(s.cash.toString()).toBe(d(10_000).minus(5005).minus('5.005').toString());
    expect(verifyLedger(t.ledger, s.cash).ok).toBe(true);
    expectIdentity(t.account);
  });

  it('realises exact P&L on a round trip', () => {
    const t = open(10_000);
    t.track(t.account.submitOrder({ clientOrderId: 'b', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 10 }, quote(99, 100, at(1))).changes);
    t.track(t.account.submitOrder({ clientOrderId: 's', instrument: FREE, side: 'SELL', type: 'MARKET', quantity: 10 }, quote(110, 111, at(2))).changes);
    const s = t.account.snapshot();
    expect(s.realizedPnl.toString()).toBe('100');
    expect(s.cash.toString()).toBe('10100');
    expect(s.openPositions).toBe(0);
    expect(t.account.positions()).toHaveLength(0);
    expectIdentity(t.account);
  });

  it('averages the entry price and keeps it on partial closes', () => {
    const t = open(10_000);
    t.account.submitOrder({ clientOrderId: 'b1', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(99, 100, at(1)));
    t.account.submitOrder({ clientOrderId: 'b2', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 3 }, quote(119, 120, at(2)));
    expect(t.account.position('x', 'FREE')!.avgPrice.toString()).toBe('115');
    t.account.submitOrder({ clientOrderId: 's1', instrument: FREE, side: 'SELL', type: 'MARKET', quantity: 2 }, quote(130, 131, at(3)));
    const p = t.account.position('x', 'FREE')!;
    expect(p.quantity.toString()).toBe('2');
    expect(p.avgPrice.toString()).toBe('115');
    expect(t.account.snapshot().realizedPnl.toString()).toBe('30');
    expectIdentity(t.account);
  });

  it('walks the book, measures slippage against the touch and cancels the unfilled remainder', () => {
    const t = open(100_000);
    const market: MarketSnapshot = {
      ts: at(1),
      asks: [
        { price: 100, size: 1 },
        { price: 101, size: 2 },
        { price: 105, size: 1 },
      ],
      bids: [{ price: 99, size: 5 }],
    };
    const r = t.account.submitOrder({ clientOrderId: 'w', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 5 }, market);
    t.track(r.changes);
    expect(r.order.status).toBe('CANCELLED');
    expect(r.order.filledQuantity.toString()).toBe('4');
    expect(r.order.rejectReason).toMatch(/remainder 1 cancelled/);
    expect(r.order.avgFillPrice!.toString()).toBe('101.75'); // (100 + 202 + 105) / 4
    const slip = r.changes.fills.reduce((a, f) => a.plus(f.slippageCost), new Decimal(0));
    expect(slip.toString()).toBe('7'); // 0 + 2×1 + 1×5
    expect(verifyLedger(t.ledger, t.account.snapshot().cash).ok).toBe(true);
  });

  it('never fills through a limit when walking the book', () => {
    const t = open(100_000);
    const market: MarketSnapshot = { ts: at(1), asks: [{ price: 100, size: 1 }, { price: 102, size: 5 }], bids: [{ price: 99, size: 1 }] };
    const r = t.account.submitOrder({ clientOrderId: 'l', instrument: FREE, side: 'BUY', type: 'LIMIT', quantity: 3, limitPrice: 101 }, market);
    expect(r.order.filledQuantity.toString()).toBe('1');
    expect(r.order.status).toBe('PARTIALLY_FILLED');
    expect(r.changes.fills.every((f) => f.price.lte(101))).toBe(true);
    // The resting remainder reserves cash: 2 × 101 (no-fee instrument)
    expect(t.account.snapshot().reservedCash.toString()).toBe('202');
  });

  it('rejects a market order when the opposite side is empty', () => {
    const t = open(1000);
    const r = t.account.submitOrder({ clientOrderId: 'x', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, { ts: at(1), bid: 10 });
    expect(r.order.status).toBe('REJECTED');
    expect(r.changes.transactions).toHaveLength(0);
  });

  it('rejects buys it cannot pay for, without touching the ledger', () => {
    const t = open(1000);
    const r = t.account.submitOrder({ clientOrderId: 'big', instrument: BTC, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(49_990, 50_000, at(1)));
    expect(r.order.status).toBe('REJECTED');
    expect(r.order.rejectReason).toMatch(/insufficient cash/);
    expect(r.changes.transactions).toHaveLength(0);
    expect(t.account.snapshot().cash.toString()).toBe('1000');
  });

  it('does not allow short selling spot', () => {
    const t = open(1000);
    const r = t.account.submitOrder({ clientOrderId: 's', instrument: FREE, side: 'SELL', type: 'MARKET', quantity: 1 }, quote(10, 11, at(1)));
    expect(r.order.status).toBe('REJECTED');
    expect(r.order.rejectReason).toMatch(/short selling is not allowed/);
  });

  it('treats a repeated clientOrderId as the same order (idempotent)', () => {
    const t = open(1000);
    const first = t.account.submitOrder({ clientOrderId: 'dup', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(9, 10, at(1)));
    const second = t.account.submitOrder({ clientOrderId: 'dup', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(9, 10, at(1)));
    expect(second.duplicate).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(second.changes.fills).toHaveLength(0);
    expect(t.account.position('x', 'FREE')!.quantity.toString()).toBe('1');
    expect(t.account.snapshot().ordersToday).toBe(1);
  });

  it('validates quantity, limit price, tick size and minimum size', () => {
    const t = open(1000);
    const m = quote(0.4, 0.42, at(1));
    const bad = [
      { clientOrderId: 'q0', instrument: YES, side: 'BUY' as const, type: 'LIMIT' as const, quantity: 0, limitPrice: '0.40' },
      { clientOrderId: 'qn', instrument: YES, side: 'BUY' as const, type: 'LIMIT' as const, quantity: 'abc', limitPrice: '0.40' },
      { clientOrderId: 'nl', instrument: YES, side: 'BUY' as const, type: 'LIMIT' as const, quantity: 1 },
      { clientOrderId: 'tk', instrument: YES, side: 'BUY' as const, type: 'LIMIT' as const, quantity: 1, limitPrice: '0.405' },
      { clientOrderId: 'p1', instrument: YES, side: 'BUY' as const, type: 'LIMIT' as const, quantity: 1, limitPrice: '1' },
      { clientOrderId: 'mn', instrument: { ...FREE, minQuantity: '5' }, side: 'BUY' as const, type: 'MARKET' as const, quantity: 1 },
      { clientOrderId: 'po', instrument: FREE, side: 'BUY' as const, type: 'MARKET' as const, quantity: 1, postOnly: true },
    ];
    for (const req of bad) {
      const r = t.account.submitOrder(req, m);
      expect(r.order.status, req.clientOrderId).toBe('REJECTED');
    }
    expect(t.account.snapshot().cash.toString()).toBe('1000');
  });
});

describe('resting limit orders', () => {
  it('reserves cash so a second order cannot spend it', () => {
    const t = open(1000);
    const r1 = t.account.submitOrder({ clientOrderId: 'l1', instrument: FREE, side: 'BUY', type: 'LIMIT', quantity: 9, limitPrice: 100 }, quote(100, 101, at(1)));
    expect(r1.order.status).toBe('OPEN');
    expect(t.account.snapshot().availableCash.toString()).toBe('100');
    const r2 = t.account.submitOrder({ clientOrderId: 'l2', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(100, 101, at(1)));
    expect(r2.order.status).toBe('REJECTED');
  });

  it('fills only when the market trades through the limit (conservative default)', () => {
    const t = open(1000);
    const r = t.account.submitOrder({ clientOrderId: 'l', instrument: BTC, side: 'BUY', type: 'LIMIT', quantity: '0.01', limitPrice: 50_000 }, quote(50_000, 50_010, at(1)));
    t.track(r.changes);
    // touched but not through: no fill
    expect(t.track(t.account.onMarket('binance', 'BTCUSDT', quote(49_990, 50_000, at(2)))).fills).toHaveLength(0);
    const c = t.track(t.account.onMarket('binance', 'BTCUSDT', quote(49_980, 49_990, at(3))));
    expect(c.fills).toHaveLength(1);
    expect(c.fills[0]!.liquidity).toBe('MAKER');
    expect(c.fills[0]!.price.toString()).toBe('50000'); // our limit, not the better market price
    expect(c.fills[0]!.fee.toString()).toBe('0.1'); // 500 × 2 bps
    expect(t.account.snapshot().reservedCash.toString()).toBe('0');
    expect(verifyLedger(t.ledger, t.account.snapshot().cash).ok).toBe(true);
    expectIdentity(t.account);
  });

  it('fills on touch when configured', () => {
    const t = open(1000, { restingFillModel: 'touch' });
    t.account.submitOrder({ clientOrderId: 'l', instrument: FREE, side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 100 }, quote(100, 101, at(1)));
    expect(t.account.onMarket('x', 'FREE', quote(99, 100, at(2))).fills).toHaveLength(1);
  });

  it('rejects post-only orders that would cross', () => {
    const t = open(1000);
    const r = t.account.submitOrder({ clientOrderId: 'p', instrument: FREE, side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 101, postOnly: true }, quote(100, 101, at(1)));
    expect(r.order.status).toBe('REJECTED');
    expect(r.order.rejectReason).toMatch(/post-only/);
  });

  it('releases the reservation on cancel', () => {
    const t = open(1000);
    const r = t.account.submitOrder({ clientOrderId: 'l', instrument: FREE, side: 'BUY', type: 'LIMIT', quantity: 5, limitPrice: 100 }, quote(100, 101, at(1)));
    expect(t.account.snapshot().reservedCash.toString()).toBe('500');
    t.account.cancelOrder(r.order.id, at(2));
    expect(t.account.snapshot().reservedCash.toString()).toBe('0');
    expect(t.account.openOrders()).toHaveLength(0);
  });

  it('reserves holdings for resting sells so they cannot be sold twice', () => {
    const t = open(1000);
    t.account.submitOrder({ clientOrderId: 'b', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 2 }, quote(99, 100, at(1)));
    t.account.submitOrder({ clientOrderId: 's1', instrument: FREE, side: 'SELL', type: 'LIMIT', quantity: 2, limitPrice: 120 }, quote(99, 100, at(1)));
    const r = t.account.submitOrder({ clientOrderId: 's2', instrument: FREE, side: 'SELL', type: 'MARKET', quantity: 1 }, quote(99, 100, at(1)));
    expect(r.order.status).toBe('REJECTED');
  });
});

describe('perpetuals', () => {
  it('shorts with full collateral, earns on a falling price and realises into cash', () => {
    const t = open(10_000);
    const r = t.account.submitOrder({ clientOrderId: 's', instrument: BTC_PERP, side: 'SELL', type: 'MARKET', quantity: '0.1' }, quote(50_000, 50_010, at(1)));
    t.track(r.changes);
    expect(r.order.status).toBe('FILLED');
    // No notional moved, only the fee: 5000 × 5 bps = 2.5
    expect(t.account.snapshot().cash.toString()).toBe('9997.5');
    t.track(t.account.mark('binance-futures', 'BTCUSDT-PERP', 48_000, at(2)));
    const mid = t.account.snapshot();
    expect(mid.unrealizedPnl.toString()).toBe('200');
    expect(mid.equity.toString()).toBe('10197.5');
    t.track(t.account.submitOrder({ clientOrderId: 'c', instrument: BTC_PERP, side: 'BUY', type: 'MARKET', quantity: '0.1' }, quote(47_990, 48_000, at(3))).changes);
    const s = t.account.snapshot();
    expect(s.realizedPnl.toString()).toBe('200');
    expect(s.feesPaid.toString()).toBe('4.9'); // 2.5 + 4800 × 5 bps
    expect(s.cash.toString()).toBe('10195.1');
    expect(t.ledger.some((x) => x.type === 'REALIZED_PNL')).toBe(true);
    expect(verifyLedger(t.ledger, s.cash).ok).toBe(true);
    expectIdentity(t.account);
  });

  it('flips from long to short at the fill price', () => {
    const t = open(100_000);
    const perp = { ...BTC_PERP, feeModel: { type: 'none' as const } };
    t.account.submitOrder({ clientOrderId: 'l', instrument: perp, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(99, 100, at(1)));
    t.account.submitOrder({ clientOrderId: 'f', instrument: perp, side: 'SELL', type: 'MARKET', quantity: 3 }, quote(110, 111, at(2)));
    const p = t.account.position(perp.venue, perp.symbol)!;
    expect(p.quantity.toString()).toBe('-2');
    expect(p.avgPrice.toString()).toBe('110');
    expect(t.account.snapshot().realizedPnl.toString()).toBe('10');
    expectIdentity(t.account);
  });

  it('pays funding with the right sign', () => {
    const t = open(100_000);
    const perp = { ...BTC_PERP, feeModel: { type: 'none' as const } };
    t.account.submitOrder({ clientOrderId: 's', instrument: perp, side: 'SELL', type: 'MARKET', quantity: 2 }, quote(100, 101, at(1)));
    // positive rate: longs pay shorts, we are short → we receive 2 × 100 × 0.0001 = 0.02
    t.track(t.account.applyFunding(perp.venue, perp.symbol, 0.0001, 100, at(2)));
    expect(t.account.snapshot().fundingPnl.toString()).toBe('0.02');
    t.track(t.account.applyFunding(perp.venue, perp.symbol, -0.0003, 100, at(3)));
    expect(t.account.snapshot().fundingPnl.toString()).toBe('-0.04');
    expectIdentity(t.account);
  });

  it('refuses positions beyond the available collateral', () => {
    const t = open(1000);
    const r = t.account.submitOrder({ clientOrderId: 's', instrument: BTC_PERP, side: 'SELL', type: 'MARKET', quantity: 1 }, quote(50_000, 50_010, at(1)));
    expect(r.order.status).toBe('REJECTED');
    expect(r.order.rejectReason).toMatch(/insufficient margin/);
  });

  it('enforces reduce-only', () => {
    const t = open(100_000);
    const r = t.account.submitOrder({ clientOrderId: 'ro', instrument: BTC_PERP, side: 'BUY', type: 'MARKET', quantity: 1, reduceOnly: true }, quote(100, 101, at(1)));
    expect(r.order.status).toBe('REJECTED');
  });
});

describe('prediction-market outcomes', () => {
  it('charges the taker fee, then settles a winning position at 1', () => {
    const t = open(1000);
    const r = t.account.submitOrder({ clientOrderId: 'y', instrument: YES, side: 'BUY', type: 'MARKET', quantity: 100 }, quote(0.49, 0.5, at(1)));
    t.track(r.changes);
    expect(r.changes.fills[0]!.fee.toString()).toBe('1.75');
    expect(t.account.snapshot().cash.toString()).toBe('948.25');
    t.track(t.account.settleOutcome('polymarket', 'TOKEN-YES', 1, at(10)));
    const s = t.account.snapshot();
    expect(s.cash.toString()).toBe('1048.25');
    expect(s.realizedPnl.toString()).toBe('50');
    expect(s.openPositions).toBe(0);
    expect(verifyLedger(t.ledger, s.cash).ok).toBe(true);
    expectIdentity(t.account);
  });

  it('loses the whole stake when the outcome resolves to 0', () => {
    const t = open(1000);
    t.track(t.account.submitOrder({ clientOrderId: 'y', instrument: YES, side: 'BUY', type: 'MARKET', quantity: 100 }, quote(0.49, 0.5, at(1))).changes);
    t.track(t.account.settleOutcome('polymarket', 'TOKEN-YES', 0, at(10)));
    const s = t.account.snapshot();
    expect(s.realizedPnl.toString()).toBe('-50');
    expect(s.equity.toString()).toBe('948.25');
    expectIdentity(t.account);
  });

  it('cancels resting orders on resolution and rejects invalid payouts', () => {
    const t = open(1000);
    t.account.submitOrder({ clientOrderId: 'r', instrument: YES, side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice: '0.3' }, quote(0.4, 0.42, at(1)));
    t.account.settleOutcome('polymarket', 'TOKEN-YES', 0, at(2));
    expect(t.account.openOrders()).toHaveLength(0);
    expect(t.account.snapshot().reservedCash.toString()).toBe('0');
    expect(() => t.account.settleOutcome('polymarket', 'TOKEN-YES', 2, at(3))).toThrow(RangeError);
  });
});

describe('days, peaks and hooks', () => {
  it('rolls the trading day at UTC midnight', () => {
    const t = open(1000);
    t.account.submitOrder({ clientOrderId: 'a', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(99, 100, new Date('2026-03-01T23:59:00Z')));
    t.account.mark('x', 'FREE', 90, new Date('2026-03-01T23:59:30Z'));
    expect(t.account.snapshot().ordersToday).toBe(1);
    expect(t.account.snapshot().dayPnl.toString()).toBe('-10');
    t.account.mark('x', 'FREE', 95, new Date('2026-03-02T00:00:01Z'));
    const s = t.account.snapshot();
    expect(s.dayKey).toBe('2026-03-02');
    expect(s.ordersToday).toBe(0);
    // day starts from the equity before the first event of the new day (990)
    expect(s.dayStartEquity.toString()).toBe('990');
    expect(s.dayPnl.toString()).toBe('5');
  });

  it('tracks peak equity and drawdown', () => {
    const t = open(1000);
    t.account.submitOrder({ clientOrderId: 'a', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 10 }, quote(99, 100, at(1)));
    t.account.mark('x', 'FREE', 120, at(2));
    expect(t.account.snapshot().peakEquity.toString()).toBe('1200');
    t.account.mark('x', 'FREE', 90, at(3));
    const s = t.account.snapshot();
    expect(s.equity.toString()).toBe('900');
    expect(s.drawdownPct).toBeCloseTo(0.25, 12);
  });

  it('lets pre-trade hooks veto orders', () => {
    const { account } = PaperAccount.open(
      { startingCapital: 1000, ts: T0 },
      { ...noSlip, preTradeHooks: [({ estimatedNotional }) => (estimatedNotional.gt(50) ? ['max order notional 50'] : [])] },
    );
    const r = account.submitOrder({ clientOrderId: 'a', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(99, 100, at(1)));
    expect(r.order.status).toBe('REJECTED');
    expect(r.order.rejectReason).toBe('risk: max order notional 50');
    const ok = account.submitOrder({ clientOrderId: 'b', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: '0.4' }, quote(99, 100, at(1)));
    expect(ok.order.status).toBe('FILLED');
  });

  it('frozen accounts reject orders', () => {
    const t = open(1000);
    t.account.freeze();
    const r = t.account.submitOrder({ clientOrderId: 'a', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, quote(99, 100, at(1)));
    expect(r.order.rejectReason).toMatch(/FROZEN/);
    t.account.unfreeze();
    expect(t.account.getStatus()).toBe('ACTIVE');
  });
});

describe('persistence round trip', () => {
  it('restores an identical account that continues identically', () => {
    const t = open(5000);
    t.account.submitOrder({ clientOrderId: 'a', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 3 }, quote(99, 100, at(1)));
    t.account.submitOrder({ clientOrderId: 'b', instrument: FREE, side: 'BUY', type: 'LIMIT', quantity: 2, limitPrice: 95 }, quote(99, 100, at(1)));
    t.account.mark('x', 'FREE', 97, at(2));
    const state = JSON.parse(JSON.stringify(t.account.exportState()));
    const restored = PaperAccount.restore(
      {
        ...state,
        positions: state.positions.map((p: Record<string, unknown>) => ({ ...p, quantity: d(p.quantity as string), avgPrice: d(p.avgPrice as string), realizedPnl: d(p.realizedPnl as string), markPrice: p.markPrice === null ? null : d(p.markPrice as string), openedAt: new Date(p.openedAt as string), updatedAt: new Date(p.updatedAt as string) })),
        openOrders: state.openOrders.map((o: Record<string, unknown>) => ({ ...o, quantity: d(o.quantity as string), limitPrice: o.limitPrice === null ? null : d(o.limitPrice as string), filledQuantity: d(o.filledQuantity as string), avgFillPrice: o.avgFillPrice === null ? null : d(o.avgFillPrice as string), reserved: d(o.reserved as string), createdAt: new Date(o.createdAt as string), updatedAt: new Date(o.updatedAt as string) })),
      },
      noSlip,
    );
    expect(restored.snapshot().equity.toString()).toBe(t.account.snapshot().equity.toString());
    expect(restored.snapshot().reservedCash.toString()).toBe('190');
    const m = quote(93, 94, at(3));
    const c1 = t.account.onMarket('x', 'FREE', m);
    const c2 = restored.onMarket('x', 'FREE', m);
    expect(c2.fills.map((f) => f.price.toString())).toEqual(c1.fills.map((f) => f.price.toString()));
    expect(restored.snapshot().equity.toString()).toBe(t.account.snapshot().equity.toString());
    // duplicate protection survives the round trip for open orders
    expect(restored.submitOrder({ clientOrderId: 'b', instrument: FREE, side: 'BUY', type: 'MARKET', quantity: 1 }, m).duplicate).toBe(true);
  });
});

describe('randomised accounting invariants', () => {
  const instruments: Instrument[] = [
    { venue: 'v', symbol: 'A', kind: 'SPOT', feeModel: { type: 'bps', makerBps: 1, takerBps: 7 } },
    { venue: 'v', symbol: 'P', kind: 'PERP', feeModel: { type: 'bps', makerBps: 1, takerBps: 4 } },
    { venue: 'pm', symbol: 'O', kind: 'OUTCOME', feeModel: { type: 'polymarket', rate: 0.07 } },
  ];

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`holds the ledger and equity identities over 400 random operations (seed ${seed})`, () => {
      const rng = new Rng(`paper-invariants-${seed}`);
      const { account, changes } = PaperAccount.open({ startingCapital: 50_000, ts: T0 }, { slippage: { fixedBps: 3, impactBpsPer10k: 2 } });
      const ledger: TransactionState[] = [...changes.transactions];
      const prices: Record<string, number> = { A: 100, P: 100, O: 0.5 };
      const fillSides = { BUY: 0, SELL: 0 };
      let t = 0;
      for (let i = 0; i < 400; i++) {
        t += rng.int(1, 240);
        const ts = new Date(T0.getTime() + t * 60_000);
        const inst = rng.choice(instruments);
        const sym = inst.symbol;
        if (sym === 'O') prices.O = Math.min(0.97, Math.max(0.03, Math.round((prices.O! + rng.normal(0, 0.03)) * 100) / 100));
        else prices[sym] = Math.max(1, prices[sym]! * Math.exp(rng.normal(0, 0.01)));
        const mid = prices[sym]!;
        const spread = sym === 'O' ? 0.01 : mid * 0.0005;
        const m: MarketSnapshot = { ts, bid: mid - spread / 2, ask: mid + spread / 2, bidSize: rng.uniform(1, 50), askSize: rng.uniform(1, 50) };
        const op = rng.next();
        let c: EngineChanges;
        if (op < 0.45) {
          const side = rng.bernoulli(0.5) ? 'BUY' : 'SELL';
          const qty = sym === 'O' ? rng.int(1, 200) : Math.round(rng.uniform(0.1, 10) * 1000) / 1000;
          const type = rng.bernoulli(0.7) ? 'MARKET' : 'LIMIT';
          const limit = type === 'LIMIT' ? (sym === 'O' ? Math.round((mid + (side === 'BUY' ? -0.01 : 0.01)) * 100) / 100 : mid * (side === 'BUY' ? 0.999 : 1.001)) : undefined;
          c = account.submitOrder({ clientOrderId: `o${i}`, instrument: inst, side, type, quantity: qty, limitPrice: limit }, m).changes;
        } else if (op < 0.8) {
          c = account.onMarket(inst.venue, sym, m);
        } else if (op < 0.88 && sym === 'P') {
          c = account.applyFunding('v', 'P', rng.normal(0, 0.0002), mid, ts);
        } else if (op < 0.9 && sym === 'O') {
          c = account.settleOutcome('pm', 'O', rng.bernoulli(0.5) ? 1 : 0, ts);
        } else if (op < 0.95) {
          const open = account.openOrders();
          c = open.length > 0 ? account.cancelOrder(rng.choice(open).id, ts) : account.mark(inst.venue, sym, mid, ts);
        } else {
          c = account.mark(inst.venue, sym, mid, ts);
        }
        ledger.push(...c.transactions);
        for (const f of c.fills) fillSides[f.side]++;

        const s = account.snapshot();
        const check = verifyLedger(ledger, s.cash);
        expect(check.problems).toEqual([]);
        expectIdentity(account);
        expect(s.reservedCash.gte(0)).toBe(true);
        for (const p of account.positions()) {
          if (p.kind !== 'PERP') expect(p.quantity.gte(0), `${p.symbol} went short`).toBe(true);
        }
        // Spot/outcome-only cash can never go negative (perps only move fees and realised P&L).
        expect(s.equity.gt(0)).toBe(true);
      }
      // The random walk must actually exercise both sides, or the test proves nothing.
      expect(fillSides.BUY).toBeGreaterThan(20);
      expect(fillSides.SELL).toBeGreaterThan(20);
    });
  }
});

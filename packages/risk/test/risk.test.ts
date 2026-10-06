import { Decimal, ManualClock, defaultRiskLimits, d, type RiskLimits, ValidationError } from '@aoc/core';
import { PaperAccount, type Instrument } from '@aoc/paper-engine';
import { describe, expect, it } from 'vitest';
import {
  breaches,
  createPreTradeHook,
  decideAllocation,
  evaluateLimits,
  mustStop,
  orderIncreasesRisk,
  overallRiskStatus,
  preTradeViolations,
  validateRiskLimits,
  type PreTradeInput,
  type RiskContext,
} from '../src';

const limits: RiskLimits = {
  maxCapital: 1000,
  maxDailyLoss: 50,
  maxDrawdownPct: 0.1,
  maxExposure: 800,
  maxPositions: 2,
  maxOrdersPerDay: 5,
  maxOrderNotional: 300,
  maxApiSpend: 20,
  maxExperimentSpend: 100,
};
const ctx: RiskContext = { limits, emergencyStop: false, experimentStatus: 'PAPER' };

const account = (over: Partial<PreTradeInput['account']> = {}): PreTradeInput['account'] => ({
  equity: d(1000),
  exposure: d(0),
  openPositions: 0,
  ordersToday: 1,
  dayPnl: d(0),
  drawdownPct: 0,
  spendTotal: d(0),
  apiSpendTotal: d(0),
  startingCapital: d(1000),
  ...over,
});

const order = (over: Partial<PreTradeInput> = {}): PreTradeInput => ({
  account: account(),
  positionQuantity: d(0),
  side: 'BUY',
  quantity: d(1),
  estimatedNotional: d(100),
  estimatedFee: d(0.1),
  ...over,
});

describe('limit validation', () => {
  it('accepts sensible limits and the defaults', () => {
    expect(validateRiskLimits(limits)).toEqual(limits);
    expect(() => validateRiskLimits(defaultRiskLimits(1000))).not.toThrow();
  });
  it('rejects missing, negative, non-integer or inconsistent limits', () => {
    expect(() => validateRiskLimits({ ...limits, maxDailyLoss: undefined })).toThrow(ValidationError);
    expect(() => validateRiskLimits({ ...limits, maxExposure: -1 })).toThrow(ValidationError);
    expect(() => validateRiskLimits({ ...limits, maxDrawdownPct: 0 })).toThrow(ValidationError);
    expect(() => validateRiskLimits({ ...limits, maxDrawdownPct: 1.5 })).toThrow(ValidationError);
    expect(() => validateRiskLimits({ ...limits, maxPositions: 2.5 })).toThrow(ValidationError);
    expect(() => validateRiskLimits({ ...limits, maxDailyLoss: 2000 })).toThrow(ValidationError);
    expect(() => validateRiskLimits({ ...limits, maxCapital: Number.NaN })).toThrow(ValidationError);
    expect(() => validateRiskLimits(null)).toThrow(ValidationError);
  });
});

describe('orderIncreasesRisk', () => {
  it('classifies opening, adding, reducing, closing and flipping', () => {
    expect(orderIncreasesRisk(d(0), 'BUY', d(1))).toBe(true);
    expect(orderIncreasesRisk(d(5), 'BUY', d(1))).toBe(true);
    expect(orderIncreasesRisk(d(5), 'SELL', d(3))).toBe(false);
    expect(orderIncreasesRisk(d(5), 'SELL', d(5))).toBe(false);
    expect(orderIncreasesRisk(d(5), 'SELL', d(8))).toBe(true);
    expect(orderIncreasesRisk(d(-5), 'BUY', d(2))).toBe(false);
    expect(orderIncreasesRisk(d(-5), 'SELL', d(2))).toBe(true);
  });
});

describe('pre-trade checks at the boundaries', () => {
  it('allows an order inside every limit', () => {
    expect(preTradeViolations(ctx, order())).toEqual([]);
  });

  it('order size: equal passes, above fails', () => {
    expect(preTradeViolations(ctx, order({ estimatedNotional: d(300) }))).toEqual([]);
    expect(preTradeViolations(ctx, order({ estimatedNotional: d('300.01') })).join()).toMatch(/max order size/);
  });

  it('exposure: equal passes, above fails', () => {
    expect(preTradeViolations(ctx, order({ account: account({ exposure: d(500) }), estimatedNotional: d(300) }))).toEqual([]);
    expect(preTradeViolations(ctx, order({ account: account({ exposure: d(501) }), estimatedNotional: d(300) })).join()).toMatch(/max exposure/);
  });

  it('positions: opening a third position fails, adding to an existing one does not', () => {
    expect(preTradeViolations(ctx, order({ account: account({ openPositions: 1 }) }))).toEqual([]);
    expect(preTradeViolations(ctx, order({ account: account({ openPositions: 2 }) })).join()).toMatch(/max open positions/);
    expect(preTradeViolations(ctx, order({ account: account({ openPositions: 2 }), positionQuantity: d(1) }))).toEqual([]);
  });

  it('orders per day: the 5th passes, the 6th fails (engine counts before the hook)', () => {
    expect(preTradeViolations(ctx, order({ account: account({ ordersToday: 5 }) }))).toEqual([]);
    expect(preTradeViolations(ctx, order({ account: account({ ordersToday: 6 }) })).join()).toMatch(/max orders per day/);
  });

  it('daily loss: just inside passes, at the limit blocks new risk', () => {
    expect(preTradeViolations(ctx, order({ account: account({ dayPnl: d('-49.99') }) }))).toEqual([]);
    expect(preTradeViolations(ctx, order({ account: account({ dayPnl: d(-50) }) })).join()).toMatch(/daily loss/);
  });

  it('drawdown: at the limit blocks new risk', () => {
    expect(preTradeViolations(ctx, order({ account: account({ drawdownPct: 0.0999 }) }))).toEqual([]);
    expect(preTradeViolations(ctx, order({ account: account({ drawdownPct: 0.1 }) })).join()).toMatch(/drawdown/);
  });

  it('spend limits', () => {
    expect(preTradeViolations(ctx, order({ account: account({ spendTotal: d('99.9') }), estimatedFee: d('0.1') }))).toEqual([]);
    expect(preTradeViolations(ctx, order({ account: account({ spendTotal: d('99.9') }), estimatedFee: d('0.2') })).join()).toMatch(/experiment spend/);
    expect(preTradeViolations(ctx, order({ account: account({ apiSpendTotal: d(20) }) })).join()).toMatch(/API spend/);
  });

  it('always lets a strategy reduce a position, even with every limit breached', () => {
    const breached = account({ dayPnl: d(-500), drawdownPct: 0.9, exposure: d(5000), openPositions: 9, spendTotal: d(1e6) });
    expect(preTradeViolations(ctx, order({ account: breached, positionQuantity: d(3), side: 'SELL', quantity: d(3), estimatedNotional: d(5000) }))).toEqual([]);
  });

  it('emergency stop and non-PAPER status block everything automated, including exits', () => {
    const exit = order({ positionQuantity: d(3), side: 'SELL', quantity: d(1) });
    expect(preTradeViolations({ ...ctx, emergencyStop: true }, exit).join()).toMatch(/emergency stop/);
    expect(preTradeViolations({ ...ctx, experimentStatus: 'PAUSED' }, exit).join()).toMatch(/PAUSED/);
    expect(preTradeViolations({ ...ctx, experimentStatus: null }, exit)).toEqual([]);
  });

  it('manual flatten may only reduce, but works while halted', () => {
    const halted: RiskContext = { ...ctx, emergencyStop: true, experimentStatus: 'PAUSED', purpose: 'MANUAL_FLATTEN' };
    expect(preTradeViolations(halted, order({ positionQuantity: d(3), side: 'SELL', quantity: d(3) }))).toEqual([]);
    expect(preTradeViolations(halted, order({ positionQuantity: d(3), side: 'BUY', quantity: d(1) }))).toEqual(['manual flatten may only reduce positions']);
  });
});

describe('integration with the paper engine', () => {
  const inst: Instrument = { venue: 'v', symbol: 'X', kind: 'SPOT', feeModel: { type: 'none' } };
  const clock = new ManualClock('2026-04-01T12:00:00Z');

  it('rejects the order and reports the violation; the change takes effect immediately', () => {
    let stop = false;
    const seen: string[][] = [];
    const hook = createPreTradeHook(() => ({ limits, emergencyStop: stop, experimentStatus: 'PAPER' }), (v) => seen.push(v));
    const { account: acct } = PaperAccount.open({ startingCapital: 1000, ts: clock.now() }, { preTradeHooks: [hook], slippage: { fixedBps: 0, impactBpsPer10k: 0 } });
    const m = { ts: clock.now(), bid: 99, ask: 100, assumeInfiniteDepth: true };
    expect(acct.submitOrder({ clientOrderId: 'a', instrument: inst, side: 'BUY', type: 'MARKET', quantity: 2 }, m).order.status).toBe('FILLED');
    expect(acct.submitOrder({ clientOrderId: 'b', instrument: inst, side: 'BUY', type: 'MARKET', quantity: 4 }, m).order.rejectReason).toMatch(/max order size/);
    stop = true;
    expect(acct.submitOrder({ clientOrderId: 'c', instrument: inst, side: 'SELL', type: 'MARKET', quantity: 1 }, m).order.rejectReason).toMatch(/emergency stop/);
    expect(seen).toHaveLength(2);
    stop = false;
    expect(acct.submitOrder({ clientOrderId: 'd', instrument: inst, side: 'SELL', type: 'MARKET', quantity: 2 }, m).order.status).toBe('FILLED');
  });

  it('caps orders per day and resets the count on the next UTC day', () => {
    const tight = { ...limits, maxOrdersPerDay: 2, maxOrderNotional: 1000, maxExposure: 1000 };
    const hook = createPreTradeHook(() => ({ limits: tight, emergencyStop: false, experimentStatus: 'PAPER' }));
    const { account: acct } = PaperAccount.open({ startingCapital: 1000, ts: new Date('2026-04-01T22:00:00Z') }, { preTradeHooks: [hook] });
    const m = (iso: string) => ({ ts: new Date(iso), bid: 9, ask: 10, assumeInfiniteDepth: true });
    expect(acct.submitOrder({ clientOrderId: '1', instrument: inst, side: 'BUY', type: 'MARKET', quantity: 1 }, m('2026-04-01T22:00:00Z')).order.status).toBe('FILLED');
    expect(acct.submitOrder({ clientOrderId: '2', instrument: inst, side: 'BUY', type: 'MARKET', quantity: 1 }, m('2026-04-01T22:01:00Z')).order.status).toBe('FILLED');
    expect(acct.submitOrder({ clientOrderId: '3', instrument: inst, side: 'BUY', type: 'MARKET', quantity: 1 }, m('2026-04-01T22:02:00Z')).order.status).toBe('REJECTED');
    expect(acct.submitOrder({ clientOrderId: '4', instrument: inst, side: 'BUY', type: 'MARKET', quantity: 1 }, m('2026-04-02T00:00:01Z')).order.status).toBe('FILLED');
  });
});

describe('monitoring', () => {
  const snap = (over: Partial<PreTradeInput['account']> = {}) => account(over);

  it('reports INFO inside limits, WARNING from 80%, BREACH at the limit', () => {
    const ok = evaluateLimits(limits, snap({ dayPnl: d(-10) }));
    expect(breaches(ok)).toHaveLength(0);
    expect(ok.find((s) => s.limit === 'maxDailyLoss')!.severity).toBe('INFO');
    const warn = evaluateLimits(limits, snap({ dayPnl: d(-40) }));
    expect(warn.find((s) => s.limit === 'maxDailyLoss')!.severity).toBe('WARNING');
    expect(mustStop(warn)).toBe(false);
    const breach = evaluateLimits(limits, snap({ dayPnl: d(-50) }));
    expect(breach.find((s) => s.limit === 'maxDailyLoss')!.severity).toBe('BREACH');
    expect(mustStop(breach)).toBe(true);
  });

  it('stops on drawdown, spend and exhausted equity; only warns on exposure', () => {
    expect(mustStop(evaluateLimits(limits, snap({ drawdownPct: 0.1 })))).toBe(true);
    expect(mustStop(evaluateLimits(limits, snap({ spendTotal: d(100) })))).toBe(true);
    expect(mustStop(evaluateLimits(limits, snap({ apiSpendTotal: d(20) })))).toBe(true);
    expect(mustStop(evaluateLimits(limits, snap({ equity: d(0) })))).toBe(true);
    const exp = evaluateLimits(limits, snap({ exposure: d(900) }));
    expect(exp.find((s) => s.limit === 'maxExposure')!.severity).toBe('WARNING');
    expect(mustStop(exp)).toBe(false);
  });

  it('a profitable day is not a loss', () => {
    expect(evaluateLimits(limits, snap({ dayPnl: d(500) })).find((s) => s.limit === 'maxDailyLoss')!.value).toBe(0);
  });

  it('aggregates the overall status', () => {
    expect(overallRiskStatus([evaluateLimits(limits, snap())], false)).toBe('NORMAL');
    expect(overallRiskStatus([evaluateLimits(limits, snap({ dayPnl: d(-45) }))], false)).toBe('WARNING');
    expect(overallRiskStatus([evaluateLimits(limits, snap({ dayPnl: d(-60) }))], false)).toBe('BREACH');
    expect(overallRiskStatus([], true)).toBe('EMERGENCY_STOP');
  });
});

describe('allocation', () => {
  it('never allocates beyond the paper fund or the experiment cap', () => {
    expect(decideAllocation({ totalPaperCapital: 10_000, allocated: 9000, requested: 1000, experimentMaxCapital: 1000 }).approved).toBe(true);
    const over = decideAllocation({ totalPaperCapital: 10_000, allocated: 9500, requested: 1000, experimentMaxCapital: 1000 });
    expect(over.approved).toBe(false);
    expect(over.amount.toString()).toBe('0');
    expect(over.reasons.join()).toMatch(/unallocated paper fund 500/);
    expect(decideAllocation({ totalPaperCapital: 10_000, allocated: 0, requested: 2000, experimentMaxCapital: 1000 }).approved).toBe(false);
    expect(decideAllocation({ totalPaperCapital: 10_000, allocated: 0, requested: 0, experimentMaxCapital: 1000 }).approved).toBe(false);
    expect(decideAllocation({ totalPaperCapital: 10_000, allocated: 0, requested: new Decimal('1000.5'), experimentMaxCapital: 2000 }).remainingAfter.toString()).toBe('8999.5');
  });
});

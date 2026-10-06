import { Decimal, d, type ExperimentStatus, type RiskLimits } from '@aoc/core';
import type { AccountSnapshot, OrderRequest, PositionState, PreTradeHook } from '@aoc/paper-engine';

export interface RiskContext {
  limits: RiskLimits;
  emergencyStop: boolean;
  /**
   * Status of the experiment the account belongs to. Orders are only allowed
   * while it is PAPER. `null` means a backtest/simulation context where the
   * lifecycle does not apply (the limits still do).
   */
  experimentStatus: ExperimentStatus | null;
  /**
   * STRATEGY: automated orders (default). MANUAL_FLATTEN: a human closing
   * positions; allowed while halted or emergency-stopped, but only for orders
   * that reduce risk.
   */
  purpose?: 'STRATEGY' | 'MANUAL_FLATTEN';
}

export interface PreTradeInput {
  account: Pick<
    AccountSnapshot,
    'equity' | 'exposure' | 'openPositions' | 'ordersToday' | 'dayPnl' | 'drawdownPct' | 'spendTotal' | 'apiSpendTotal' | 'startingCapital'
  >;
  /** Signed current position in the order's instrument (0 if none). */
  positionQuantity: Decimal;
  side: 'BUY' | 'SELL';
  quantity: Decimal;
  estimatedNotional: Decimal;
  estimatedFee: Decimal;
}

/**
 * Does this order add risk? Orders that only shrink an existing position never
 * do, and must stay possible when every limit is breached — otherwise a
 * breached strategy could not get flat.
 */
export function orderIncreasesRisk(positionQuantity: Decimal, side: 'BUY' | 'SELL', quantity: Decimal): boolean {
  if (positionQuantity.isZero()) return true;
  const signed = side === 'BUY' ? quantity : quantity.neg();
  const after = positionQuantity.plus(signed);
  const sameDirection = positionQuantity.isPositive() === signed.isPositive();
  if (sameDirection) return true;
  // Opposite direction: risk increases only if it flips beyond the old size.
  return after.abs().gt(0) && after.isPositive() !== positionQuantity.isPositive();
}

/** Returns human-readable violations; empty means allowed. */
export function preTradeViolations(ctx: RiskContext, input: PreTradeInput): string[] {
  const v: string[] = [];
  const L = ctx.limits;
  const a = input.account;
  const increases = orderIncreasesRisk(input.positionQuantity, input.side, input.quantity);
  if (ctx.purpose === 'MANUAL_FLATTEN') {
    return increases ? ['manual flatten may only reduce positions'] : [];
  }
  if (ctx.emergencyStop) v.push('emergency stop is engaged');
  if (ctx.experimentStatus !== null && ctx.experimentStatus !== 'PAPER') {
    v.push(`experiment is ${ctx.experimentStatus}; paper orders are only allowed in PAPER`);
  }
  // The engine counts this order before calling the hook.
  if (a.ordersToday > L.maxOrdersPerDay) v.push(`max orders per day (${L.maxOrdersPerDay}) reached`);

  if (!increases) return v; // exits are always allowed (subject to the hard stops above)

  if (input.estimatedNotional.gt(L.maxOrderNotional)) {
    v.push(`order notional ${input.estimatedNotional.toFixed(2)} exceeds max order size ${L.maxOrderNotional}`);
  }
  const exposureAfter = a.exposure.plus(input.estimatedNotional);
  if (exposureAfter.gt(L.maxExposure)) v.push(`exposure after order ${exposureAfter.toFixed(2)} exceeds max exposure ${L.maxExposure}`);
  if (exposureAfter.gt(L.maxCapital)) v.push(`exposure after order ${exposureAfter.toFixed(2)} exceeds max capital ${L.maxCapital}`);
  const opensNew = input.positionQuantity.isZero();
  if (opensNew && a.openPositions + 1 > L.maxPositions) v.push(`max open positions (${L.maxPositions}) reached`);
  if (a.dayPnl.lte(d(L.maxDailyLoss).neg())) v.push(`daily loss ${a.dayPnl.toFixed(2)} at or beyond limit −${L.maxDailyLoss}`);
  if (a.drawdownPct >= L.maxDrawdownPct) v.push(`drawdown ${(a.drawdownPct * 100).toFixed(2)}% at or beyond limit ${(L.maxDrawdownPct * 100).toFixed(2)}%`);
  if (a.spendTotal.plus(input.estimatedFee).gt(L.maxExperimentSpend)) v.push(`experiment spend would exceed ${L.maxExperimentSpend}`);
  if (a.apiSpendTotal.gte(L.maxApiSpend) && L.maxApiSpend > 0) v.push(`API spend ${a.apiSpendTotal.toFixed(2)} reached limit ${L.maxApiSpend}`);
  if (a.equity.lte(0)) v.push('account equity is exhausted');
  return v;
}

/**
 * Adapter for the paper engine. `getContext` is read on every order so that
 * an emergency stop or a limit change takes effect immediately.
 */
export function createPreTradeHook(getContext: () => RiskContext, onViolation?: (violations: string[], request: OrderRequest) => void): PreTradeHook {
  return ({ account, request, estimatedNotional, estimatedFee, positions }) => {
    const pos = positions.find((p: PositionState) => p.venue === request.instrument.venue && p.symbol === request.instrument.symbol);
    const violations = preTradeViolations(getContext(), {
      account,
      positionQuantity: pos?.quantity ?? new Decimal(0),
      side: request.side,
      quantity: d(request.quantity),
      estimatedNotional,
      estimatedFee,
    });
    if (violations.length > 0 && onViolation) onViolation(violations, request);
    return violations;
  };
}

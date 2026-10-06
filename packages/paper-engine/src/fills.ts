import { Decimal, d } from '@aoc/core';
import type { BookSide, MarketSnapshot, Side, SlippageModel } from './types';

export interface FillSlice {
  quantity: Decimal;
  price: Decimal;
}

export interface TakerFillResult {
  slices: FillSlice[];
  filledQuantity: Decimal;
  /** Best price on the opposite side at the moment of the order. */
  touchPrice: Decimal | null;
  /** Cost versus executing everything at the touch, >= 0. */
  slippageCost: Decimal;
  /** Why nothing (or not everything) filled. */
  shortfallReason: string | null;
}

export const DEFAULT_SLIPPAGE: SlippageModel = { fixedBps: 2, impactBpsPer10k: 1 };

/**
 * Simulate an aggressive (taker) execution of `quantity` against the market.
 *
 * With a book: walk the opposite side level by level, never past the limit.
 * With only a quote: fill at the touch adjusted by the slippage model, capped
 * at the displayed size unless the snapshot explicitly assumes infinite depth.
 * Never fabricates liquidity: a missing side means no fill.
 */
export function simulateTakerFill(
  side: Side,
  quantity: Decimal,
  limitPrice: Decimal | null,
  market: MarketSnapshot,
  slippage: SlippageModel = DEFAULT_SLIPPAGE,
): TakerFillResult {
  const levels: BookSide[] | undefined = side === 'BUY' ? market.asks : market.bids;
  if (levels && levels.length > 0) return walkBook(side, quantity, limitPrice, levels);

  const touch = side === 'BUY' ? market.ask : market.bid;
  if (touch === undefined || !Number.isFinite(touch) || touch <= 0) {
    return { slices: [], filledQuantity: new Decimal(0), touchPrice: null, slippageCost: new Decimal(0), shortfallReason: 'no liquidity on the opposite side' };
  }
  const touchD = d(touch);
  const displayed = side === 'BUY' ? market.askSize : market.bidSize;
  let fillable = quantity;
  let shortfall: string | null = null;
  if (displayed !== undefined && !market.assumeInfiniteDepth) {
    const cap = d(displayed);
    if (cap.lt(quantity)) {
      fillable = Decimal.max(cap, 0);
      shortfall = `only ${cap.toString()} available at the touch`;
    }
  }
  // A quote without a displayed size fills in full; the impact term of the
  // slippage model is what charges for size in that case.
  if (fillable.lte(0)) {
    return { slices: [], filledQuantity: new Decimal(0), touchPrice: touchD, slippageCost: new Decimal(0), shortfallReason: shortfall };
  }
  const notional = fillable.mul(touchD);
  const bps = d(slippage.fixedBps).plus(d(slippage.impactBpsPer10k).mul(notional).div(10_000));
  const factor = bps.div(10_000);
  let price = side === 'BUY' ? touchD.mul(new Decimal(1).plus(factor)) : touchD.mul(new Decimal(1).minus(factor));
  if (limitPrice !== null) {
    if (side === 'BUY' && touchD.gt(limitPrice)) {
      return { slices: [], filledQuantity: new Decimal(0), touchPrice: touchD, slippageCost: new Decimal(0), shortfallReason: 'touch is beyond the limit price' };
    }
    if (side === 'SELL' && touchD.lt(limitPrice)) {
      return { slices: [], filledQuantity: new Decimal(0), touchPrice: touchD, slippageCost: new Decimal(0), shortfallReason: 'touch is beyond the limit price' };
    }
    // Slippage can push the price to the limit but never through it.
    price = side === 'BUY' ? Decimal.min(price, limitPrice) : Decimal.max(price, limitPrice);
  }
  const slippageCost = price.minus(touchD).abs().mul(fillable);
  return { slices: [{ quantity: fillable, price }], filledQuantity: fillable, touchPrice: touchD, slippageCost, shortfallReason: shortfall };
}

function walkBook(side: Side, quantity: Decimal, limitPrice: Decimal | null, levels: BookSide[]): TakerFillResult {
  const slices: FillSlice[] = [];
  let remaining = quantity;
  const first = levels[0] as BookSide;
  const touch = d(first.price);
  for (const level of levels) {
    if (remaining.lte(0)) break;
    const lp = d(level.price);
    if (limitPrice !== null) {
      if (side === 'BUY' && lp.gt(limitPrice)) break;
      if (side === 'SELL' && lp.lt(limitPrice)) break;
    }
    const size = d(level.size);
    if (size.lte(0)) continue;
    const take = Decimal.min(size, remaining);
    slices.push({ quantity: take, price: lp });
    remaining = remaining.minus(take);
  }
  const filled = quantity.minus(remaining);
  let slippageCost = new Decimal(0);
  for (const s of slices) slippageCost = slippageCost.plus(s.price.minus(touch).abs().mul(s.quantity));
  const shortfall = remaining.gt(0) ? (filled.gt(0) ? 'book depth exhausted before the order was filled' : 'no fillable liquidity within the limit') : null;
  return { slices, filledQuantity: filled, touchPrice: touch, slippageCost, shortfallReason: shortfall };
}

/** Volume-weighted average price of the slices. */
export function vwap(slices: FillSlice[]): Decimal | null {
  let q = new Decimal(0);
  let n = new Decimal(0);
  for (const s of slices) {
    q = q.plus(s.quantity);
    n = n.plus(s.quantity.mul(s.price));
  }
  return q.gt(0) ? n.div(q) : null;
}

import { Decimal, d, type DecimalLike } from '@aoc/core';
import type { FeeModel, Liquidity } from './types';

/**
 * Fee for one fill, in quote currency (USD). Always >= 0.
 *
 * Polymarket: `fee = shares × rate × p × (1 − p)`, charged to takers only.
 * At p = 0.5 and rate = 0.07 this is 1.75 cents per share; it vanishes
 * toward 0 and 1. (See services/pmbot/docs/API.md for the verification.)
 */
export function computeFee(model: FeeModel, liquidity: Liquidity, quantity: DecimalLike, price: DecimalLike): Decimal {
  const q = d(quantity);
  const p = d(price);
  if (q.lte(0)) return new Decimal(0);
  switch (model.type) {
    case 'none':
      return new Decimal(0);
    case 'bps': {
      const bps = liquidity === 'MAKER' ? model.makerBps : model.takerBps;
      if (bps < 0) throw new RangeError('negative fee bps (rebates) are not modelled');
      return q.mul(p).mul(bps).div(10_000);
    }
    case 'polymarket': {
      if (liquidity === 'MAKER') return new Decimal(0);
      if (p.lt(0) || p.gt(1)) throw new RangeError(`outcome price ${p.toString()} outside [0, 1]`);
      return q.mul(model.rate).mul(p).mul(new Decimal(1).minus(p));
    }
  }
}

/** Highest fee rate the model can charge on this notional; used for reservations. */
export function worstCaseFee(model: FeeModel, quantity: DecimalLike, price: DecimalLike): Decimal {
  return computeFee(model, 'TAKER', quantity, price);
}

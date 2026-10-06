import type { FeeModel } from '@aoc/paper-engine';

/**
 * Default cost assumptions per venue, used for backtests and paper fills.
 *
 * These are the *published base-tier* schedules as last reviewed for this
 * build (no volume discounts, no token-payment discounts). Venues change fee
 * schedules; every value is an assumption with its source and must be
 * re-checked before relying on a result. They are deliberately on the
 * expensive side: an edge that only survives cheaper fees is not an edge for
 * a small account.
 */
export interface VenueCostAssumption {
  venue: string;
  feeModel: FeeModel;
  /** Typical quoted spread for liquid pairs, bps. */
  typicalSpreadBps: number;
  source: string;
  reviewed: string;
}

export const VENUE_COSTS: Record<string, VenueCostAssumption> = {
  binance: {
    venue: 'binance',
    feeModel: { type: 'bps', makerBps: 10, takerBps: 10 },
    typicalSpreadBps: 1,
    source: 'https://www.binance.com/en/fee/schedule (spot, regular user tier)',
    reviewed: '2026-10',
  },
  'binance-futures': {
    venue: 'binance-futures',
    feeModel: { type: 'bps', makerBps: 2, takerBps: 5 },
    typicalSpreadBps: 1,
    source: 'https://www.binance.com/en/fee/futureFee (USDⓈ-M, regular user tier)',
    reviewed: '2026-10',
  },
  coinbase: {
    venue: 'coinbase',
    feeModel: { type: 'bps', makerBps: 40, takerBps: 60 },
    typicalSpreadBps: 2,
    source: 'https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees (lowest volume tier)',
    reviewed: '2026-10',
  },
  kraken: {
    venue: 'kraken',
    feeModel: { type: 'bps', makerBps: 25, takerBps: 40 },
    typicalSpreadBps: 2,
    source: 'https://www.kraken.com/features/fee-schedule (Kraken Pro, lowest volume tier)',
    reviewed: '2026-10',
  },
  polymarket: {
    venue: 'polymarket',
    feeModel: { type: 'polymarket', rate: 0.07 },
    typicalSpreadBps: 100,
    source: 'services/pmbot/docs/API.md (crypto markets feeSchedule rate 0.07, takers only); other markets may differ — read feeSchedule per market',
    reviewed: '2026-10',
  },
};

export function venueCosts(venue: string): VenueCostAssumption {
  const v = VENUE_COSTS[venue];
  if (!v) throw new RangeError(`no cost assumption for venue ${venue}`);
  return v;
}

import DecimalJs from 'decimal.js';

/**
 * Money is never a float. All balances, prices, quantities, fees and P&L in the
 * paper engine and risk engine go through this Decimal clone, configured with
 * enough precision that no realistic sequence of operations loses a cent.
 * Values are persisted as strings into `numeric(30,10)` columns.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -30,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;
export type DecimalLike = Decimal | string | number;

/** Scale of the persisted numeric columns. */
export const MONEY_SCALE = 10;

export function d(v: DecimalLike | null | undefined): Decimal {
  if (v === null || v === undefined) return new Decimal(0);
  if (v instanceof Decimal) return v;
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new RangeError(`Cannot convert non-finite number ${v} to Decimal`);
  }
  return new Decimal(v);
}

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

export function dsum(values: Iterable<DecimalLike>): Decimal {
  let acc = new Decimal(0);
  for (const v of values) acc = acc.plus(d(v));
  return acc;
}

export function dmax(a: DecimalLike, b: DecimalLike): Decimal {
  return Decimal.max(d(a), d(b));
}

export function dmin(a: DecimalLike, b: DecimalLike): Decimal {
  return Decimal.min(d(a), d(b));
}

/** String with exactly MONEY_SCALE decimals, for persistence. */
export function toDb(v: DecimalLike): string {
  return d(v).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_EVEN).toFixed(MONEY_SCALE);
}

/** Lossy conversion for display, charts and statistics only. */
export function toNum(v: DecimalLike | null | undefined): number {
  return d(v).toNumber();
}

/** Round to cents, banker's rounding. For display and reporting. */
export function cents(v: DecimalLike): Decimal {
  return d(v).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

/** Round a price to a tick (e.g. 0.01) toward the safe side for the order. */
export function roundToTick(price: DecimalLike, tick: DecimalLike, mode: 'down' | 'up' | 'nearest' = 'nearest'): Decimal {
  const p = d(price);
  const t = d(tick);
  if (t.lte(0)) throw new RangeError('tick must be positive');
  const steps = p.div(t);
  const rounded =
    mode === 'down' ? steps.floor() : mode === 'up' ? steps.ceil() : steps.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
  return rounded.mul(t);
}

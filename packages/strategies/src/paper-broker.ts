import { d } from '@aoc/core';
import type { EngineChanges, Instrument, MarketSnapshot, PaperAccount } from '@aoc/paper-engine';
import type { Broker, BrokerOutcome, OrderIntent, PositionView } from './trading';

/**
 * Bridges strategy intents to a paper account at live prices. Each intent
 * becomes a paper order with a deterministic client id (idempotent across
 * retries of the same tick).
 */
export class PaperAccountBroker implements Broker {
  readonly changes: EngineChanges[] = [];
  private seq = 0;

  constructor(
    private readonly account: PaperAccount,
    private readonly instruments: Record<string, Instrument>,
    private readonly markets: Record<string, MarketSnapshot>,
    private readonly clientIdPrefix: string,
  ) {}

  submit(intent: OrderIntent): BrokerOutcome {
    const inst = this.instruments[intent.symbol];
    const market = this.markets[intent.symbol];
    if (!inst) return { accepted: false, reason: `no instrument configured for ${intent.symbol}` };
    if (!market) return { accepted: false, reason: `no live market data for ${intent.symbol}` };
    this.seq += 1;
    const res = this.account.submitOrder(
      {
        clientOrderId: `${this.clientIdPrefix}-${this.seq}`,
        instrument: inst,
        side: intent.side,
        type: intent.type,
        quantity: d(intent.quantity.toPrecision(12)),
        limitPrice: intent.limitPrice,
        reduceOnly: intent.reduceOnly,
        reason: intent.reason,
      },
      market,
    );
    this.changes.push(res.changes);
    if (res.duplicate) return { accepted: true, reason: 'duplicate of an order already placed this tick' };
    const ok = res.order.status === 'FILLED' || res.order.status === 'OPEN' || res.order.status === 'PARTIALLY_FILLED' || (res.order.status === 'CANCELLED' && res.order.filledQuantity.gt(0));
    return { accepted: ok, reason: res.order.rejectReason ?? undefined };
  }

  position(symbol: string): PositionView {
    const inst = this.instruments[symbol];
    if (!inst) return { quantity: 0, avgPrice: 0 };
    const p = this.account.position(inst.venue, inst.symbol);
    return p ? { quantity: p.quantity.toNumber(), avgPrice: p.avgPrice.toNumber() } : { quantity: 0, avgPrice: 0 };
  }
}

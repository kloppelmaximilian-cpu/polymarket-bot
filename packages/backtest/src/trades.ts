import type { FillState } from '@aoc/paper-engine';
import type { TradeRecord } from '@aoc/strategies';

interface Episode {
  direction: 'LONG' | 'SHORT';
  entryTs: number;
  entryQty: number;
  entryNotional: number;
  exitQty: number;
  exitNotional: number;
  maxQty: number;
  gross: number;
  fees: number;
  slippage: number;
  carry: number;
  reason: string;
}

/**
 * Turns a stream of fills into round-trip trades. A trade opens when a
 * position leaves zero and closes when it returns to zero; a flip closes one
 * trade and opens the next with the remainder.
 */
export class TradeTracker {
  private readonly open = new Map<string, Episode>();
  private readonly positions = new Map<string, number>();
  readonly trades: TradeRecord[] = [];
  private n = 0;

  onFill(f: FillState, reason = ''): TradeRecord | null {
    const symbol = f.symbol;
    const qty = f.quantity.toNumber();
    const price = f.price.toNumber();
    const signed = f.side === 'BUY' ? qty : -qty;
    const before = this.positions.get(symbol) ?? 0;
    const after = round(before + signed);
    this.positions.set(symbol, after);
    let closed: TradeRecord | null = null;

    const ep = this.open.get(symbol);
    if (!ep || before === 0) {
      this.open.set(symbol, newEpisode(signed > 0 ? 'LONG' : 'SHORT', f.ts.getTime(), qty, price, f.fee.toNumber(), f.slippageCost.toNumber(), reason));
      return null;
    }
    const sameDirection = Math.sign(before) === Math.sign(signed);
    if (sameDirection) {
      ep.entryQty += qty;
      ep.entryNotional += qty * price;
      ep.maxQty = Math.max(ep.maxQty, Math.abs(after));
      ep.fees += f.fee.toNumber();
      ep.slippage += f.slippageCost.toNumber();
      return null;
    }
    const closingQty = Math.min(Math.abs(before), qty);
    const share = qty > 0 ? closingQty / qty : 0;
    ep.exitQty += closingQty;
    ep.exitNotional += closingQty * price;
    ep.gross += f.realizedPnl.toNumber();
    ep.fees += f.fee.toNumber() * share;
    ep.slippage += f.slippageCost.toNumber() * share;
    if (after === 0 || Math.sign(after) !== Math.sign(before)) {
      closed = this.close(symbol, ep, f.ts.getTime());
      if (after !== 0) {
        const rem = Math.abs(after);
        this.open.set(symbol, newEpisode(after > 0 ? 'LONG' : 'SHORT', f.ts.getTime(), rem, price, f.fee.toNumber() * (1 - share), f.slippageCost.toNumber() * (1 - share), reason));
      }
    }
    return closed;
  }

  /** Attribute funding/carry to the open trade on `symbol`. */
  onCarry(symbol: string, amount: number): void {
    const ep = this.open.get(symbol);
    if (ep) ep.carry += amount;
  }

  openSymbols(): string[] {
    return [...this.open.keys()];
  }

  private close(symbol: string, ep: Episode, ts: number): TradeRecord {
    this.open.delete(symbol);
    const entryPrice = ep.entryQty > 0 ? ep.entryNotional / ep.entryQty : 0;
    const exitPrice = ep.exitQty > 0 ? ep.exitNotional / ep.exitQty : 0;
    const net = ep.gross - ep.fees + ep.carry;
    const committed = entryPrice * ep.maxQty;
    const t: TradeRecord = {
      id: `t${++this.n}`,
      symbol,
      direction: ep.direction,
      entryTs: ep.entryTs,
      exitTs: ts,
      entryPrice,
      exitPrice,
      quantity: ep.maxQty,
      grossPnl: ep.gross,
      fees: ep.fees,
      slippage: ep.slippage,
      carry: ep.carry,
      netPnl: net,
      returnPct: committed > 0 ? net / committed : 0,
      reason: ep.reason,
    };
    this.trades.push(t);
    return t;
  }
}

function newEpisode(direction: 'LONG' | 'SHORT', ts: number, qty: number, price: number, fee: number, slippage: number, reason: string): Episode {
  return { direction, entryTs: ts, entryQty: qty, entryNotional: qty * price, exitQty: 0, exitNotional: 0, maxQty: qty, gross: 0, fees: fee, slippage, carry: 0, reason };
}

function round(x: number): number {
  return Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1e10) / 1e10;
}

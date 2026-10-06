import type { BarSeries } from './bars';
import type { StrategyMeta, TradeRecord } from './types';

export type Direction = 'LONG' | 'SHORT' | 'FLAT';

export interface Signal {
  direction: Direction;
  /** 0..1 conviction; sizing may scale with it. */
  strength: number;
  reason: string;
}

export interface OrderIntent {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  type: 'MARKET' | 'LIMIT';
  limitPrice?: number | undefined;
  reason: string;
  reduceOnly?: boolean | undefined;
}

export interface PositionView {
  quantity: number;
  avgPrice: number;
}

export interface BrokerOutcome {
  accepted: boolean;
  reason?: string | undefined;
}

/** Where intents go: the backtest broker (next-bar fills) or the paper broker (live quotes). */
export interface Broker {
  submit(intent: OrderIntent): BrokerOutcome;
}

export interface StrategyContext<P> {
  readonly params: P;
  readonly primary: string;
  readonly symbols: readonly string[];
  /** Decision time (epoch ms): the close of the latest visible bar. */
  readonly now: number;
  readonly allowShort: boolean;
  bars(symbol?: string): BarSeries;
  position(symbol?: string): PositionView;
  equity(): number;
  /** Scratch state that survives between steps (persisted in paper mode). */
  state: Record<string, unknown>;
  broker: Broker;
  log(action: string, detail: string, data?: Record<string, unknown>): void;
}

/** Target signed quantities per symbol. */
export type TargetPositions = Record<string, number>;

/**
 * The common strategy interface (one method per pipeline stage):
 *
 *   initialize → analyze → managePosition → generateSignal →
 *   calculatePositionSize → riskCheck → executePaperOrder → recordResult
 *
 * `analyze` returns null while there is not enough history; the step is
 * then skipped entirely (no signal is better than a guessed one).
 */
export interface TradingStrategy<P, A = unknown> {
  readonly meta: StrategyMeta<P>;
  initialize(ctx: StrategyContext<P>): void;
  analyze(ctx: StrategyContext<P>): A | null;
  generateSignal(analysis: A, ctx: StrategyContext<P>): Signal;
  calculatePositionSize(signal: Signal, analysis: A, ctx: StrategyContext<P>): TargetPositions;
  riskCheck(intent: OrderIntent, ctx: StrategyContext<P>): string[];
  executePaperOrder(intent: OrderIntent, ctx: StrategyContext<P>): void;
  managePosition(analysis: A, ctx: StrategyContext<P>): OrderIntent[];
  recordResult(trade: TradeRecord, ctx: StrategyContext<P>): void;
}

/** Parameters every bar strategy understands. */
export interface CommonTradingParams {
  /** Fraction of equity committed at full strength. */
  positionFraction: number;
  allowShort: boolean;
  /** Stop loss as a fraction of entry price; 0 disables. */
  stopLossPct: number;
  /** Take profit as a fraction of entry price; 0 disables. */
  takeProfitPct: number;
  /** Minimum relative change of the target before rebalancing (anti-churn). */
  rebalanceThreshold: number;
  /** Ignore trades smaller than this notional (USD). */
  minTradeNotional: number;
}

export const COMMON_DEFAULTS: CommonTradingParams = {
  positionFraction: 0.9,
  allowShort: false,
  stopLossPct: 0,
  takeProfitPct: 0,
  rebalanceThreshold: 0.2,
  minTradeNotional: 10,
};

/**
 * Sensible defaults for everything except analysis and signal generation,
 * which each concrete strategy implements.
 */
export abstract class BaseTradingStrategy<P extends CommonTradingParams, A> implements TradingStrategy<P, A> {
  abstract readonly meta: StrategyMeta<P>;
  abstract analyze(ctx: StrategyContext<P>): A | null;
  abstract generateSignal(analysis: A, ctx: StrategyContext<P>): Signal;

  initialize(ctx: StrategyContext<P>): void {
    ctx.state.trades ??= 0;
    ctx.state.wins ??= 0;
  }

  calculatePositionSize(signal: Signal, _analysis: A, ctx: StrategyContext<P>): TargetPositions {
    const price = ctx.bars().last().close;
    if (signal.direction === 'FLAT' || !(price > 0)) return { [ctx.primary]: 0 };
    if (signal.direction === 'SHORT' && !ctx.allowShort) return { [ctx.primary]: 0 };
    const notional = Math.max(0, ctx.equity()) * ctx.params.positionFraction * Math.min(1, Math.max(0, signal.strength));
    const qty = notional / price;
    return { [ctx.primary]: signal.direction === 'LONG' ? qty : -qty };
  }

  riskCheck(intent: OrderIntent, ctx: StrategyContext<P>): string[] {
    const v: string[] = [];
    const price = ctx.bars(intent.symbol).last().close;
    if (!(intent.quantity > 0) || !Number.isFinite(intent.quantity)) v.push('non-positive quantity');
    if (intent.quantity * price < ctx.params.minTradeNotional && !intent.reduceOnly) v.push('below minimum trade notional');
    const pos = ctx.position(intent.symbol).quantity;
    const after = pos + (intent.side === 'BUY' ? intent.quantity : -intent.quantity);
    if (!ctx.allowShort && after < -1e-12) v.push('short positions are disabled for this strategy');
    return v;
  }

  executePaperOrder(intent: OrderIntent, ctx: StrategyContext<P>): void {
    const res = ctx.broker.submit(intent);
    ctx.log(res.accepted ? 'ORDER' : 'ORDER_REJECTED', `${intent.side} ${round(intent.quantity)} ${intent.symbol}: ${intent.reason}`, res.reason ? { reason: res.reason } : undefined);
  }

  /** Stop loss / take profit relative to the average entry price. */
  managePosition(_analysis: A, ctx: StrategyContext<P>): OrderIntent[] {
    const pos = ctx.position();
    if (pos.quantity === 0 || !(pos.avgPrice > 0)) return [];
    const price = ctx.bars().last().close;
    const move = (price / pos.avgPrice - 1) * Math.sign(pos.quantity);
    const { stopLossPct, takeProfitPct } = ctx.params;
    let reason: string | null = null;
    if (stopLossPct > 0 && move <= -stopLossPct) reason = `stop loss (${(move * 100).toFixed(2)}%)`;
    else if (takeProfitPct > 0 && move >= takeProfitPct) reason = `take profit (${(move * 100).toFixed(2)}%)`;
    if (!reason) return [];
    ctx.state.cooldownUntil = ctx.now; // re-entry allowed from the next bar
    return [{ symbol: ctx.primary, side: pos.quantity > 0 ? 'SELL' : 'BUY', quantity: Math.abs(pos.quantity), type: 'MARKET', reason, reduceOnly: true }];
  }

  recordResult(trade: TradeRecord, ctx: StrategyContext<P>): void {
    ctx.state.trades = ((ctx.state.trades as number) ?? 0) + 1;
    if (trade.netPnl > 0) ctx.state.wins = ((ctx.state.wins as number) ?? 0) + 1;
  }
}

/**
 * One decision step. Exits first (they are risk-reducing), then the new
 * target, translated into the minimal set of orders, each passing the
 * strategy's own risk check before it reaches the broker (where the central
 * risk engine checks again).
 */
export function runTradingStep<P extends CommonTradingParams, A>(strategy: TradingStrategy<P, A>, ctx: StrategyContext<P>): void {
  const analysis = strategy.analyze(ctx);
  if (analysis === null) return;

  const exits = strategy.managePosition(analysis, ctx);
  for (const exit of exits) {
    const violations = strategy.riskCheck(exit, ctx);
    if (violations.length === 0) strategy.executePaperOrder(exit, ctx);
    else ctx.log('EXIT_BLOCKED', violations.join('; '));
  }
  if (exits.length > 0) return; // do not re-enter on the same bar we exited

  const signal = strategy.generateSignal(analysis, ctx);
  const targets = strategy.calculatePositionSize(signal, analysis, ctx);
  for (const [symbol, target] of Object.entries(targets)) {
    if (!Number.isFinite(target)) continue;
    const current = ctx.position(symbol).quantity;
    const delta = target - current;
    if (delta === 0) continue;
    const price = ctx.bars(symbol).last().close;
    const reference = Math.max(Math.abs(target), Math.abs(current));
    const closingOut = target === 0 && current !== 0;
    if (!closingOut && reference > 0 && Math.abs(delta) / reference < ctx.params.rebalanceThreshold) continue;
    if (!closingOut && Math.abs(delta) * price < ctx.params.minTradeNotional) continue;
    const reducing = Math.abs(target) < Math.abs(current) && Math.sign(target) !== -Math.sign(current);
    const intent: OrderIntent = {
      symbol,
      side: delta > 0 ? 'BUY' : 'SELL',
      quantity: Math.abs(delta),
      type: 'MARKET',
      reason: signal.reason,
      reduceOnly: reducing || closingOut,
    };
    const violations = strategy.riskCheck(intent, ctx);
    if (violations.length > 0) {
      ctx.log('ORDER_SKIPPED', violations.join('; '), { symbol, target, current });
      continue;
    }
    strategy.executePaperOrder(intent, ctx);
  }
}

function round(x: number): string {
  return Number(x.toPrecision(6)).toString();
}

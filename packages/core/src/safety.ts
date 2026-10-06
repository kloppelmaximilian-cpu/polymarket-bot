import type { AppConfig } from './config';
import { LIVE_CONFIRMATION_PHRASE } from './config';
import type { ExperimentStatus } from './enums';
import { LiveTradingDisabledError } from './errors';

/**
 * The live-trading gate. Live execution is *prepared* (this gate and the
 * executor interface exist) but no live executor is implemented in this
 * version, so even a fully armed gate cannot move money. The gate exists so
 * that a future live path has exactly one, tested, place where every
 * independent condition is checked.
 *
 * Every condition fails closed and every failing condition is reported, not
 * just the first one, so an operator can see the full distance to "armed".
 */
export interface LiveGateContext {
  experimentStatus: ExperimentStatus;
  /** A human approval record for this experiment version (audit log id). */
  humanApprovalId: string | null;
  emergencyStopEngaged: boolean;
  requestedCapitalUsd: number;
}

export interface LiveGateResult {
  allowed: boolean;
  reasons: string[];
}

export function evaluateLiveGate(cfg: AppConfig, ctx: LiveGateContext): LiveGateResult {
  const reasons: string[] = [];
  if (cfg.TRADING_MODE !== 'live') reasons.push('TRADING_MODE is not "live" (default: paper)');
  if (!cfg.LIVE_TRADING_ENABLED) reasons.push('LIVE_TRADING_ENABLED is not true');
  if (cfg.LIVE_CONFIRMATION !== LIVE_CONFIRMATION_PHRASE) {
    reasons.push(`LIVE_CONFIRMATION is not the exact phrase "${LIVE_CONFIRMATION_PHRASE}"`);
  }
  if (!(cfg.LIVE_CAPITAL_CAP_USD > 0)) reasons.push('LIVE_CAPITAL_CAP_USD is not set');
  if (cfg.LIVE_CAPITAL_CAP_USD > 0 && ctx.requestedCapitalUsd > cfg.LIVE_CAPITAL_CAP_USD) {
    reasons.push(`requested capital ${ctx.requestedCapitalUsd} exceeds LIVE_CAPITAL_CAP_USD ${cfg.LIVE_CAPITAL_CAP_USD}`);
  }
  if (ctx.experimentStatus !== 'READY_FOR_LIVE_REVIEW') {
    reasons.push(`experiment status is ${ctx.experimentStatus}, not READY_FOR_LIVE_REVIEW`);
  }
  if (!ctx.humanApprovalId) reasons.push('no recorded human approval for this experiment version');
  if (ctx.emergencyStopEngaged) reasons.push('emergency stop is engaged');
  // Not a configurable condition: there is no live executor in this build.
  reasons.push('no live executor is implemented in this version of the platform');
  return { allowed: reasons.length === 0, reasons };
}

/** Throws unless the gate is fully open. In this build it always throws. */
export function assertLiveAllowed(cfg: AppConfig, ctx: LiveGateContext): void {
  const res = evaluateLiveGate(cfg, ctx);
  if (!res.allowed) throw new LiveTradingDisabledError(res.reasons);
}

export function effectiveMode(cfg: AppConfig): 'PAPER' | 'LIVE_REQUESTED_BUT_DISABLED' {
  return cfg.TRADING_MODE === 'live' ? 'LIVE_REQUESTED_BUT_DISABLED' : 'PAPER';
}

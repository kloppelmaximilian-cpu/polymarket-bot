import { d, type RiskLimits } from '@aoc/core';
import type { AccountSnapshot } from '@aoc/paper-engine';

export type RiskSeverity = 'INFO' | 'WARNING' | 'BREACH' | 'CRITICAL';
export type RiskAction = 'NONE' | 'REJECT_ORDER' | 'STOP_EXPERIMENT' | 'EMERGENCY_STOP';

export interface LimitStatus {
  limit: keyof RiskLimits | 'equity';
  label: string;
  value: number;
  threshold: number;
  /** value / threshold, 0..∞; ≥ 1 means at or beyond the limit. */
  utilization: number;
  severity: RiskSeverity;
  action: RiskAction;
  message: string;
}

export type MonitoredAccount = Pick<
  AccountSnapshot,
  'equity' | 'exposure' | 'openPositions' | 'ordersToday' | 'dayPnl' | 'drawdownPct' | 'spendTotal' | 'apiSpendTotal' | 'startingCapital'
>;

/** Fraction of a limit at which a WARNING is raised before the BREACH. */
export const WARNING_UTILIZATION = 0.8;

/**
 * Evaluate every limit against the current account. Loss, drawdown, spend and
 * equity breaches stop the experiment; exposure, position and order-count
 * overruns only warn (pre-trade checks already prevent adding to them, and
 * they can be exceeded passively by price moves).
 */
export function evaluateLimits(limits: RiskLimits, a: MonitoredAccount): LimitStatus[] {
  const out: LimitStatus[] = [];
  const push = (limit: LimitStatus['limit'], label: string, value: number, threshold: number, breachAction: RiskAction, breachSeverity: RiskSeverity = 'BREACH') => {
    const utilization = threshold > 0 ? value / threshold : value > 0 ? Number.POSITIVE_INFINITY : 0;
    let severity: RiskSeverity = 'INFO';
    let action: RiskAction = 'NONE';
    if (utilization >= 1) {
      severity = breachSeverity;
      action = breachAction;
    } else if (utilization >= WARNING_UTILIZATION) {
      severity = 'WARNING';
    }
    const message =
      severity === 'INFO'
        ? `${label}: ${fmt(value)} of ${fmt(threshold)}`
        : `${label} ${severity === 'WARNING' ? 'approaching' : 'reached'}: ${fmt(value)} vs limit ${fmt(threshold)}`;
    out.push({ limit, label, value, threshold, utilization, severity, action, message });
  };

  const dailyLoss = Math.max(0, -d(a.dayPnl).toNumber());
  push('maxDailyLoss', 'Daily loss', dailyLoss, limits.maxDailyLoss, 'STOP_EXPERIMENT');
  push('maxDrawdownPct', 'Drawdown', a.drawdownPct, limits.maxDrawdownPct, 'STOP_EXPERIMENT');
  push('maxExposure', 'Exposure', d(a.exposure).toNumber(), limits.maxExposure, 'NONE', 'WARNING');
  // Allocated capital may equal the cap; only exceeding it is a problem.
  const allocated = d(a.startingCapital).toNumber();
  out.push({
    limit: 'maxCapital',
    label: 'Allocated capital',
    value: allocated,
    threshold: limits.maxCapital,
    utilization: limits.maxCapital > 0 ? allocated / limits.maxCapital : 0,
    severity: allocated > limits.maxCapital ? 'WARNING' : 'INFO',
    action: 'NONE',
    message:
      allocated > limits.maxCapital
        ? `Allocated capital ${fmt(allocated)} exceeds max capital ${fmt(limits.maxCapital)}`
        : `Allocated capital: ${fmt(allocated)} of ${fmt(limits.maxCapital)}`,
  });
  push('maxPositions', 'Open positions', a.openPositions, limits.maxPositions, 'NONE', 'WARNING');
  push('maxOrdersPerDay', 'Orders today', a.ordersToday, limits.maxOrdersPerDay, 'NONE', 'WARNING');
  push('maxExperimentSpend', 'Experiment spend', d(a.spendTotal).toNumber(), limits.maxExperimentSpend, 'STOP_EXPERIMENT');
  push('maxApiSpend', 'API spend', d(a.apiSpendTotal).toNumber(), limits.maxApiSpend, 'STOP_EXPERIMENT');

  const equity = d(a.equity).toNumber();
  if (equity <= 0) {
    out.push({
      limit: 'equity',
      label: 'Equity',
      value: equity,
      threshold: 0,
      utilization: Number.POSITIVE_INFINITY,
      severity: 'CRITICAL',
      action: 'STOP_EXPERIMENT',
      message: `Equity exhausted (${fmt(equity)})`,
    });
  }
  return out;
}

export function breaches(statuses: LimitStatus[]): LimitStatus[] {
  return statuses.filter((s) => s.severity === 'BREACH' || s.severity === 'CRITICAL');
}

export function mustStop(statuses: LimitStatus[]): boolean {
  return statuses.some((s) => s.action === 'STOP_EXPERIMENT' || s.action === 'EMERGENCY_STOP');
}

/** Aggregate for the dashboard: worst severity across experiments. */
export function overallRiskStatus(all: LimitStatus[][], emergencyStop: boolean): 'NORMAL' | 'WARNING' | 'BREACH' | 'EMERGENCY_STOP' {
  if (emergencyStop) return 'EMERGENCY_STOP';
  const flat = all.flat();
  if (flat.some((s) => s.severity === 'BREACH' || s.severity === 'CRITICAL')) return 'BREACH';
  if (flat.some((s) => s.severity === 'WARNING')) return 'WARNING';
  return 'NORMAL';
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  return Math.abs(x) < 1 && x !== 0 ? x.toFixed(4) : x.toFixed(2);
}

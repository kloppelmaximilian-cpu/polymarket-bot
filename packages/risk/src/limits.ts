import { ValidationError, type RiskLimits } from '@aoc/core';

export const RISK_LIMIT_KEYS = [
  'maxCapital',
  'maxDailyLoss',
  'maxDrawdownPct',
  'maxExposure',
  'maxPositions',
  'maxOrdersPerDay',
  'maxOrderNotional',
  'maxApiSpend',
  'maxExperimentSpend',
] as const satisfies readonly (keyof RiskLimits)[];

export const RISK_LIMIT_LABELS: Record<keyof RiskLimits, string> = {
  maxCapital: 'Max capital',
  maxDailyLoss: 'Max daily loss',
  maxDrawdownPct: 'Max drawdown',
  maxExposure: 'Max exposure',
  maxPositions: 'Max open positions',
  maxOrdersPerDay: 'Max orders per day',
  maxOrderNotional: 'Max order size',
  maxApiSpend: 'Max API spend',
  maxExperimentSpend: 'Max experiment spend',
};

/** Every limit must be present, finite and sensible. Missing limits are an error, not "unlimited". */
export function validateRiskLimits(input: unknown): RiskLimits {
  if (!input || typeof input !== 'object') throw new ValidationError('risk limits must be an object');
  const src = input as Record<string, unknown>;
  const out: Partial<RiskLimits> = {};
  const problems: string[] = [];
  for (const k of RISK_LIMIT_KEYS) {
    const v = src[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      problems.push(`${k} must be a finite number`);
      continue;
    }
    if (v < 0) problems.push(`${k} must be >= 0`);
    out[k] = v;
  }
  if (typeof out.maxDrawdownPct === 'number' && (out.maxDrawdownPct <= 0 || out.maxDrawdownPct > 1)) {
    problems.push('maxDrawdownPct must be in (0, 1]');
  }
  for (const k of ['maxPositions', 'maxOrdersPerDay'] as const) {
    if (typeof out[k] === 'number' && !Number.isInteger(out[k])) problems.push(`${k} must be an integer`);
  }
  if (typeof out.maxDailyLoss === 'number' && typeof out.maxCapital === 'number' && out.maxDailyLoss > out.maxCapital) {
    problems.push('maxDailyLoss cannot exceed maxCapital');
  }
  if (problems.length) throw new ValidationError(`invalid risk limits: ${problems.join('; ')}`, { problems });
  return out as RiskLimits;
}

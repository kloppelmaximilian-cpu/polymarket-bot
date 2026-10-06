import { deflatedSharpe, gridOf, neighbours } from '@aoc/backtest';
import type { ParamSpace } from '@aoc/strategies';

/**
 * Strategy Lab. Variants are drawn from a small, pre-registered search space
 * (one grid step around the current version, or the full grid when it is
 * tiny). Selection is done on the training period only; the reported
 * out-of-sample result is never used to pick the winner, and the winner must
 * survive a deflated-Sharpe test for the number of variants tried.
 */
export function proposeVariants(base: Record<string, unknown>, space: ParamSpace, maxVariants = 12): Array<Record<string, unknown>> {
  if (Object.keys(space).length === 0) return [];
  let candidates: Array<Record<string, unknown>>;
  try {
    const grid = gridOf(space, maxVariants);
    candidates = grid.map((g) => ({ ...base, ...g }));
  } catch {
    candidates = neighbours(base, space).map((n) => n.params);
  }
  const key = (p: Record<string, unknown>) => JSON.stringify(Object.keys(space).map((k) => p[k]));
  const baseKey = key(base);
  const seen = new Set<string>([baseKey]);
  const out: Array<Record<string, unknown>> = [];
  for (const c of candidates) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= maxVariants) break;
  }
  return out;
}

export interface VariantResult {
  params: Record<string, unknown>;
  /** Training-period per-period Sharpe (not annualised), used for selection. */
  trainSharpe: number;
  trainNetReturn: number;
  testNetReturn: number;
  testTrades: number;
  testSharpe: number | null;
  /** Number of return observations in the training period (for DSR). */
  trainPeriods: number;
  trainSkew: number;
  trainKurtosis: number;
}

export interface LabRecommendation {
  recommend: boolean;
  best: VariantResult | null;
  baseline: VariantResult;
  dsr: number | null;
  trials: number;
  reasons: string[];
}

export function selectVariant(baseline: VariantResult, variants: VariantResult[], opts: { minDsr?: number; minTestTrades?: number } = {}): LabRecommendation {
  const minDsr = opts.minDsr ?? 0.9;
  const minTrades = opts.minTestTrades ?? 20;
  const all = [baseline, ...variants].filter((v) => Number.isFinite(v.trainSharpe));
  const reasons: string[] = [];
  if (variants.length === 0 || all.length < 2) return { recommend: false, best: null, baseline, dsr: null, trials: all.length, reasons: ['no variants to compare'] };
  const best = all.reduce((a, b) => (b.trainSharpe > a.trainSharpe ? b : a));
  const m = all.reduce((a, v) => a + v.trainSharpe, 0) / all.length;
  const variance = all.reduce((a, v) => a + (v.trainSharpe - m) ** 2, 0) / Math.max(1, all.length - 1);
  const dsr = deflatedSharpe(best.trainSharpe, best.trainPeriods, best.trainSkew, best.trainKurtosis, all.length, variance);
  if (best === baseline) reasons.push('the current version is already the best in training');
  if (dsr === null || dsr < minDsr) reasons.push(`deflated Sharpe ${dsr === null ? 'n/a' : dsr.toFixed(2)} < ${minDsr} for ${all.length} trials: the improvement is plausibly selection luck`);
  if (best.testTrades < minTrades) reasons.push(`only ${best.testTrades} out-of-sample trades (< ${minTrades})`);
  if (!(best.testNetReturn > baseline.testNetReturn)) reasons.push('no out-of-sample improvement over the current version');
  if (!(best.testNetReturn > 0)) reasons.push('out-of-sample net return is not positive');
  return { recommend: reasons.length === 0, best, baseline, dsr, trials: all.length, reasons };
}

/** v1 → v1.1 → v1.2; a major bump gives v2. Labels are never reused. */
export function nextVersionLabel(existing: string[], bump: 'minor' | 'major' = 'minor'): string {
  const parsed = existing
    .map((l) => /^v(\d+)(?:\.(\d+))?$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ major: Number(m[1]), minor: m[2] ? Number(m[2]) : 0 }));
  if (parsed.length === 0) return 'v1';
  const maxMajor = Math.max(...parsed.map((p) => p.major));
  if (bump === 'major') return `v${maxMajor + 1}`;
  const maxMinor = Math.max(...parsed.filter((p) => p.major === maxMajor).map((p) => p.minor));
  return `v${maxMajor}.${maxMinor + 1}`;
}

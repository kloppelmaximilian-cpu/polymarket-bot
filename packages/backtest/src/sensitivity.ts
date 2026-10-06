import type { ParamSpace } from '@aoc/strategies';

export interface CostSensitivity {
  points: Array<{ multiplier: number; netProfit: number; trades: number }>;
  /** Cost multiplier at which net profit crosses zero (null if it never does in range). */
  breakEvenMultiplier: number | null;
  profitableAt1_5x: boolean;
}

export function costSensitivity(run: (multiplier: number) => { netProfit: number; trades: number }, multipliers = [0, 0.5, 1, 1.5, 2]): CostSensitivity {
  const points = multipliers.map((m) => ({ multiplier: m, ...run(m) }));
  let breakEven: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.netProfit > 0 && b.netProfit <= 0) {
      breakEven = a.multiplier + ((b.multiplier - a.multiplier) * a.netProfit) / (a.netProfit - b.netProfit);
      break;
    }
  }
  if (breakEven === null && points[0] && points[0].netProfit <= 0) breakEven = 0;
  const at15 = points.find((p) => p.multiplier === 1.5);
  return { points, breakEvenMultiplier: breakEven, profitableAt1_5x: at15 ? at15.netProfit > 0 : false };
}

export interface ParamSensitivity {
  base: number;
  neighbours: Array<{ param: string; value: unknown; metric: number }>;
  /** Share of one-step neighbours whose metric keeps the base's sign and ≥ 50% of its size. */
  stability: number;
}

/** Perturb each parameter by one grid step in each direction. */
export function neighbours(base: Record<string, unknown>, space: ParamSpace): Array<{ param: string; value: unknown; params: Record<string, unknown> }> {
  const out: Array<{ param: string; value: unknown; params: Record<string, unknown> }> = [];
  for (const [k, range] of Object.entries(space)) {
    const v = base[k];
    if (range.type === 'choice') {
      for (const alt of range.values) if (alt !== v) out.push({ param: k, value: alt, params: { ...base, [k]: alt } });
      continue;
    }
    if (typeof v !== 'number') continue;
    for (const dir of [-1, 1]) {
      let nv = v + dir * range.step;
      if (range.type === 'int') nv = Math.round(nv);
      else nv = Math.round(nv * 1e9) / 1e9;
      if (nv < range.min || nv > range.max) continue;
      out.push({ param: k, value: nv, params: { ...base, [k]: nv } });
    }
  }
  return out;
}

export function paramSensitivity(base: Record<string, unknown>, space: ParamSpace, metric: (params: Record<string, unknown>) => number): ParamSensitivity {
  const b = metric(base);
  const ns = neighbours(base, space).map((n) => ({ param: n.param, value: n.value, metric: metric(n.params) }));
  const stable = ns.filter((n) => Number.isFinite(n.metric) && Math.sign(n.metric) === Math.sign(b) && Math.abs(n.metric) >= 0.5 * Math.abs(b)).length;
  return { base: b, neighbours: ns, stability: ns.length > 0 ? stable / ns.length : 0 };
}

/** Full Cartesian grid of a (small, pre-registered) parameter space. */
export function gridOf(space: ParamSpace, limit = 200): Array<Record<string, unknown>> {
  let combos: Array<Record<string, unknown>> = [{}];
  for (const [k, r] of Object.entries(space)) {
    const values: unknown[] = r.type === 'choice' ? r.values : range(r.min, r.max, r.step, r.type === 'int');
    const next: Array<Record<string, unknown>> = [];
    for (const c of combos) for (const v of values) next.push({ ...c, [k]: v });
    combos = next;
    if (combos.length > limit) throw new RangeError(`parameter grid exceeds ${limit} combinations; narrow the search space`);
  }
  return combos;
}

function range(min: number, max: number, step: number, int: boolean): number[] {
  const out: number[] = [];
  for (let x = min; x <= max + 1e-12; x += step) out.push(int ? Math.round(x) : Math.round(x * 1e9) / 1e9);
  return out;
}

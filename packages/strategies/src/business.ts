import { Rng, mean, quantile, type Assumption } from '@aoc/core';
import type {
  BusinessMonth,
  BusinessSimulationResult,
  BusinessSummary,
  PaperStepInput,
  PaperStepOutput,
  Percentiles,
  SensitivityRow,
  SimulationInput,
  StrategyMeta,
  StrategyModule,
} from './types';

export type AssumptionValues = Record<string, number>;

export interface MarketView {
  /** Upper bound on paying customers this model can plausibly reach. */
  addressableCustomers: number;
  description: string;
}

export interface CostBreakdown {
  fixed: number;
  variable: number;
  acquisition: number;
  api: number;
  total: number;
}

export interface BusinessState {
  customers: number;
  /** Fractional carry for the binomial draws of small daily flows. */
  month: number;
  [k: string]: number;
}

export interface PeriodFlows {
  demand: number;
  newCustomers: number;
  churned: number;
  customers: number;
  revenue: number;
  recurringRevenue: number;
  costs: CostBreakdown;
  profit: number;
}

/**
 * The common business-model interface. Every model is a funnel:
 *
 *   discoverMarket → estimateDemand → calculateConversion → acquireCustomer
 *   → calculateChurn → calculateRevenue → estimateCosts → calculateProfit
 *   → evaluate (Monte Carlo over the assumption ranges)
 *
 * All rates are per month; `fraction` scales a period (1 = month, 1/30 = day)
 * so the same model drives both the Monte Carlo and the day-by-day paper run.
 */
export interface BusinessModel<P> {
  readonly meta: StrategyMeta<P>;
  defaultAssumptions(): Assumption[];
  discoverMarket(v: AssumptionValues): MarketView;
  /** Expected top-of-funnel units (visitors, leads, prospects) in the period. */
  estimateDemand(v: AssumptionValues, month: number, fraction: number): number;
  /** Stage conversion probabilities, applied in order. */
  calculateConversion(v: AssumptionValues, month: number): number[];
  acquireCustomer(topOfFunnel: number, stages: number[], rng: Rng): number;
  calculateChurn(v: AssumptionValues, customers: number, fraction: number, rng: Rng): number;
  calculateRevenue(v: AssumptionValues, state: BusinessState, newCustomers: number, fraction: number): { revenue: number; recurring: number };
  estimateCosts(v: AssumptionValues, state: BusinessState, flows: { demand: number; newCustomers: number }, month: number, fraction: number): CostBreakdown;
  calculateProfit(revenue: number, costs: CostBreakdown): number;
  evaluate(input: SimulationInput<P>): BusinessSimulationResult;
}

// ───────────────────────────────────────────────────── assumption sampling ──

export function sampleAssumption(a: Assumption, rng: Rng): number {
  if (!(a.low <= a.mode && a.mode <= a.high)) throw new RangeError(`assumption ${a.key}: requires low <= mode <= high`);
  switch (a.distribution) {
    case 'fixed':
      return a.mode;
    case 'uniform':
      return rng.uniform(a.low, a.high);
    case 'triangular':
      return rng.triangular(a.low, a.mode, a.high);
    case 'pert': {
      if (a.high === a.low) return a.mode;
      const range = a.high - a.low;
      const alpha = 1 + (4 * (a.mode - a.low)) / range;
      const beta = 1 + (4 * (a.high - a.mode)) / range;
      return a.low + rng.beta(alpha, beta) * range;
    }
  }
}

export function sampleAll(assumptions: readonly Assumption[], rng: Rng, pinned: AssumptionValues = {}): AssumptionValues {
  const v: AssumptionValues = {};
  for (const a of assumptions) v[a.key] = a.key in pinned ? (pinned[a.key] as number) : sampleAssumption(a, rng);
  return v;
}

export function modeValues(assumptions: readonly Assumption[]): AssumptionValues {
  const v: AssumptionValues = {};
  for (const a of assumptions) v[a.key] = a.mode;
  return v;
}

/** Throws if a model reads an assumption that was not supplied. */
export function req(v: AssumptionValues, key: string): number {
  const x = v[key];
  if (x === undefined || !Number.isFinite(x)) throw new RangeError(`missing assumption "${key}"`);
  return x;
}

// ─────────────────────────────────────────────────────────── base model ──

const EMPTY_COSTS: CostBreakdown = { fixed: 0, variable: 0, acquisition: 0, api: 0, total: 0 };

/**
 * Generic funnel engine. Concrete models implement demand, conversion,
 * revenue and costs; this class supplies the stochastic draws, the Monte
 * Carlo, the sensitivity analysis, the stress test and the paper day step.
 */
export abstract class FunnelBusinessModel<P> implements BusinessModel<P> {
  abstract readonly meta: StrategyMeta<P>;
  abstract defaultAssumptions(): Assumption[];
  abstract discoverMarket(v: AssumptionValues): MarketView;
  abstract estimateDemand(v: AssumptionValues, month: number, fraction: number): number;
  abstract calculateConversion(v: AssumptionValues, month: number): number[];
  abstract calculateRevenue(v: AssumptionValues, state: BusinessState, newCustomers: number, fraction: number): { revenue: number; recurring: number };
  abstract estimateCosts(v: AssumptionValues, state: BusinessState, flows: { demand: number; newCustomers: number }, month: number, fraction: number): CostBreakdown;

  acquireCustomer(topOfFunnel: number, stages: number[], rng: Rng): number {
    let n = Math.max(0, Math.round(topOfFunnel));
    for (const p of stages) n = rng.binomial(n, Math.min(1, Math.max(0, p)));
    return n;
  }

  /** Monthly churn `churn` converted to the period: 1 − (1 − c)^fraction. */
  calculateChurn(v: AssumptionValues, customers: number, fraction: number, rng: Rng): number {
    const c = v.churn ?? 0;
    if (customers <= 0 || c <= 0) return 0;
    const p = 1 - Math.pow(1 - Math.min(1, c), fraction);
    return rng.binomial(Math.round(customers), p);
  }

  calculateProfit(revenue: number, costs: CostBreakdown): number {
    return revenue - costs.total;
  }

  /** One period of the business. Mutates `state`. */
  step(v: AssumptionValues, state: BusinessState, month: number, fraction: number, rng: Rng): PeriodFlows {
    const market = this.discoverMarket(v);
    const demand = Math.max(0, this.estimateDemand(v, month, fraction));
    const drawnDemand = rng.poisson(demand);
    let newCustomers = this.acquireCustomer(drawnDemand, this.calculateConversion(v, month), rng);
    const room = Math.max(0, Math.floor(market.addressableCustomers - state.customers));
    newCustomers = Math.min(newCustomers, room);
    const churned = this.calculateChurn(v, state.customers, fraction, rng);
    state.customers = Math.max(0, state.customers - churned) + newCustomers;
    const { revenue, recurring } = this.calculateRevenue(v, state, newCustomers, fraction);
    const costs = this.estimateCosts(v, state, { demand: drawnDemand, newCustomers }, month, fraction);
    const profit = this.calculateProfit(revenue, costs);
    return { demand: drawnDemand, newCustomers, churned, customers: state.customers, revenue, recurringRevenue: recurring, costs, profit };
  }

  /** A single simulated life of the business over `horizon` months. */
  simulateRun(v: AssumptionValues, horizon: number, rng: Rng, startingCapital: number) {
    const state: BusinessState = { customers: 0, month: 0 };
    let cash = startingCapital;
    let minCash = cash;
    let cumulative = 0;
    let breakEven: number | null = null;
    let ruined = false;
    const monthly: Array<PeriodFlows & { cash: number; cumulative: number }> = [];
    for (let m = 1; m <= horizon; m++) {
      state.month = m;
      const f = this.step(v, state, m, 1, rng);
      cash += f.profit;
      cumulative += f.profit;
      minCash = Math.min(minCash, cash);
      if (cash < 0) ruined = true;
      if (breakEven === null && cumulative >= 0 && m > 1 && f.profit > 0) breakEven = m;
      monthly.push({ ...f, cash, cumulative });
    }
    return { monthly, breakEven, maxCashNeed: Math.max(0, startingCapital - minCash), ruined, cumulative };
  }

  evaluate(input: SimulationInput<P>): BusinessSimulationResult {
    const assumptions = input.assumptions.length > 0 ? input.assumptions : this.defaultAssumptions();
    validateAssumptions(assumptions);
    const rng = new Rng(input.seed);
    const runs: ReturnType<FunnelBusinessModel<P>['simulateRun']>[] = [];
    const valuesPerRun: AssumptionValues[] = [];
    for (let i = 0; i < input.runs; i++) {
      const r = rng.fork(`run-${i}`);
      const v = sampleAll(assumptions, r);
      valuesPerRun.push(v);
      runs.push(this.simulateRun(v, input.horizonMonths, r, input.startingCapital));
    }

    const months: BusinessMonth[] = [];
    for (let m = 0; m < input.horizonMonths; m++) {
      const pick = (f: (x: PeriodFlows & { cash: number; cumulative: number }) => number) => pct(runs.map((r) => f(r.monthly[m]!)));
      months.push({
        month: m + 1,
        revenue: pick((x) => x.revenue),
        costs: pick((x) => x.costs.total),
        profit: pick((x) => x.profit),
        cumulativeCash: pick((x) => x.cash),
        customers: pick((x) => x.customers),
        mrr: pick((x) => x.recurringRevenue),
      });
    }

    const h = input.horizonMonths;
    const m12 = Math.min(12, h) - 1;
    const breakEvens = runs.map((r) => r.breakEven).filter((b): b is number => b !== null);
    const totals = aggregateUnitEconomics(runs.map((r) => r.monthly));
    const summary: BusinessSummary = {
      horizonMonths: h,
      runs: input.runs,
      probProfitableAtHorizon: runs.filter((r) => r.cumulative > 0).length / runs.length,
      probBreakEvenWithin12m: runs.filter((r) => r.breakEven !== null && r.breakEven <= 12).length / runs.length,
      breakEvenMonthP50: breakEvens.length >= runs.length / 2 ? quantile(runs.map((r) => r.breakEven ?? Number.POSITIVE_INFINITY), 0.5) : null,
      cumulativeProfit: pct(runs.map((r) => r.cumulative)),
      profitMonth12: pct(runs.map((r) => r.monthly[m12]!.profit)),
      maxCashNeed: pct(runs.map((r) => r.maxCashNeed)),
      revenueMonth12: pct(runs.map((r) => r.monthly[m12]!.revenue)),
      annualRunRateMonth12: pct(runs.map((r) => r.monthly[m12]!.revenue * 12)),
      probRuin: runs.filter((r) => r.ruined).length / runs.length,
      ...totals,
    };
    if (summary.breakEvenMonthP50 !== null && !Number.isFinite(summary.breakEvenMonthP50)) summary.breakEvenMonthP50 = null;

    const sensitivity = this.sensitivity(assumptions, input);
    const stressedProfitP50 = this.stressed(assumptions, input);
    const unverified = assumptions.filter((a) => !a.source).length;
    return {
      provenance: 'ESTIMATED',
      seed: input.seed,
      months,
      summary,
      sensitivity,
      stressedProfitP50,
      assumptions,
      notes: [
        `Monte Carlo over ${input.runs} scenarios drawn from the assumption ranges; results are estimates, not observations.`,
        `${unverified} of ${assumptions.length} assumptions are unverified and should be validated before relying on this estimate.`,
      ],
    };
  }

  /** Tornado: pin each uncertain assumption at its low and high, P50 cumulative profit. */
  sensitivity(assumptions: Assumption[], input: SimulationInput<P>): SensitivityRow[] {
    const runs = Math.max(50, Math.floor(input.runs / 5));
    const rows: SensitivityRow[] = [];
    for (const a of assumptions) {
      if (a.distribution === 'fixed' || a.low === a.high) continue;
      const atLow = this.medianProfit(assumptions, input, runs, { [a.key]: a.low }, `sens-${a.key}`);
      const atHigh = this.medianProfit(assumptions, input, runs, { [a.key]: a.high }, `sens-${a.key}`);
      rows.push({ key: a.key, label: a.label, lowValue: a.low, highValue: a.high, profitAtLow: atLow, profitAtHigh: atHigh, swing: Math.abs(atHigh - atLow) });
    }
    return rows.sort((x, y) => y.swing - x.swing);
  }

  /** Conversion −30%, costs and churn +30%, prices −10%, at the median. */
  stressed(assumptions: Assumption[], input: SimulationInput<P>): number {
    const stressedAssumptions = assumptions.map((a) => {
      const f = a.stressRole === 'conversion' || a.stressRole === 'demand' ? 0.7 : a.stressRole === 'cost' || a.stressRole === 'churn' ? 1.3 : a.stressRole === 'price' ? 0.9 : 1;
      return f === 1 ? a : { ...a, low: a.low * f, mode: a.mode * f, high: a.high * f };
    });
    return this.medianProfit(stressedAssumptions, input, Math.max(100, Math.floor(input.runs / 4)), {}, 'stress');
  }

  private medianProfit(assumptions: Assumption[], input: SimulationInput<P>, runs: number, pinned: AssumptionValues, label: string): number {
    const rng = new Rng(`${input.seed}/${label}`);
    const out: number[] = [];
    for (let i = 0; i < runs; i++) {
      const r = rng.fork(`run-${i}`);
      const v = sampleAll(assumptions, r, pinned);
      out.push(this.simulateRun(v, input.horizonMonths, r, input.startingCapital).cumulative);
    }
    return quantile(out, 0.5);
  }

  /**
   * Paper mode for business models: advance the simulated business one day
   * at a time inside a paper account. One plausible world is drawn from the
   * assumptions when the paper run starts and kept in `state`, so the paper
   * ledger follows a consistent business rather than re-rolling every day.
   * The result is SIMULATED evidence (there are no real customers).
   */
  paperStep(input: PaperStepInput<P>, days: number): PaperStepOutput {
    const assumptions = input.assumptions.length > 0 ? input.assumptions : this.defaultAssumptions();
    const state = { ...input.state } as Record<string, unknown>;
    if (!state.world) state.world = sampleAll(assumptions, new Rng(`${input.seed}/world`));
    const v = state.world as AssumptionValues;
    const biz: BusinessState = (state.business as BusinessState | undefined) ?? { customers: 0, month: 1 };
    let day = (state.day as number | undefined) ?? 0;
    const changes: PaperStepOutput['changes'] = [];
    const decisions: PaperStepOutput['decisions'] = [];
    for (let i = 0; i < days; i++) {
      day += 1;
      const month = Math.floor((day - 1) / 30) + 1;
      biz.month = month;
      const ts = input.now; // ledger order is kept by the sequence numbers
      const rng = new Rng(`${input.seed}/day-${day}`);
      const f = this.step(v, biz, month, 1 / 30, rng);
      if (f.revenue > 0) changes.push(input.account.recordOperating('REVENUE', round2(f.revenue), ts, { category: 'revenue', description: `Simulated day ${day} revenue` }));
      const parts: Array<[keyof CostBreakdown, string, boolean]> = [
        ['fixed', 'fixed_costs', false],
        ['variable', 'variable_costs', false],
        ['acquisition', 'acquisition', false],
        ['api', 'api', true],
      ];
      for (const [k, category, isApi] of parts) {
        const amount = round2(f.costs[k]);
        if (amount > 0) changes.push(input.account.recordOperating('COST', amount, ts, { category, description: `Simulated day ${day} ${category}`, isApiCost: isApi }));
      }
      decisions.push({
        ts: ts.getTime(),
        action: 'SIM_DAY',
        detail: `day ${day}: demand ${f.demand}, +${f.newCustomers} / −${f.churned} customers (${f.customers}), revenue ${round2(f.revenue)}, costs ${round2(f.costs.total)}`,
        data: { day, demand: f.demand, newCustomers: f.newCustomers, churned: f.churned, customers: f.customers },
      });
    }
    state.business = biz;
    state.day = day;
    return { changes, state, decisions, simulatedDays: days };
  }
}

/** Shorthand for an assumption with a PERT distribution and no source (unverified). */
export function assumption(
  key: string,
  label: string,
  unit: string,
  low: number,
  mode: number,
  high: number,
  opts: { stressRole?: Assumption['stressRole']; distribution?: Assumption['distribution']; source?: string | null; note?: string } = {},
): Assumption {
  return {
    key,
    label,
    unit,
    low,
    mode,
    high,
    distribution: opts.distribution ?? (low === high ? 'fixed' : 'pert'),
    source: opts.source ?? null,
    note: opts.note ?? 'Unverified planning assumption. Replace with your own measured data before relying on the estimate.',
    stressRole: opts.stressRole,
  };
}

/** Pipeline adapter for a business model. */
export function createBusinessModule<P>(model: FunnelBusinessModel<P>): StrategyModule<P> {
  return {
    meta: model.meta,
    dataRequirements: () => [{ kind: 'NONE' }],
    defaultAssumptions: () => model.defaultAssumptions(),
    simulate: (input) => model.evaluate(input),
    paperStep: (input) => model.paperStep(input, Math.max(1, Math.floor(input.daysToSimulate ?? 1))),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function pct(xs: number[]): Percentiles {
  return { p10: quantile(xs, 0.1), p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), mean: mean(xs) };
}

export function validateAssumptions(assumptions: readonly Assumption[]): void {
  const seen = new Set<string>();
  for (const a of assumptions) {
    if (seen.has(a.key)) throw new RangeError(`duplicate assumption ${a.key}`);
    seen.add(a.key);
    for (const x of [a.low, a.mode, a.high]) if (!Number.isFinite(x)) throw new RangeError(`assumption ${a.key} has a non-finite value`);
    if (!(a.low <= a.mode && a.mode <= a.high)) throw new RangeError(`assumption ${a.key}: requires low <= mode <= high`);
  }
}

function aggregateUnitEconomics(runs: Array<Array<PeriodFlows>>): Pick<BusinessSummary, 'ltv' | 'cac' | 'ltvToCac' | 'paybackMonths' | 'grossMarginPct'> {
  const perRun = runs.map((months) => {
    let revenue = 0;
    let variable = 0;
    let api = 0;
    let acquisition = 0;
    let newCustomers = 0;
    let churned = 0;
    let customerMonths = 0;
    for (const f of months) {
      revenue += f.revenue;
      variable += f.costs.variable;
      api += f.costs.api;
      acquisition += f.costs.acquisition;
      newCustomers += f.newCustomers;
      churned += f.churned;
      customerMonths += f.customers;
    }
    const arpu = customerMonths > 0 ? revenue / customerMonths : NaN;
    const gm = revenue > 0 ? (revenue - variable - api) / revenue : NaN;
    const churnRate = customerMonths > 0 ? churned / customerMonths : NaN;
    const cac = newCustomers > 0 ? acquisition / newCustomers : NaN;
    const ltv = Number.isFinite(arpu) && Number.isFinite(gm) && churnRate > 0 ? (arpu * gm) / churnRate : NaN;
    const payback = Number.isFinite(cac) && arpu * gm > 0 ? cac / (arpu * gm) : NaN;
    return { arpu, gm, cac, ltv, payback };
  });
  const med = (f: (x: (typeof perRun)[number]) => number) => {
    const xs = perRun.map(f).filter((x) => Number.isFinite(x));
    return xs.length >= perRun.length / 2 ? quantile(xs, 0.5) : null;
  };
  const ltv = med((x) => x.ltv);
  const cac = med((x) => x.cac);
  const gm = med((x) => x.gm);
  return {
    ltv,
    cac,
    ltvToCac: ltv !== null && cac !== null && cac > 0 ? ltv / cac : null,
    paybackMonths: med((x) => x.payback),
    grossMarginPct: gm,
  };
}

export { EMPTY_COSTS };

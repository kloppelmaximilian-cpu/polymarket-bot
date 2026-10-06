import { z } from 'zod';
import type { Assumption } from '@aoc/core';
import {
  FunnelBusinessModel,
  assumption,
  createBusinessModule,
  req,
  type AnyStrategyModule,
  type AssumptionValues,
  type BusinessState,
  type CostBreakdown,
  type MarketView,
  type StrategyMeta,
} from '@aoc/strategies';

export interface SaasParams {
  pricingModel: 'subscription';
}

export const aiSaasMeta: StrategyMeta<SaasParams> = {
  id: 'business.ai-saas',
  name: 'AI SaaS (self-serve subscription)',
  kind: 'BUSINESS',
  category: 'AI_SAAS',
  version: '1.0.0',
  description: 'A narrow self-serve AI tool sold as a monthly subscription: visitors → sign-ups → paid customers, with LLM API costs per active customer.',
  hypothesis: 'A focused AI tool for one well-defined job can convert enough organic visitors into paying subscribers that MRR exceeds API, hosting, support and marketing costs within 12 months.',
  edgeRationale: 'Software margins with usage-based API costs. The weak points are distribution (visitors), retention (churn) and API cost per active user; all three are assumptions until measured.',
  knownRisks: ['Distribution: organic traffic is hard to get', 'High churn of AI tools after novelty wears off', 'API price changes or model deprecations', 'Easy to copy; platform features may subsume it'],
  defaultParams: { pricingModel: 'subscription' },
  paramsSchema: z.object({ pricingModel: z.literal('subscription') }),
  paramSpace: {},
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: false, walkForward: false, paper: true, monteCarlo: true, requiresRealData: false },
  qualitative: { automation: 80, scalability: 90, operationalSimplicity: 55, recurringRevenue: 90, competition: 35, dependencySafety: 45, dataAvailability: 40, executionSafety: 70, timeToRevenueDays: 75 },
};

export class AiSaasModel extends FunnelBusinessModel<SaasParams> {
  readonly meta = aiSaasMeta;

  defaultAssumptions(): Assumption[] {
    return [
      assumption('visitors', 'Visitors per month (month 1)', 'visitors', 300, 1500, 6000, { stressRole: 'demand' }),
      assumption('visitorGrowth', 'Monthly visitor growth', 'fraction', 0, 0.08, 0.2, { stressRole: 'demand' }),
      assumption('signupRate', 'Visitor → sign-up rate', 'fraction', 0.01, 0.04, 0.08, { stressRole: 'conversion' }),
      assumption('paidConversion', 'Sign-up → paid conversion', 'fraction', 0.05, 0.15, 0.3, { stressRole: 'conversion' }),
      assumption('price', 'Price per month', 'USD', 15, 29, 79, { stressRole: 'price' }),
      assumption('churn', 'Monthly churn', 'fraction', 0.03, 0.06, 0.12, { stressRole: 'churn' }),
      assumption('apiCostPerCustomer', 'LLM API cost per paying customer per month', 'USD', 1, 4, 12, { stressRole: 'cost' }),
      assumption('apiCostPerSignup', 'LLM API cost per free sign-up (trial usage)', 'USD', 0.1, 0.5, 2, { stressRole: 'cost' }),
      assumption('hosting', 'Hosting and tooling per month', 'USD', 50, 150, 400, { stressRole: 'cost' }),
      assumption('supportPerCustomer', 'Support cost per customer per month', 'USD', 0.5, 1.5, 4, { stressRole: 'cost' }),
      assumption('marketing', 'Marketing spend per month', 'USD', 0, 500, 1500, { stressRole: 'cost' }),
      assumption('paymentFee', 'Payment processing fee', 'fraction', 0.03, 0.035, 0.045, { stressRole: 'cost' }),
      assumption('addressable', 'Reachable paying customers (cap)', 'customers', 1000, 5000, 20000),
    ];
  }

  discoverMarket(v: AssumptionValues): MarketView {
    return { addressableCustomers: req(v, 'addressable'), description: 'Self-serve buyers of one narrow AI workflow tool' };
  }

  estimateDemand(v: AssumptionValues, month: number, fraction: number): number {
    return req(v, 'visitors') * Math.pow(1 + req(v, 'visitorGrowth'), month - 1) * fraction;
  }

  calculateConversion(v: AssumptionValues): number[] {
    return [req(v, 'signupRate'), req(v, 'paidConversion')];
  }

  calculateRevenue(v: AssumptionValues, state: BusinessState, _new: number, fraction: number) {
    const mrr = state.customers * req(v, 'price');
    return { revenue: mrr * fraction, recurring: mrr };
  }

  estimateCosts(v: AssumptionValues, state: BusinessState, flows: { demand: number; newCustomers: number }, _month: number, fraction: number): CostBreakdown {
    const signups = flows.demand * req(v, 'signupRate');
    const revenue = state.customers * req(v, 'price') * fraction;
    const api = state.customers * req(v, 'apiCostPerCustomer') * fraction + signups * req(v, 'apiCostPerSignup');
    const variable = state.customers * req(v, 'supportPerCustomer') * fraction + revenue * req(v, 'paymentFee');
    const fixed = req(v, 'hosting') * fraction;
    const acquisition = req(v, 'marketing') * fraction;
    return { fixed, variable, acquisition, api, total: fixed + variable + acquisition + api };
  }
}

export const aiSaasModule = createBusinessModule(new AiSaasModel());
export const saasModules: AnyStrategyModule[] = [aiSaasModule];

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

export interface LeadGenParams {
  /** Outreach must honour opt-outs; the model removes opted-out contacts permanently. */
  honourOptOut: true;
}

export const aiLeadGenMeta: StrategyMeta<LeadGenParams> = {
  id: 'business.ai-lead-generation',
  name: 'AI Lead Generation Agency',
  kind: 'BUSINESS',
  category: 'LEAD_GENERATION',
  version: '1.0.0',
  description: 'Sources and AI-qualifies B2B leads, runs compliant personalised outreach, books meetings and closes retainer clients for a lead-generation service.',
  hypothesis: 'AI enrichment and personalisation raise reply and meeting rates enough that a small agency can win retainer clients at a cost per client well below their lifetime value.',
  edgeRationale: 'Labour-light outbound with AI doing research and copy. The binding constraints are deliverability, reply rates and legal limits on cold outreach (opt-out, consent rules by jurisdiction).',
  knownRisks: ['Deliverability collapse (spam filtering) cuts the funnel at the top', 'Regulation of cold outreach (CAN-SPAM, GDPR/UWG, CASL) — opt-out and lawful basis required', 'Client churn when lead quality disappoints', 'Data-provider terms of service'],
  defaultParams: { honourOptOut: true },
  paramsSchema: z.object({ honourOptOut: z.literal(true) }),
  paramSpace: {},
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: false, walkForward: false, paper: true, monteCarlo: true, requiresRealData: false },
  qualitative: { automation: 70, scalability: 60, operationalSimplicity: 45, recurringRevenue: 75, competition: 30, dependencySafety: 40, dataAvailability: 45, executionSafety: 55, timeToRevenueDays: 45 },
};

export class AiLeadGenModel extends FunnelBusinessModel<LeadGenParams> {
  readonly meta = aiLeadGenMeta;

  defaultAssumptions(): Assumption[] {
    return [
      assumption('leads', 'Raw leads sourced per month', 'leads', 500, 2000, 5000, { stressRole: 'demand' }),
      assumption('qualifiedRate', 'Leads passing AI qualification', 'fraction', 0.2, 0.4, 0.6, { stressRole: 'conversion' }),
      assumption('contactRate', 'Qualified leads reachable (valid, not opted out)', 'fraction', 0.7, 0.9, 0.98, { stressRole: 'conversion' }),
      assumption('replyRate', 'Reply rate', 'fraction', 0.01, 0.03, 0.08, { stressRole: 'conversion' }),
      assumption('meetingRate', 'Replies → meetings', 'fraction', 0.15, 0.3, 0.5, { stressRole: 'conversion' }),
      assumption('closeRate', 'Meetings → retainer clients', 'fraction', 0.1, 0.2, 0.35, { stressRole: 'conversion' }),
      assumption('retainer', 'Client retainer per month', 'USD', 800, 1500, 3000, { stressRole: 'price' }),
      assumption('churn', 'Monthly client churn', 'fraction', 0.05, 0.1, 0.2, { stressRole: 'churn' }),
      assumption('costPerLead', 'Data cost per raw lead', 'USD', 0.05, 0.15, 0.5, { stressRole: 'cost' }),
      assumption('apiCostPerLead', 'AI research/personalisation cost per qualified lead', 'USD', 0.005, 0.02, 0.08, { stressRole: 'cost' }),
      assumption('tools', 'Outreach tools and domains per month', 'USD', 150, 300, 600, { stressRole: 'cost' }),
      assumption('fulfilment', 'Fulfilment cost per client per month', 'USD', 200, 400, 800, { stressRole: 'cost' }),
      assumption('addressable', 'Reachable retainer clients (cap)', 'clients', 100, 300, 1000),
    ];
  }

  discoverMarket(v: AssumptionValues): MarketView {
    return { addressableCustomers: req(v, 'addressable'), description: 'B2B companies buying outsourced lead generation' };
  }

  estimateDemand(v: AssumptionValues, _month: number, fraction: number): number {
    return req(v, 'leads') * fraction;
  }

  calculateConversion(v: AssumptionValues): number[] {
    return [req(v, 'qualifiedRate'), req(v, 'contactRate'), req(v, 'replyRate'), req(v, 'meetingRate'), req(v, 'closeRate')];
  }

  calculateRevenue(v: AssumptionValues, state: BusinessState, _new: number, fraction: number) {
    const mrr = state.customers * req(v, 'retainer');
    return { revenue: mrr * fraction, recurring: mrr };
  }

  estimateCosts(v: AssumptionValues, state: BusinessState, flows: { demand: number; newCustomers: number }, _month: number, fraction: number): CostBreakdown {
    const qualified = flows.demand * req(v, 'qualifiedRate');
    const acquisition = flows.demand * req(v, 'costPerLead');
    const api = qualified * req(v, 'apiCostPerLead');
    const fixed = req(v, 'tools') * fraction;
    const variable = state.customers * req(v, 'fulfilment') * fraction;
    return { fixed, variable, acquisition, api, total: fixed + variable + acquisition + api };
  }
}

export const aiLeadGenModule = createBusinessModule(new AiLeadGenModel());
export const leadGenerationModules: AnyStrategyModule[] = [aiLeadGenModule];

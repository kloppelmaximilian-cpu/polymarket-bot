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

// ─────────────────────────────────────────── AI customer support agent ──

export interface SupportAgentParams {
  includesHumanEscalation: boolean;
}

export const supportAgentMeta: StrategyMeta<SupportAgentParams> = {
  id: 'business.ai-support-agent',
  name: 'AI Customer Support Agent (managed service)',
  kind: 'BUSINESS',
  category: 'CUSTOMER_SERVICE',
  version: '1.0.0',
  description: 'Sets up and runs an AI support agent for small businesses (help-desk integration, knowledge base, escalation) for a setup fee plus a monthly fee; API cost scales with ticket volume.',
  hypothesis: 'SMBs will pay a monthly fee for an AI agent that resolves routine tickets, and the margin after per-ticket API costs and maintenance is high enough to pay back acquisition within a few months.',
  edgeRationale: 'Service + software hybrid: setup work creates switching costs; usage-based API cost is the main variable cost and depends heavily on ticket volume per customer.',
  knownRisks: ['Hallucinated answers harm the client’s customers (liability)', 'Help-desk vendors ship native AI agents', 'Ticket volume per customer can explode API costs', 'Sales cycle longer than assumed'],
  defaultParams: { includesHumanEscalation: true },
  paramsSchema: z.object({ includesHumanEscalation: z.boolean() }),
  paramSpace: {},
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: false, walkForward: false, paper: true, monteCarlo: true, requiresRealData: false },
  qualitative: { automation: 65, scalability: 65, operationalSimplicity: 45, recurringRevenue: 85, competition: 30, dependencySafety: 40, dataAvailability: 35, executionSafety: 60, timeToRevenueDays: 60 },
};

export class SupportAgentModel extends FunnelBusinessModel<SupportAgentParams> {
  readonly meta = supportAgentMeta;

  defaultAssumptions(): Assumption[] {
    return [
      assumption('prospects', 'Qualified prospects reached per month', 'prospects', 100, 400, 1000, { stressRole: 'demand' }),
      assumption('demoRate', 'Prospect → demo', 'fraction', 0.02, 0.06, 0.12, { stressRole: 'conversion' }),
      assumption('closeRate', 'Demo → customer', 'fraction', 0.1, 0.25, 0.4, { stressRole: 'conversion' }),
      assumption('price', 'Monthly fee', 'USD', 200, 400, 1000, { stressRole: 'price' }),
      assumption('setupFee', 'One-time setup fee', 'USD', 0, 500, 1500, { stressRole: 'price' }),
      assumption('churn', 'Monthly churn', 'fraction', 0.02, 0.05, 0.1, { stressRole: 'churn' }),
      assumption('tickets', 'Tickets per customer per month', 'tickets', 300, 1500, 5000, { stressRole: 'cost' }),
      assumption('apiCostPerTicket', 'LLM API cost per ticket', 'USD', 0.005, 0.02, 0.06, { stressRole: 'cost' }),
      assumption('infraPerCustomer', 'Infrastructure per customer per month', 'USD', 5, 20, 50, { stressRole: 'cost' }),
      assumption('maintenanceHours', 'Maintenance hours per customer per month', 'hours', 1, 3, 6, { stressRole: 'cost' }),
      assumption('hourlyCost', 'Cost of an hour of work', 'USD', 25, 40, 80, { stressRole: 'cost' }),
      assumption('acquisitionSpend', 'Sales and marketing spend per month', 'USD', 200, 800, 2000, { stressRole: 'cost' }),
      assumption('fixed', 'Fixed tooling per month', 'USD', 50, 120, 300, { stressRole: 'cost' }),
      assumption('addressable', 'Reachable customers (cap)', 'customers', 100, 400, 2000),
    ];
  }

  discoverMarket(v: AssumptionValues): MarketView {
    return { addressableCustomers: req(v, 'addressable'), description: 'SMBs with steady inbound support volume' };
  }

  estimateDemand(v: AssumptionValues, _month: number, fraction: number): number {
    return req(v, 'prospects') * fraction;
  }

  calculateConversion(v: AssumptionValues): number[] {
    return [req(v, 'demoRate'), req(v, 'closeRate')];
  }

  calculateRevenue(v: AssumptionValues, state: BusinessState, newCustomers: number, fraction: number) {
    const mrr = state.customers * req(v, 'price');
    return { revenue: mrr * fraction + newCustomers * req(v, 'setupFee'), recurring: mrr };
  }

  estimateCosts(v: AssumptionValues, state: BusinessState, _flows: { demand: number; newCustomers: number }, _month: number, fraction: number): CostBreakdown {
    const api = state.customers * req(v, 'tickets') * req(v, 'apiCostPerTicket') * fraction;
    const variable = state.customers * (req(v, 'infraPerCustomer') + req(v, 'maintenanceHours') * req(v, 'hourlyCost')) * fraction;
    const fixed = req(v, 'fixed') * fraction;
    const acquisition = req(v, 'acquisitionSpend') * fraction;
    return { fixed, variable, acquisition, api, total: fixed + variable + acquisition + api };
  }
}

// ──────────────────────────────────────────────────────── AI sales agent ──

export interface SalesAgentParams {
  honourOptOut: true;
}

export const salesAgentMeta: StrategyMeta<SalesAgentParams> = {
  id: 'business.ai-sales-agent',
  name: 'AI Sales Agent (SDR as a service)',
  kind: 'BUSINESS',
  category: 'SALES_AUTOMATION',
  version: '1.0.0',
  description: 'Runs an AI sales development agent for client companies: prospect research, compliant personalised outreach with opt-out handling, reply triage and meeting booking, for a monthly fee per client.',
  hypothesis: 'Companies will pay a monthly fee for AI-run outbound that books meetings, and per-client sending/API/QA costs stay well below that fee.',
  edgeRationale: 'Replaces part of a human SDR at a fraction of the cost. Value depends on deliverability and on legal outreach practices in each client’s market; both can change quickly.',
  knownRisks: ['Email deliverability and sending-domain reputation', 'Cold-outreach regulation (opt-out mandatory; consent requirements differ by country)', 'Client churn if meetings are low quality', 'Inbox providers tightening bulk-sender rules'],
  defaultParams: { honourOptOut: true },
  paramsSchema: z.object({ honourOptOut: z.literal(true) }),
  paramSpace: {},
  defaultRiskLevel: 'MEDIUM',
  capabilities: { backtest: false, walkForward: false, paper: true, monteCarlo: true, requiresRealData: false },
  qualitative: { automation: 75, scalability: 65, operationalSimplicity: 45, recurringRevenue: 80, competition: 25, dependencySafety: 35, dataAvailability: 35, executionSafety: 55, timeToRevenueDays: 60 },
};

export class SalesAgentModel extends FunnelBusinessModel<SalesAgentParams> {
  readonly meta = salesAgentMeta;

  defaultAssumptions(): Assumption[] {
    return [
      assumption('prospects', 'Companies reached per month (own acquisition)', 'companies', 200, 600, 1500, { stressRole: 'demand' }),
      assumption('demoRate', 'Reached → demo', 'fraction', 0.01, 0.04, 0.08, { stressRole: 'conversion' }),
      assumption('closeRate', 'Demo → client', 'fraction', 0.1, 0.2, 0.35, { stressRole: 'conversion' }),
      assumption('price', 'Monthly fee per client', 'USD', 400, 900, 2000, { stressRole: 'price' }),
      assumption('churn', 'Monthly client churn', 'fraction', 0.05, 0.1, 0.2, { stressRole: 'churn' }),
      assumption('emailsPerClient', 'Outreach emails sent per client per month', 'emails', 1000, 3000, 6000, { stressRole: 'cost' }),
      assumption('sendCost', 'Sending infrastructure per email', 'USD', 0.001, 0.004, 0.01, { stressRole: 'cost' }),
      assumption('apiCostPerEmail', 'AI research/personalisation per email', 'USD', 0.001, 0.003, 0.01, { stressRole: 'cost' }),
      assumption('qaHours', 'Human QA hours per client per month', 'hours', 1, 4, 8, { stressRole: 'cost' }),
      assumption('hourlyCost', 'Cost of an hour of work', 'USD', 25, 40, 80, { stressRole: 'cost' }),
      assumption('acquisitionSpend', 'Sales and marketing spend per month', 'USD', 200, 600, 1500, { stressRole: 'cost' }),
      assumption('fixed', 'Fixed tooling per month', 'USD', 100, 250, 500, { stressRole: 'cost' }),
      assumption('addressable', 'Reachable clients (cap)', 'clients', 100, 300, 1500),
    ];
  }

  discoverMarket(v: AssumptionValues): MarketView {
    return { addressableCustomers: req(v, 'addressable'), description: 'B2B companies without a dedicated SDR team' };
  }

  estimateDemand(v: AssumptionValues, _month: number, fraction: number): number {
    return req(v, 'prospects') * fraction;
  }

  calculateConversion(v: AssumptionValues): number[] {
    return [req(v, 'demoRate'), req(v, 'closeRate')];
  }

  calculateRevenue(v: AssumptionValues, state: BusinessState, _new: number, fraction: number) {
    const mrr = state.customers * req(v, 'price');
    return { revenue: mrr * fraction, recurring: mrr };
  }

  estimateCosts(v: AssumptionValues, state: BusinessState, _flows: { demand: number; newCustomers: number }, _month: number, fraction: number): CostBreakdown {
    const emails = state.customers * req(v, 'emailsPerClient') * fraction;
    const api = emails * req(v, 'apiCostPerEmail');
    const variable = emails * req(v, 'sendCost') + state.customers * req(v, 'qaHours') * req(v, 'hourlyCost') * fraction;
    const fixed = req(v, 'fixed') * fraction;
    const acquisition = req(v, 'acquisitionSpend') * fraction;
    return { fixed, variable, acquisition, api, total: fixed + variable + acquisition + api };
  }
}

// ──────────────────────────────────────────── automated digital products ──

export interface DigitalProductsParams {
  channel: 'marketplace';
}

export const digitalProductsMeta: StrategyMeta<DigitalProductsParams> = {
  id: 'business.digital-products',
  name: 'Automated Digital Products',
  kind: 'BUSINESS',
  category: 'DIGITAL_PRODUCTS',
  version: '1.0.0',
  description: 'Produces digital products (templates, guides, prompt packs) with AI assistance and human editing, and sells them on marketplaces; traffic grows with the catalogue.',
  hypothesis: 'A growing catalogue of niche, quality-checked digital products attracts enough marketplace traffic that sales exceed production cost, marketplace fees and refunds.',
  edgeRationale: 'Near-zero marginal cost per sale; the costs are production and discovery. Marketplaces are saturated with low-quality AI content, so quality and niche selection decide the result.',
  knownRisks: ['Marketplace saturation and policy changes on AI-generated content', 'Platform fee changes', 'Copyright/licence issues in source material', 'One-off purchases: no recurring revenue'],
  defaultParams: { channel: 'marketplace' },
  paramsSchema: z.object({ channel: z.literal('marketplace') }),
  paramSpace: {},
  defaultRiskLevel: 'LOW',
  capabilities: { backtest: false, walkForward: false, paper: true, monteCarlo: true, requiresRealData: false },
  qualitative: { automation: 70, scalability: 70, operationalSimplicity: 70, recurringRevenue: 15, competition: 15, dependencySafety: 35, dataAvailability: 50, executionSafety: 80, timeToRevenueDays: 30 },
};

export class DigitalProductsModel extends FunnelBusinessModel<DigitalProductsParams> {
  readonly meta = digitalProductsMeta;

  defaultAssumptions(): Assumption[] {
    return [
      assumption('visitorsPerProduct', 'Marketplace visitors per listed product per month', 'visitors', 20, 80, 300, { stressRole: 'demand' }),
      assumption('newProducts', 'New products per month', 'products', 2, 4, 8),
      assumption('conversion', 'Visitor → purchase', 'fraction', 0.005, 0.015, 0.03, { stressRole: 'conversion' }),
      assumption('price', 'Average price', 'USD', 9, 19, 49, { stressRole: 'price' }),
      assumption('platformFee', 'Marketplace + payment fees', 'fraction', 0.08, 0.12, 0.2, { stressRole: 'cost' }),
      assumption('refundRate', 'Refund rate', 'fraction', 0.01, 0.03, 0.08, { stressRole: 'cost' }),
      assumption('productionCost', 'Production cost per new product (AI + editing)', 'USD', 10, 30, 80, { stressRole: 'cost' }),
      assumption('apiCostPerProduct', 'AI API cost per new product', 'USD', 0.5, 2, 6, { stressRole: 'cost' }),
      assumption('ads', 'Advertising per month', 'USD', 0, 200, 600, { stressRole: 'cost' }),
      assumption('fixed', 'Fixed tools per month', 'USD', 10, 30, 80, { stressRole: 'cost' }),
      assumption('churn', 'Buyers are one-off (every period starts from zero)', 'fraction', 1, 1, 1),
      assumption('addressable', 'Buyers per month (cap)', 'buyers', 1000, 5000, 20000),
    ];
  }

  discoverMarket(v: AssumptionValues): MarketView {
    return { addressableCustomers: req(v, 'addressable'), description: 'Marketplace shoppers in the chosen niches' };
  }

  /** Traffic scales with the catalogue size at the start of the month. */
  estimateDemand(v: AssumptionValues, month: number, fraction: number): number {
    const catalogue = req(v, 'newProducts') * month;
    return catalogue * req(v, 'visitorsPerProduct') * fraction;
  }

  calculateConversion(v: AssumptionValues): number[] {
    return [req(v, 'conversion')];
  }

  calculateRevenue(v: AssumptionValues, _state: BusinessState, newCustomers: number) {
    const gross = newCustomers * req(v, 'price');
    return { revenue: gross * (1 - req(v, 'refundRate')), recurring: 0 };
  }

  estimateCosts(v: AssumptionValues, _state: BusinessState, flows: { demand: number; newCustomers: number }, _month: number, fraction: number): CostBreakdown {
    const gross = flows.newCustomers * req(v, 'price');
    const variable = gross * req(v, 'platformFee');
    const fixed = (req(v, 'fixed') + req(v, 'newProducts') * req(v, 'productionCost')) * fraction;
    const api = req(v, 'newProducts') * req(v, 'apiCostPerProduct') * fraction;
    const acquisition = req(v, 'ads') * fraction;
    return { fixed, variable, acquisition, api, total: fixed + variable + acquisition + api };
  }
}

export const supportAgentModule = createBusinessModule(new SupportAgentModel());
export const salesAgentModule = createBusinessModule(new SalesAgentModel());
export const digitalProductsModule = createBusinessModule(new DigitalProductsModel());
export const businessModules: AnyStrategyModule[] = [supportAgentModule, salesAgentModule, digitalProductsModule];

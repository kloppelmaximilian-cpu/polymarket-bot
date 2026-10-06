import { Rng, normalizeTitle, type Category } from '@aoc/core';
import type { IdeaDraft } from './types';

/**
 * Catalogue-based idea generator. It combines business archetypes with
 * target segments to produce concrete, testable ideas. It invents no facts:
 * every generated idea is HYPOTHETICAL, carries the archetype's known risks,
 * and is mapped to the strategy module that can test it (or to none, in
 * which case it stays a research note until a module exists).
 */

export type IdeaFocus = 'any' | 'low-capital' | 'prediction-markets' | 'ai-agents' | 'trading' | 'business';

export const GENERATOR_PROMPTS: Record<IdeaFocus, string> = {
  any: 'Find new automatable opportunities across all categories.',
  'low-capital': 'Find 10 low-capital automated business models.',
  'prediction-markets': 'Find new prediction-market strategies.',
  'ai-agents': 'Find new AI-agent business opportunities.',
  trading: 'Find new testable quantitative trading strategies.',
  business: 'Find new automated online business models.',
};

interface Archetype {
  key: string;
  focus: IdeaFocus[];
  category: Category;
  template: (segment: string) => string;
  description: (segment: string) => string;
  segments: string[];
  strategyId: string | null;
  capital: number;
  automation: number;
  complexity: number;
  scalability: number;
  testability: number;
  revenueSource: string;
  risks: string[];
  dependencies: string[];
  regulatory: string[];
  overrides?: (segment: string) => IdeaDraft['templateOverrides'];
}

const ARCHETYPES: Archetype[] = [
  {
    key: 'support-agent',
    focus: ['ai-agents', 'business', 'low-capital'],
    category: 'CUSTOMER_SERVICE',
    template: (s) => `AI support agent for ${s}`,
    description: (s) => `A managed AI agent that answers routine customer questions for ${s}, integrated with their help desk and escalating to a human when unsure. Sold as setup fee + monthly fee.`,
    segments: ['dental clinics', 'property managers', 'independent e-commerce stores', 'accounting firms', 'fitness studios', 'veterinary practices', 'language schools'],
    strategyId: 'business.ai-support-agent',
    capital: 1500,
    automation: 65,
    complexity: 55,
    scalability: 65,
    testability: 70,
    revenueSource: 'Setup fee plus monthly subscription per client',
    risks: ['Wrong answers harm the client’s customers', 'Help-desk vendors bundle native AI agents', 'Per-ticket API costs scale with volume'],
    dependencies: ['LLM API provider', 'Client help-desk integration'],
    regulatory: ['Personal data in customer conversations (GDPR/DPA)', 'AI disclosure rules'],
  },
  {
    key: 'booking-agent',
    focus: ['ai-agents', 'business', 'low-capital'],
    category: 'B2B_AUTOMATION',
    template: (s) => `AI appointment-booking assistant for ${s}`,
    description: (s) => `Automates appointment requests, reminders and rescheduling for ${s} across web chat, email and messaging, syncing with the existing calendar.`,
    segments: ['hair salons', 'physiotherapy practices', 'driving schools', 'tutoring centres', 'car repair shops'],
    strategyId: 'business.ai-support-agent',
    capital: 1000,
    automation: 75,
    complexity: 50,
    scalability: 65,
    testability: 70,
    revenueSource: 'Monthly subscription per location',
    risks: ['Booking software vendors add the same feature', 'Integration effort per calendar system', 'No-show economics vary by segment'],
    dependencies: ['Calendar/booking system APIs', 'Messaging channel providers', 'LLM API provider'],
    regulatory: ['Health data for medical practices', 'Messaging consent rules'],
    overrides: () => ({ assumptions: { tickets: { low: 100, mode: 400, high: 1500 }, price: { low: 80, mode: 150, high: 300 } } }),
  },
  {
    key: 'lead-gen',
    focus: ['ai-agents', 'business'],
    category: 'LEAD_GENERATION',
    template: (s) => `AI lead generation for ${s}`,
    description: (s) => `Sources, AI-qualifies and contacts prospects for ${s} with compliant, personalised outreach (opt-out honoured), delivering booked meetings on a retainer.`,
    segments: ['B2B SaaS startups', 'recruiting agencies', 'solar installers', 'logistics brokers', 'IT service providers'],
    strategyId: 'business.ai-lead-generation',
    capital: 2000,
    automation: 70,
    complexity: 60,
    scalability: 60,
    testability: 65,
    revenueSource: 'Monthly retainer per client',
    risks: ['Deliverability collapse', 'Client churn on lead quality', 'Crowded agency market'],
    dependencies: ['Licensed contact data provider', 'Email sending infrastructure', 'LLM API provider'],
    regulatory: ['Cold-outreach consent/opt-out rules by country', 'GDPR lawful basis for prospect data'],
  },
  {
    key: 'sdr',
    focus: ['ai-agents', 'business'],
    category: 'SALES_AUTOMATION',
    template: (s) => `AI SDR service for ${s}`,
    description: (s) => `An AI sales-development agent running researched, compliant outbound and reply triage for ${s}, booking meetings into the client’s calendar.`,
    segments: ['cybersecurity vendors', 'marketing agencies', 'industrial suppliers', 'HR software companies'],
    strategyId: 'business.ai-sales-agent',
    capital: 2000,
    automation: 75,
    complexity: 60,
    scalability: 65,
    testability: 60,
    revenueSource: 'Monthly fee per client',
    risks: ['Inbox providers tightening bulk-sender rules', 'Brand damage for clients from poor messages'],
    dependencies: ['Sending domains and infrastructure', 'CRM integrations', 'LLM API provider'],
    regulatory: ['Cold-outreach rules', 'Data processing agreements'],
  },
  {
    key: 'micro-saas',
    focus: ['business', 'low-capital', 'ai-agents'],
    category: 'MICRO_SAAS',
    template: (s) => `Micro-SaaS: ${s}`,
    description: (s) => `A narrow self-serve AI tool (${s}) sold as a monthly subscription, acquired through search and marketplace listings.`,
    segments: [
      'AI invoice data extraction for freelancers',
      'review-reply assistant for restaurants',
      'product description writer for Shopify merchants',
      'listing description generator for real-estate agents',
      'meeting summary to CRM sync for small sales teams',
      'SEO content brief generator for agencies',
    ],
    strategyId: 'business.ai-saas',
    capital: 800,
    automation: 85,
    complexity: 60,
    scalability: 85,
    testability: 70,
    revenueSource: 'Monthly subscriptions',
    risks: ['Distribution is the bottleneck', 'Easy to copy', 'Platform may ship the feature natively'],
    dependencies: ['LLM API provider', 'Hosting', 'Payment provider', 'Integrations (e.g. Shopify app store)'],
    regulatory: ['Privacy policy and DPA', 'App store/marketplace terms'],
  },
  {
    key: 'digital-products',
    focus: ['business', 'low-capital'],
    category: 'DIGITAL_PRODUCTS',
    template: (s) => `Digital products: ${s}`,
    description: (s) => `A growing catalogue of quality-checked digital products (${s}), produced with AI assistance and human editing, sold on marketplaces.`,
    segments: ['Notion templates for small agencies', 'spreadsheet models for landlords', 'prompt packs for e-commerce copywriting', 'printable planners for teachers', 'onboarding checklists for HR teams'],
    strategyId: 'business.digital-products',
    capital: 300,
    automation: 70,
    complexity: 30,
    scalability: 70,
    testability: 80,
    revenueSource: 'One-off product sales',
    risks: ['Marketplace saturation with low-quality AI content', 'No recurring revenue'],
    dependencies: ['Marketplace platform', 'Payment processing'],
    regulatory: ['Copyright of source material', 'Consumer withdrawal rights for digital goods'],
  },
  {
    key: 'content-affiliate',
    focus: ['business'],
    category: 'AFFILIATE',
    template: (s) => `Affiliate comparison site: ${s}`,
    description: (s) => `An editorial comparison site (${s}) that earns affiliate commissions. Requires genuine testing and disclosure; mass-produced AI pages are a search-ranking and platform-policy risk.`,
    segments: ['B2B software tools for small accountants', 'home-lab networking gear', 'language-learning apps'],
    strategyId: null,
    capital: 500,
    automation: 50,
    complexity: 45,
    scalability: 55,
    testability: 40,
    revenueSource: 'Affiliate commissions',
    risks: ['Search-engine updates against scaled content', 'Affiliate programme terms changes', 'Long time to traffic'],
    dependencies: ['Search traffic', 'Affiliate networks'],
    regulatory: ['Advertising disclosure rules', 'Affiliate programme terms'],
  },
  {
    key: 'funding-carry-alt',
    focus: ['trading'],
    category: 'FUNDING_ARBITRAGE',
    template: (s) => `Funding-rate carry on ${s}`,
    description: (s) => `Cash-and-carry on ${s}: long spot, short perpetual when trailing funding is persistently positive.`,
    segments: ['ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
    strategyId: 'arb.funding-rate',
    capital: 2000,
    automation: 90,
    complexity: 45,
    scalability: 70,
    testability: 90,
    revenueSource: 'Funding payments collected by the short perpetual leg',
    risks: ['Funding turns negative', 'Lower liquidity than BTC', 'Exchange counterparty risk'],
    dependencies: ['Exchange spot and futures APIs'],
    regulatory: ['Derivatives eligibility by jurisdiction'],
    overrides: (s) => ({ params: { symbol: s } }),
  },
  {
    key: 'pm-cross-venue',
    focus: ['prediction-markets'],
    category: 'PREDICTION_MARKET',
    template: (s) => `Prediction markets: ${s}`,
    description: (s) => `${s}. Tested on recorded order books before any paper trading.`,
    segments: [
      'complete-set arbitrage restricted to neg-risk events with 4+ outcomes',
      'quoting only markets resolving in more than 30 days (less adverse selection)',
      'near-resolution favourites limited to markets with an objective data source',
      'imbalance signals filtered to the top 20 markets by volume',
    ],
    strategyId: null,
    capital: 500,
    automation: 85,
    complexity: 55,
    scalability: 35,
    testability: 75,
    revenueSource: 'Trading profits on outcome tokens',
    risks: ['Thin books', 'Resolution disputes', 'Competition from faster bots'],
    dependencies: ['Prediction-market APIs'],
    regulatory: ['Geographic eligibility for prediction markets'],
  },
];

/** Which existing module tests a prediction-market variant. */
function pmStrategyFor(segment: string): string {
  if (segment.startsWith('complete-set')) return 'pm.arbitrage';
  if (segment.startsWith('quoting')) return 'pm.market-making';
  if (segment.startsWith('near-resolution')) return 'pm.near-resolution';
  return 'pm.orderbook-imbalance';
}

export interface GenerateOptions {
  seed: string;
  count: number;
  focus?: IdeaFocus;
  /** Normalised names that already exist; never generated twice. */
  exclude?: Set<string>;
}

export function generateCatalogIdeas(o: GenerateOptions): IdeaDraft[] {
  const rng = new Rng(`ideas/${o.seed}`);
  const focus = o.focus ?? 'any';
  const exclude = o.exclude ?? new Set<string>();
  const candidates: IdeaDraft[] = [];
  for (const a of ARCHETYPES) {
    if (focus !== 'any' && !a.focus.includes(focus)) continue;
    if (focus === 'low-capital' && a.capital > 2000) continue;
    for (const s of a.segments) {
      const name = a.template(s);
      if (exclude.has(normalizeTitle(name))) continue;
      const strategyId = a.key === 'pm-cross-venue' ? pmStrategyFor(s) : a.strategyId;
      candidates.push({
        name,
        category: a.category,
        description: a.description(s),
        origin: 'CATALOG',
        estimatedCapital: a.capital,
        automationScore: a.automation,
        complexityScore: a.complexity,
        scalabilityScore: a.scalability,
        testabilityScore: a.testability,
        revenueSource: a.revenueSource,
        risks: a.risks,
        dependencies: a.dependencies,
        regulatoryRisks: a.regulatory,
        suggestedStrategyId: strategyId,
        templateOverrides: a.overrides?.(s),
        sources: [],
        notes: [
          'Generated from the idea catalogue (hypothetical; no market research has been done yet).',
          strategyId ? `Testable with the ${strategyId} module.` : 'No strategy module can test this yet; it stays a research note.',
        ],
      });
    }
  }
  return rng.shuffle(candidates).slice(0, o.count);
}

export function catalogSize(): number {
  return ARCHETYPES.reduce((a, x) => a + x.segments.length, 0);
}

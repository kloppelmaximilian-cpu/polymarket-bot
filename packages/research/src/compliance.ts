import type { Category, ComplianceEntry, ComplianceItem } from '@aoc/core';

/**
 * Default compliance checklist per category. Every item starts UNREVIEWED:
 * the platform never asserts that something is legal. The notes say what to
 * check. A BLOCKER (set by a human) stops the experiment; live review needs
 * every item OK or NOT_APPLICABLE.
 */
const NOTES: Partial<Record<Category | 'DEFAULT', Partial<Record<ComplianceItem, string>>>> = {
  PREDICTION_MARKET: {
    TERMS_OF_SERVICE: 'Read the venue terms: geographic eligibility, prohibited jurisdictions, automated trading rules.',
    API_TERMS: 'Use only documented public endpoints; respect rate limits; no circumvention of access restrictions.',
    REGULATORY: 'Event contracts are regulated differently by jurisdiction; confirm that participation is lawful where you are.',
    DATA_RIGHTS: 'Check whether recorded market data may be stored and used for research.',
  },
  CRYPTO_TRADING: {
    TERMS_OF_SERVICE: 'Exchange terms: account eligibility, KYC, API usage policy.',
    API_TERMS: 'Respect request-weight limits; market-data endpoints only in paper mode.',
    REGULATORY: 'Trading for others, managing third-party money or offering signals can require a licence; tax reporting applies to real trading.',
  },
  ARBITRAGE: {
    TERMS_OF_SERVICE: 'Exchange terms on transfers, withdrawal limits and multiple accounts.',
    REGULATORY: 'Moving funds across venues/jurisdictions may trigger reporting duties.',
    API_TERMS: 'Respect rate limits on every venue.',
  },
  FUNDING_ARBITRAGE: {
    TERMS_OF_SERVICE: 'Derivatives access is restricted in many jurisdictions; confirm eligibility for perpetual futures.',
    REGULATORY: 'Leveraged derivatives are regulated products in many countries.',
  },
  MARKET_MAKING: {
    TERMS_OF_SERVICE: 'Check venue rules on quoting behaviour, self-trading and order-to-trade ratios.',
    REGULATORY: 'Market manipulation rules apply to quoting (no spoofing/layering).',
  },
  LEAD_GENERATION: {
    SPAM_RULES: 'Unsolicited commercial email rules differ by country (e.g. US CAN-SPAM requires an opt-out; Germany’s UWG § 7 generally requires prior consent for advertising email). Every message needs a working opt-out that is honoured.',
    DATA_RIGHTS: 'GDPR: a lawful basis is required to process personal data of EU contacts; check the data provider’s licence.',
    PLATFORM_RULES: 'Scraping platforms such as LinkedIn is prohibited by their terms; use licensed data.',
    TERMS_OF_SERVICE: 'Email/sending providers’ acceptable-use policies on cold outreach.',
  },
  SALES_AUTOMATION: {
    SPAM_RULES: 'Same rules as lead generation, applied to every client campaign; keep a suppression list across clients.',
    DATA_RIGHTS: 'Data processing agreements with each client; GDPR roles (controller/processor).',
    PLATFORM_RULES: 'Inbox providers’ bulk-sender requirements (authentication, one-click unsubscribe, complaint rates).',
  },
  CUSTOMER_SERVICE: {
    DATA_RIGHTS: 'Customer conversations contain personal data: DPA with clients, retention limits, sub-processor list (LLM provider).',
    API_TERMS: 'LLM provider usage policies; disclose AI use where required.',
    REGULATORY: 'Consumer-protection and AI transparency rules in the client’s market.',
  },
  AI_SAAS: {
    DATA_RIGHTS: 'Privacy policy, DPA, data residency of the LLM provider.',
    API_TERMS: 'LLM provider usage policy and pricing changes.',
    LICENSE: 'Licences of every dependency and model used.',
  },
  DIGITAL_PRODUCTS: {
    LICENSE: 'Copyright of source material and of AI-generated content; licence granted to buyers.',
    PLATFORM_RULES: 'Marketplace policies on AI-generated products and disclosure.',
    REGULATORY: 'Consumer law: refunds and withdrawal rights for digital goods.',
  },
  DEFAULT: {
    TERMS_OF_SERVICE: 'Check the terms of every platform the idea depends on.',
    REGULATORY: 'Check whether the activity needs a licence or registration.',
  },
};

export function defaultCompliance(category: Category): ComplianceEntry[] {
  const notes = NOTES[category] ?? NOTES.DEFAULT!;
  return (Object.entries(notes) as Array<[ComplianceItem, string]>).map(([item, note]) => ({ item, state: 'UNREVIEWED', note, reviewedAt: null, reviewer: null }));
}

export function complianceSummary(entries: ComplianceEntry[]): { unreviewed: number; concerns: number; blockers: number; ok: number } {
  return {
    unreviewed: entries.filter((e) => e.state === 'UNREVIEWED').length,
    concerns: entries.filter((e) => e.state === 'CONCERN').length,
    blockers: entries.filter((e) => e.state === 'BLOCKER').length,
    ok: entries.filter((e) => e.state === 'OK' || e.state === 'NOT_APPLICABLE').length,
  };
}

/** License classes for open-source research: inspiration vs. reusable code. */
export function licenseConcern(spdx: string | null | undefined): string {
  if (!spdx || spdx === 'NOASSERTION' || spdx === 'NONE') return 'No license declared: all rights reserved. Use only as conceptual inspiration; do not copy code.';
  if (/^(AGPL|GPL|LGPL)/i.test(spdx)) return `${spdx} is copyleft: copying code would impose its terms on this project. Use as conceptual inspiration only.`;
  if (/^(MIT|Apache-2\.0|BSD|ISC|MPL-2\.0|0BSD|Unlicense)/i.test(spdx)) return `${spdx} is permissive, but this platform still implements ideas independently and does not copy unreviewed code.`;
  return `${spdx}: review the licence text before reusing anything.`;
}

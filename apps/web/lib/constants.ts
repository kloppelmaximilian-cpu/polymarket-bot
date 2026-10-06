/**
 * Enum values used by filters and forms. Copies of the core enums (the web
 * bundle stays free of server packages); the type checks below fail the build
 * if one of them drifts from @aoc/core.
 */
import type { Category, ComplianceItem, ComplianceState, ExperimentStatus, IdeaStatus, RiskLevel, SourceType, StrategyKind } from '@aoc/core';
import type { JobName } from '@aoc/platform';

export const STATUSES = ['DISCOVERED', 'RESEARCHING', 'PROTOTYPE', 'BACKTESTING', 'EVALUATING', 'PAPER', 'PROBATION', 'PROMISING', 'READY_FOR_LIVE_REVIEW', 'PAUSED', 'FAILED', 'ARCHIVED'] as const;
export const CATEGORIES = [
  'CRYPTO_TRADING',
  'FOREX_TRADING',
  'EQUITY_TRADING',
  'ARBITRAGE',
  'FUNDING_ARBITRAGE',
  'PREDICTION_MARKET',
  'MARKET_MAKING',
  'AI_SAAS',
  'MICRO_SAAS',
  'AI_AGENT_SERVICE',
  'B2B_AUTOMATION',
  'LEAD_GENERATION',
  'SALES_AUTOMATION',
  'CUSTOMER_SERVICE',
  'CONTENT_AUTOMATION',
  'AFFILIATE',
  'DIGITAL_PRODUCTS',
  'E_COMMERCE',
  'EXPERIMENTAL',
] as const;
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] as const;
export const KINDS = ['TRADING', 'PREDICTION_MARKET', 'ARBITRAGE', 'BUSINESS'] as const;
export const COMPLIANCE_ITEMS = ['TERMS_OF_SERVICE', 'API_TERMS', 'LICENSE', 'DATA_RIGHTS', 'SPAM_RULES', 'PLATFORM_RULES', 'REGULATORY'] as const;
export const COMPLIANCE_STATES = ['UNREVIEWED', 'OK', 'CONCERN', 'BLOCKER', 'NOT_APPLICABLE'] as const;
export const SOURCE_TYPES = ['GITHUB', 'PAPER', 'API_DOCS', 'BLOG', 'MARKET_REPORT', 'WEBSITE', 'REGULATION', 'NEWS', 'INTERNAL'] as const;
export const IDEA_STATUSES = ['NEW', 'TRIAGED', 'CONVERTED', 'REJECTED', 'DUPLICATE'] as const;
export const IDEA_FOCUS = ['any', 'low-capital', 'prediction-markets', 'ai-agents', 'trading', 'business'] as const;
export const JOB_NAMES = ['pipeline.advance', 'paper.tick', 'risk.monitor', 'scores.recompute', 'data.health', 'research.monitor', 'ideas.generate', 'lab.run', 'maintenance.prune', 'notifications.deliver'] as const;

// Exhaustiveness: each of these is `true` only when the two sets are equal.
type Same<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : false;
const checks: [
  Same<(typeof STATUSES)[number], ExperimentStatus>,
  Same<(typeof CATEGORIES)[number], Category>,
  Same<(typeof RISK_LEVELS)[number], RiskLevel>,
  Same<(typeof KINDS)[number], StrategyKind>,
  Same<(typeof COMPLIANCE_ITEMS)[number], ComplianceItem>,
  Same<(typeof COMPLIANCE_STATES)[number], ComplianceState>,
  Same<(typeof SOURCE_TYPES)[number], SourceType>,
  Same<(typeof IDEA_STATUSES)[number], IdeaStatus>,
  Same<(typeof JOB_NAMES)[number], JobName>,
] = [true, true, true, true, true, true, true, true, true];
void checks;

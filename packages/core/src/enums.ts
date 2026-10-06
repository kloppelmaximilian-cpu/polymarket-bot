/**
 * Shared vocabulary of the platform. Every value here is persisted, so the
 * string literals are part of the database contract: add values, never rename.
 */

export const EXPERIMENT_STATUSES = [
  'DISCOVERED',
  'RESEARCHING',
  'PROTOTYPE',
  'BACKTESTING',
  'PAPER',
  'EVALUATING',
  'PROMISING',
  'PROBATION',
  'FAILED',
  'PAUSED',
  'ARCHIVED',
  'READY_FOR_LIVE_REVIEW',
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** Statuses in which the pipeline keeps working on an experiment. */
export const ACTIVE_STATUSES: readonly ExperimentStatus[] = [
  'RESEARCHING',
  'PROTOTYPE',
  'BACKTESTING',
  'PAPER',
  'EVALUATING',
  'PROBATION',
];

/**
 * Where a number came from. The UI must show this next to every result so
 * that a simulated or estimated figure is never mistaken for an observed one.
 */
export const PROVENANCES = [
  'HISTORICAL', // simulated trades on real, observed historical market data
  'SIMULATED', // model simulation (e.g. synthetic market or agent-based)
  'PAPER', // forward test on live data with virtual money
  'ESTIMATED', // assumption-driven estimate (business models)
  'HYPOTHETICAL', // idea-level guess, nothing has been run
  'DEMO', // demonstration data, never a real result
] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Evidence strength used for score confidence. Higher is stronger. */
export const EVIDENCE_RANK: Record<Provenance, number> = {
  DEMO: 0,
  HYPOTHETICAL: 1,
  ESTIMATED: 2,
  SIMULATED: 3,
  HISTORICAL: 4,
  PAPER: 5,
};

export const STRATEGY_KINDS = ['TRADING', 'PREDICTION_MARKET', 'ARBITRAGE', 'BUSINESS'] as const;
export type StrategyKind = (typeof STRATEGY_KINDS)[number];

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
export type Category = (typeof CATEGORIES)[number];

export const FINANCE_CATEGORIES: readonly Category[] = [
  'CRYPTO_TRADING',
  'FOREX_TRADING',
  'EQUITY_TRADING',
  'ARBITRAGE',
  'FUNDING_ARBITRAGE',
  'PREDICTION_MARKET',
  'MARKET_MAKING',
];

export const RUN_TYPES = [
  'RESEARCH',
  'SIMULATION',
  'BACKTEST',
  'WALK_FORWARD',
  'MONTE_CARLO',
  'SENSITIVITY',
  'PAPER',
  'EVALUATION',
  'LAB',
] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const DATA_HEALTH = ['CONNECTED', 'STALE', 'DEGRADED', 'OFFLINE'] as const;
export type DataHealth = (typeof DATA_HEALTH)[number];

export const COMPONENT_HEALTH = ['ONLINE', 'DEGRADED', 'OFFLINE'] as const;
export type ComponentHealth = (typeof COMPONENT_HEALTH)[number];

export const FAILURE_REASONS = [
  'NEGATIVE_EV',
  'EXCESSIVE_RISK',
  'HIGH_DRAWDOWN',
  'NO_DATA',
  'UNRELIABLE_EXECUTION',
  'HIGH_COST',
  'LOW_SCALABILITY',
  'NO_EDGE',
  'OVERFITTING',
  'COMPLIANCE_BLOCKER',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const TRADING_MODES = ['paper', 'live'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export const IDEA_STATUSES = ['NEW', 'TRIAGED', 'CONVERTED', 'REJECTED', 'DUPLICATE'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const IDEA_ORIGINS = ['CATALOG', 'LLM', 'MONITOR', 'MANUAL', 'SEED'] as const;
export type IdeaOrigin = (typeof IDEA_ORIGINS)[number];

export const SOURCE_TYPES = [
  'GITHUB',
  'PAPER',
  'API_DOCS',
  'BLOG',
  'MARKET_REPORT',
  'WEBSITE',
  'REGULATION',
  'NEWS',
  'INTERNAL',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const MONITOR_CATEGORIES = [
  'NEW_IDEA',
  'NEW_API',
  'NEW_MARKET',
  'NEW_STRATEGY',
  'NEW_OPEN_SOURCE_PROJECT',
  'NEW_RESEARCH',
] as const;
export type MonitorCategory = (typeof MONITOR_CATEGORIES)[number];

export const COMPLIANCE_ITEMS = [
  'TERMS_OF_SERVICE',
  'API_TERMS',
  'LICENSE',
  'DATA_RIGHTS',
  'SPAM_RULES',
  'PLATFORM_RULES',
  'REGULATORY',
] as const;
export type ComplianceItem = (typeof COMPLIANCE_ITEMS)[number];

export const COMPLIANCE_STATES = ['UNREVIEWED', 'OK', 'CONCERN', 'BLOCKER', 'NOT_APPLICABLE'] as const;
export type ComplianceState = (typeof COMPLIANCE_STATES)[number];

export const NOTIFICATION_TYPES = [
  'EXPERIMENT_STARTED',
  'EXPERIMENT_FINISHED',
  'IDEA_DISCOVERED',
  'STRATEGY_IMPROVED',
  'RISK_LIMIT_REACHED',
  'SYSTEM_ERROR',
  'PAPER_MILESTONE',
  'EXPERIMENT_FAILED',
  'READY_FOR_LIVE_REVIEW',
  'EMERGENCY_STOP',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const AUDIT_ACTIONS = [
  'EXPERIMENT_CREATED',
  'EXPERIMENT_UPDATED',
  'EXPERIMENT_STATUS_CHANGED',
  'VERSION_CREATED',
  'STRATEGY_STARTED',
  'STRATEGY_STOPPED',
  'PARAMETER_CHANGED',
  'PAPER_ACCOUNT_CREATED',
  'PAPER_ORDER_CREATED',
  'PAPER_ORDER_FILLED',
  'PAPER_ORDER_REJECTED',
  'PAPER_ORDER_CANCELLED',
  'RESEARCH_ADDED',
  'IDEA_ADDED',
  'IDEA_CONVERTED',
  'SCORE_CHANGED',
  'RISK_LIMIT_TRIGGERED',
  'RISK_LIMITS_CHANGED',
  'EMERGENCY_STOP_ENGAGED',
  'EMERGENCY_STOP_RELEASED',
  'SETTINGS_CHANGED',
  'COMPLIANCE_UPDATED',
  'LIVE_REVIEW_REQUESTED',
  'ERROR_OCCURRED',
  'SEED_LOADED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'WORKER', 'API'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

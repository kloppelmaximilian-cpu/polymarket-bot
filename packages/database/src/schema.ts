import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Database contract of the Automated Opportunity Center.
 *
 * Conventions
 *  - Money: numeric(30,10), read and written as strings, computed with Decimal.
 *  - Market data and statistics: double precision (they are measurements).
 *  - Time: timestamptz. Market bars use epoch milliseconds (bigint) because
 *    they are joined and range-scanned by the backtester.
 *  - Enum-like columns are text; the allowed values live in @aoc/core/enums.
 *  - Change only through migrations (`pnpm db:generate`).
 */

const money = (name: string) => numeric(name, { precision: 30, scale: 10 });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ─────────────────────────────────────────────────────────────── identity ──

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').notNull().default('OWNER'),
  createdAt: createdAt(),
});

// ───────────────────────────────────────────────────────────── strategies ──

/** Code modules that implement a strategy or business model. */
export const strategies = pgTable('strategies', {
  id: text('id').primaryKey(), // e.g. "trading.momentum"
  name: text('name').notNull(),
  kind: text('kind').notNull(), // StrategyKind
  category: text('category').notNull(),
  moduleVersion: text('module_version').notNull(),
  description: text('description').notNull(),
  paramsSchema: jsonb('params_schema').notNull().default({}),
  defaultParams: jsonb('default_params').notNull().default({}),
  requiredData: jsonb('required_data').$type<string[]>().notNull().default([]),
  capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ──────────────────────────────────────────────────────── research & ideas ──

export const researchSources = pgTable(
  'research_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceType: text('source_type').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    author: text('author'),
    repository: text('repository'),
    foundAt: timestamp('found_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    summary: text('summary').notNull().default(''),
    relevantConcept: text('relevant_concept').notNull().default(''),
    advantages: jsonb('advantages').$type<string[]>().notNull().default([]),
    disadvantages: jsonb('disadvantages').$type<string[]>().notNull().default([]),
    risk: text('risk').notNull().default(''),
    implementationIdea: text('implementation_idea').notNull().default(''),
    license: text('license'),
    termsConcerns: text('terms_concerns').notNull().default(''),
    github: jsonb('github').$type<{
      stars?: number | null;
      forks?: number | null;
      openIssues?: number | null;
      lastPush?: string | null;
      archived?: boolean | null;
      language?: string | null;
      topics?: string[];
    } | null>(),
    architecture: text('architecture').notNull().default(''),
    knownLimitations: text('known_limitations').notNull().default(''),
    monitorCategory: text('monitor_category'),
    relevance: real('relevance'),
    origin: text('origin').notNull().default('MANUAL'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('research_sources_url_uq').on(t.url), index('research_sources_found_idx').on(t.foundAt)],
);

export const ideas = pgTable(
  'ideas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    category: text('category').notNull(),
    description: text('description').notNull(),
    origin: text('origin').notNull(), // IdeaOrigin
    status: text('status').notNull().default('NEW'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    estimatedCapital: money('estimated_capital'),
    automationScore: integer('automation_score'),
    complexityScore: integer('complexity_score'),
    scalabilityScore: integer('scalability_score'),
    testabilityScore: integer('testability_score'),
    revenueSource: text('revenue_source').notNull().default(''),
    risks: jsonb('risks').$type<string[]>().notNull().default([]),
    dependencies: jsonb('dependencies').$type<string[]>().notNull().default([]),
    regulatoryRisks: jsonb('regulatory_risks').$type<string[]>().notNull().default([]),
    assessment: jsonb('assessment').$type<Record<string, unknown>>().notNull().default({}),
    suggestedStrategyId: text('suggested_strategy_id').references(() => strategies.id),
    experimentId: uuid('experiment_id'),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ideas_normalized_name_uq').on(t.normalizedName), index('ideas_status_idx').on(t.status)],
);

export const ideaSources = pgTable(
  'idea_sources',
  {
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => researchSources.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.ideaId, t.sourceId] })],
);

// ──────────────────────────────────────────────────────────── experiments ──

export const experiments = pgTable(
  'experiments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    strategyId: text('strategy_id')
      .notNull()
      .references(() => strategies.id),
    ideaId: uuid('idea_id').references(() => ideas.id),
    name: text('name').notNull(),
    /** Base of every random seed for this experiment: re-running a version reproduces its results. */
    seed: text('seed').notNull(),
    category: text('category').notNull(),
    kind: text('kind').notNull(),
    description: text('description').notNull(),
    hypothesis: text('hypothesis').notNull(),
    assumptions: jsonb('assumptions').$type<unknown[]>().notNull().default([]),
    requiredData: jsonb('required_data').$type<string[]>().notNull().default([]),
    capitalRequirement: money('capital_requirement').notNull().default('0'),
    estimatedCost: money('estimated_cost').notNull().default('0'),
    riskLevel: text('risk_level').notNull().default('MEDIUM'),
    automationScore: integer('automation_score').notNull().default(50),
    scalabilityScore: integer('scalability_score').notNull().default(50),
    complexityScore: integer('complexity_score').notNull().default(50),
    expectedTimeToRevenueDays: integer('expected_time_to_revenue_days'),
    qualitative: jsonb('qualitative').$type<Record<string, number>>().notNull().default({}),
    status: text('status').notNull().default('DISCOVERED'),
    statusReason: text('status_reason'),
    failureReasons: jsonb('failure_reasons').$type<string[]>().notNull().default([]),
    currentVersionId: uuid('current_version_id'),
    riskLimits: jsonb('risk_limits').$type<Record<string, number>>().notNull(),
    compliance: jsonb('compliance').$type<unknown[]>().notNull().default([]),
    paperCapital: money('paper_capital').notNull().default('0'),
    isDemo: boolean('is_demo').notNull().default(false),
    statusBeforePause: text('status_before_pause'),
    probationCount: integer('probation_count').notNull().default(0),
    paperStartedAt: timestamp('paper_started_at', { withTimezone: true }),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    /** Latest gate results and evidence used for the last status decision. */
    evaluation: jsonb('evaluation').$type<Record<string, unknown>>().notNull().default({}),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('experiments_slug_uq').on(t.slug),
    index('experiments_status_idx').on(t.status),
    index('experiments_category_idx').on(t.category),
  ],
);

export const experimentSources = pgTable(
  'experiment_sources',
  {
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => researchSources.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.experimentId, t.sourceId] })],
);

/** Immutable parameter sets. A parameter change is a new row, never an update. */
export const experimentVersions = pgTable(
  'experiment_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    label: text('label').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    /** Assumption set the version is evaluated under (immutable like params). */
    assumptions: jsonb('assumptions').$type<unknown[]>().notNull().default([]),
    strategyModuleVersion: text('strategy_module_version').notNull(),
    parentVersionId: uuid('parent_version_id'),
    createdBy: text('created_by').notNull().default('SYSTEM'),
    changeNote: text('change_note').notNull().default(''),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | CANDIDATE | SUPERSEDED | REJECTED
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('experiment_versions_seq_uq').on(t.experimentId, t.seq),
    uniqueIndex('experiment_versions_label_uq').on(t.experimentId, t.label),
  ],
);

export const strategyRuns = pgTable(
  'strategy_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => experimentVersions.id),
    runType: text('run_type').notNull(),
    provenance: text('provenance').notNull(),
    status: text('status').notNull().default('QUEUED'),
    datasetId: uuid('dataset_id'),
    seed: text('seed'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    idempotencyKey: text('idempotency_key'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('strategy_runs_experiment_idx').on(t.experimentId, t.createdAt),
    uniqueIndex('strategy_runs_idempotency_uq').on(t.idempotencyKey),
  ],
);

// ─────────────────────────────────────────────────────────────────── data ──

export const dataSources = pgTable('data_sources', {
  id: text('id').primaryKey(), // e.g. "binance.spot.rest"
  name: text('name').notNull(),
  kind: text('kind').notNull(), // MARKET_DATA | RESEARCH | LLM
  transport: text('transport').notNull(), // REST | WEBSOCKET
  status: text('status').notNull().default('OFFLINE'),
  enabled: boolean('enabled').notNull().default(true),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  latencyMs: integer('latency_ms'),
  staleAfterMs: integer('stale_after_ms').notNull().default(120000),
  successCount: bigint('success_count', { mode: 'number' }).notNull().default(0),
  errorCount: bigint('error_count', { mode: 'number' }).notNull().default(0),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    kind: text('kind').notNull(), // BARS | FUNDING | QUOTES | BOOKS
    symbol: text('symbol').notNull(),
    interval: text('interval'),
    startTs: bigint('start_ts', { mode: 'number' }).notNull(),
    endTs: bigint('end_ts', { mode: 'number' }).notNull(),
    rowCount: integer('row_count').notNull(),
    provenance: text('provenance').notNull(), // HISTORICAL | DEMO
    checksum: text('checksum').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('datasets_checksum_uq').on(t.source, t.kind, t.symbol, t.checksum)],
);

export const marketBars = pgTable(
  'market_bars',
  {
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    open: doublePrecision('open').notNull(),
    high: doublePrecision('high').notNull(),
    low: doublePrecision('low').notNull(),
    close: doublePrecision('close').notNull(),
    volume: doublePrecision('volume').notNull(),
  },
  (t) => [primaryKey({ columns: [t.datasetId, t.ts] })],
);

/** Generic time series rows for non-bar datasets (funding rates, spreads). */
export const datasetPoints = pgTable(
  'dataset_points',
  {
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.datasetId, t.ts] })],
);

export const dataSnapshots = pgTable(
  'data_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sourceId: text('source_id').notNull(),
    kind: text('kind').notNull(), // QUOTE | BOOK | FUNDING | MARKETS
    symbol: text('symbol').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('data_snapshots_lookup_idx').on(t.sourceId, t.symbol, t.receivedAt)],
);

// ──────────────────────────────────────────────────────────── paper money ──

export const paperAccounts = pgTable(
  'paper_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => experimentVersions.id),
    name: text('name').notNull(),
    baseCurrency: text('base_currency').notNull().default('USD'),
    startingCapital: money('starting_capital').notNull(),
    cash: money('cash').notNull(),
    realizedPnl: money('realized_pnl').notNull().default('0'),
    feesPaid: money('fees_paid').notNull().default('0'),
    slippageCost: money('slippage_cost').notNull().default('0'),
    fundingPnl: money('funding_pnl').notNull().default('0'),
    operatingPnl: money('operating_pnl').notNull().default('0'),
    peakEquity: money('peak_equity').notNull(),
    dayKey: text('day_key').notNull(),
    dayStartEquity: money('day_start_equity').notNull(),
    ordersToday: integer('orders_today').notNull().default(0),
    spendTotal: money('spend_total').notNull().default('0'),
    apiSpendTotal: money('api_spend_total').notNull().default('0'),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | FROZEN | CLOSED
    ledgerSeq: integer('ledger_seq').notNull().default(0),
    lockVersion: integer('lock_version').notNull().default(0),
    /** PAPER for live-data paper trading, SIMULATED for business operating simulations. */
    provenance: text('provenance').notNull().default('PAPER'),
    strategyState: jsonb('strategy_state').$type<Record<string, unknown>>().notNull().default({}),
    simulatedDays: integer('simulated_days').notNull().default(0),
    lastTickAt: timestamp('last_tick_at', { withTimezone: true }),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('paper_accounts_experiment_idx').on(t.experimentId),
    uniqueIndex('paper_accounts_active_uq').on(t.experimentId).where(sql`status = 'ACTIVE'`),
  ],
);

export const paperOrders = pgTable(
  'paper_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    clientOrderId: text('client_order_id').notNull(),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    instrumentKind: text('instrument_kind').notNull(), // SPOT | PERP | OUTCOME
    /** Full instrument (fee model, tick size) so open orders can be restored exactly. */
    instrument: jsonb('instrument').$type<Record<string, unknown>>().notNull(),
    side: text('side').notNull(), // BUY | SELL
    type: text('type').notNull(), // MARKET | LIMIT
    quantity: money('quantity').notNull(),
    limitPrice: money('limit_price'),
    status: text('status').notNull(),
    filledQuantity: money('filled_quantity').notNull().default('0'),
    avgFillPrice: money('avg_fill_price'),
    reserved: money('reserved').notNull().default('0'),
    rejectReason: text('reject_reason'),
    reduceOnly: boolean('reduce_only').notNull().default(false),
    postOnly: boolean('post_only').notNull().default(false),
    reason: text('reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('paper_orders_client_id_uq').on(t.accountId, t.clientOrderId),
    index('paper_orders_account_idx').on(t.accountId, t.createdAt),
  ],
);

export const paperFills = pgTable(
  'paper_fills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => paperOrders.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    quantity: money('quantity').notNull(),
    price: money('price').notNull(),
    fee: money('fee').notNull(),
    slippageCost: money('slippage_cost').notNull(),
    liquidity: text('liquidity').notNull(), // MAKER | TAKER
    realizedPnl: money('realized_pnl').notNull().default('0'),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('paper_fills_account_idx').on(t.accountId, t.ts)],
);

export const paperPositions = pgTable(
  'paper_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    instrumentKind: text('instrument_kind').notNull(),
    quantity: money('quantity').notNull(),
    avgPrice: money('avg_price').notNull(),
    realizedPnl: money('realized_pnl').notNull().default('0'),
    markPrice: money('mark_price'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('paper_positions_instrument_uq').on(t.accountId, t.venue, t.symbol)],
);

/** The cash ledger. For every account: cash == sum(amount). */
export const paperTransactions = pgTable(
  'paper_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    amount: money('amount').notNull(),
    balanceAfter: money('balance_after').notNull(),
    category: text('category'),
    description: text('description').notNull().default(''),
    refOrderId: uuid('ref_order_id'),
    refFillId: uuid('ref_fill_id'),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('paper_transactions_seq_uq').on(t.accountId, t.seq)],
);

export const performanceSnapshots = pgTable(
  'performance_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    equity: money('equity').notNull(),
    cash: money('cash').notNull(),
    realizedPnl: money('realized_pnl').notNull(),
    unrealizedPnl: money('unrealized_pnl').notNull(),
    fees: money('fees').notNull(),
    exposure: money('exposure').notNull(),
    drawdownPct: doublePrecision('drawdown_pct').notNull(),
    provenance: text('provenance').notNull(),
  },
  (t) => [index('performance_snapshots_account_idx').on(t.accountId, t.ts)],
);

// ─────────────────────────────────────────────────────── metrics & scores ──

export const metrics = pgTable(
  'metrics',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id'),
    runId: uuid('run_id'),
    name: text('name').notNull(),
    value: doublePrecision('value'),
    unit: text('unit'),
    provenance: text('provenance').notNull(),
    period: text('period'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('metrics_experiment_idx').on(t.experimentId, t.name, t.recordedAt)],
);

export const scores = pgTable(
  'scores',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id'),
    overall: real('overall').notNull(),
    components: jsonb('components').$type<Record<string, number | null>>().notNull(),
    confidence: text('confidence').notNull(),
    evidence: text('evidence').notNull(),
    rank: integer('rank'),
    explanation: jsonb('explanation').$type<Record<string, unknown>>().notNull().default({}),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('scores_experiment_idx').on(t.experimentId, t.computedAt)],
);

// ──────────────────────────────────────────────────────── risk & ops logs ──

export const riskEvents = pgTable(
  'risk_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    experimentId: uuid('experiment_id').references(() => experiments.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id'),
    limitName: text('limit_name').notNull(),
    severity: text('severity').notNull(), // INFO | WARNING | BREACH | CRITICAL
    message: text('message').notNull(),
    value: doublePrecision('value'),
    threshold: doublePrecision('threshold'),
    action: text('action').notNull(), // NONE | REJECT_ORDER | STOP_EXPERIMENT | EMERGENCY_STOP
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('risk_events_created_idx').on(t.createdAt)],
);

export const systemEvents = pgTable(
  'system_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    level: text('level').notNull(), // INFO | WARN | ERROR
    component: text('component').notNull(),
    eventType: text('event_type').notNull(),
    message: text('message').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    experimentId: uuid('experiment_id'),
    createdAt: createdAt(),
  },
  (t) => [index('system_events_created_idx').on(t.createdAt), index('system_events_component_idx').on(t.component, t.createdAt)],
);

/** Append-only (enforced by trigger in migration 0001). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    experimentId: uuid('experiment_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    requestId: text('request_id'),
  },
  (t) => [index('audit_logs_ts_idx').on(t.ts), index('audit_logs_experiment_idx').on(t.experimentId, t.ts)],
);

// ─────────────────────────────────────────────────────────────────── jobs ──

export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('QUEUED'), // QUEUED | RUNNING | SUCCEEDED | FAILED | DEAD | CANCELLED
    priority: integer('priority').notNull().default(100),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastError: text('last_error'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('job_runs_dedupe_uq').on(t.dedupeKey),
    index('job_runs_claim_idx').on(t.status, t.runAt, t.priority),
    index('job_runs_name_idx').on(t.name, t.createdAt),
  ],
);

export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  hostname: text('hostname').notNull(),
  pid: integer('pid').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  status: text('status').notNull(), // RUNNING | STOPPING | STOPPED
  jobsProcessed: integer('jobs_processed').notNull().default(0),
  jobsFailed: integer('jobs_failed').notNull().default(0),
  currentJob: text('current_job'),
});

// ───────────────────────────────────────────────── notifications & config ──

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('INFO'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    experimentId: uuid('experiment_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    deliveryStatus: text('delivery_status').notNull().default('SKIPPED'),
    deliveryError: text('delivery_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt)],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
  updatedBy: text('updated_by').notNull().default('SYSTEM'),
});

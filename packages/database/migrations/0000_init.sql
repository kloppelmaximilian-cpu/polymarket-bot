CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"experiment_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "data_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"symbol" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"transport" text NOT NULL,
	"status" text DEFAULT 'OFFLINE' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"stale_after_ms" integer DEFAULT 120000 NOT NULL,
	"success_count" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_points" (
	"dataset_id" uuid NOT NULL,
	"ts" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "dataset_points_dataset_id_ts_pk" PRIMARY KEY("dataset_id","ts")
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"symbol" text NOT NULL,
	"interval" text,
	"start_ts" bigint NOT NULL,
	"end_ts" bigint NOT NULL,
	"row_count" integer NOT NULL,
	"provenance" text NOT NULL,
	"checksum" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_sources" (
	"experiment_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "experiment_sources_experiment_id_source_id_pk" PRIMARY KEY("experiment_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "experiment_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"label" text NOT NULL,
	"params" jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strategy_module_version" text NOT NULL,
	"parent_version_id" uuid,
	"created_by" text DEFAULT 'SYSTEM' NOT NULL,
	"change_note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"strategy_id" text NOT NULL,
	"idea_id" uuid,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"hypothesis" text NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capital_requirement" numeric(30, 10) DEFAULT '0' NOT NULL,
	"estimated_cost" numeric(30, 10) DEFAULT '0' NOT NULL,
	"risk_level" text DEFAULT 'MEDIUM' NOT NULL,
	"automation_score" integer DEFAULT 50 NOT NULL,
	"scalability_score" integer DEFAULT 50 NOT NULL,
	"complexity_score" integer DEFAULT 50 NOT NULL,
	"expected_time_to_revenue_days" integer,
	"qualitative" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'DISCOVERED' NOT NULL,
	"status_reason" text,
	"failure_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_version_id" uuid,
	"risk_limits" jsonb NOT NULL,
	"compliance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paper_capital" numeric(30, 10) DEFAULT '0' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"status_before_pause" text,
	"probation_count" integer DEFAULT 0 NOT NULL,
	"paper_started_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"evaluation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_activity_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_sources" (
	"idea_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "idea_sources_idea_id_source_id_pk" PRIMARY KEY("idea_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"estimated_capital" numeric(30, 10),
	"automation_score" integer,
	"complexity_score" integer,
	"scalability_score" integer,
	"testability_score" integer,
	"revenue_source" text DEFAULT '' NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"regulatory_risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assessment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suggested_strategy_id" text,
	"experiment_id" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_bars" (
	"dataset_id" uuid NOT NULL,
	"ts" bigint NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision NOT NULL,
	CONSTRAINT "market_bars_dataset_id_ts_pk" PRIMARY KEY("dataset_id","ts")
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"version_id" uuid,
	"run_id" uuid,
	"name" text NOT NULL,
	"value" double precision,
	"unit" text,
	"provenance" text NOT NULL,
	"period" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'INFO' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"experiment_id" uuid,
	"read_at" timestamp with time zone,
	"delivery_status" text DEFAULT 'SKIPPED' NOT NULL,
	"delivery_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"version_id" uuid,
	"name" text NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"starting_capital" numeric(30, 10) NOT NULL,
	"cash" numeric(30, 10) NOT NULL,
	"realized_pnl" numeric(30, 10) DEFAULT '0' NOT NULL,
	"fees_paid" numeric(30, 10) DEFAULT '0' NOT NULL,
	"slippage_cost" numeric(30, 10) DEFAULT '0' NOT NULL,
	"funding_pnl" numeric(30, 10) DEFAULT '0' NOT NULL,
	"operating_pnl" numeric(30, 10) DEFAULT '0' NOT NULL,
	"peak_equity" numeric(30, 10) NOT NULL,
	"day_key" text NOT NULL,
	"day_start_equity" numeric(30, 10) NOT NULL,
	"orders_today" integer DEFAULT 0 NOT NULL,
	"spend_total" numeric(30, 10) DEFAULT '0' NOT NULL,
	"api_spend_total" numeric(30, 10) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"ledger_seq" integer DEFAULT 0 NOT NULL,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"provenance" text DEFAULT 'PAPER' NOT NULL,
	"strategy_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"simulated_days" integer DEFAULT 0 NOT NULL,
	"last_tick_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric(30, 10) NOT NULL,
	"price" numeric(30, 10) NOT NULL,
	"fee" numeric(30, 10) NOT NULL,
	"slippage_cost" numeric(30, 10) NOT NULL,
	"liquidity" text NOT NULL,
	"realized_pnl" numeric(30, 10) DEFAULT '0' NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"client_order_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"instrument_kind" text NOT NULL,
	"instrument" jsonb NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"quantity" numeric(30, 10) NOT NULL,
	"limit_price" numeric(30, 10),
	"status" text NOT NULL,
	"filled_quantity" numeric(30, 10) DEFAULT '0' NOT NULL,
	"avg_fill_price" numeric(30, 10),
	"reserved" numeric(30, 10) DEFAULT '0' NOT NULL,
	"reject_reason" text,
	"reduce_only" boolean DEFAULT false NOT NULL,
	"post_only" boolean DEFAULT false NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"instrument_kind" text NOT NULL,
	"quantity" numeric(30, 10) NOT NULL,
	"avg_price" numeric(30, 10) NOT NULL,
	"realized_pnl" numeric(30, 10) DEFAULT '0' NOT NULL,
	"mark_price" numeric(30, 10),
	"opened_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(30, 10) NOT NULL,
	"balance_after" numeric(30, 10) NOT NULL,
	"category" text,
	"description" text DEFAULT '' NOT NULL,
	"ref_order_id" uuid,
	"ref_fill_id" uuid,
	"ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"equity" numeric(30, 10) NOT NULL,
	"cash" numeric(30, 10) NOT NULL,
	"realized_pnl" numeric(30, 10) NOT NULL,
	"unrealized_pnl" numeric(30, 10) NOT NULL,
	"fees" numeric(30, 10) NOT NULL,
	"exposure" numeric(30, 10) NOT NULL,
	"drawdown_pct" double precision NOT NULL,
	"provenance" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"author" text,
	"repository" text,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"summary" text DEFAULT '' NOT NULL,
	"relevant_concept" text DEFAULT '' NOT NULL,
	"advantages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disadvantages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk" text DEFAULT '' NOT NULL,
	"implementation_idea" text DEFAULT '' NOT NULL,
	"license" text,
	"terms_concerns" text DEFAULT '' NOT NULL,
	"github" jsonb,
	"architecture" text DEFAULT '' NOT NULL,
	"known_limitations" text DEFAULT '' NOT NULL,
	"monitor_category" text,
	"relevance" real,
	"origin" text DEFAULT 'MANUAL' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid,
	"account_id" uuid,
	"limit_name" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"value" double precision,
	"threshold" double precision,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"version_id" uuid,
	"overall" real NOT NULL,
	"components" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"evidence" text NOT NULL,
	"rank" integer,
	"explanation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"module_version" text NOT NULL,
	"description" text NOT NULL,
	"params_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"version_id" uuid,
	"run_type" text NOT NULL,
	"provenance" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"dataset_id" uuid,
	"seed" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"idempotency_key" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"component" text NOT NULL,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"experiment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'SYSTEM' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'OWNER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"jobs_processed" integer DEFAULT 0 NOT NULL,
	"jobs_failed" integer DEFAULT 0 NOT NULL,
	"current_job" text
);
--> statement-breakpoint
ALTER TABLE "dataset_points" ADD CONSTRAINT "dataset_points_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_sources" ADD CONSTRAINT "experiment_sources_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_sources" ADD CONSTRAINT "experiment_sources_source_id_research_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."research_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_versions" ADD CONSTRAINT "experiment_versions_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_sources" ADD CONSTRAINT "idea_sources_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_sources" ADD CONSTRAINT "idea_sources_source_id_research_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."research_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_suggested_strategy_id_strategies_id_fk" FOREIGN KEY ("suggested_strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_bars" ADD CONSTRAINT "market_bars_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_version_id_experiment_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."experiment_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_order_id_paper_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."paper_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_transactions" ADD CONSTRAINT "paper_transactions_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_runs" ADD CONSTRAINT "strategy_runs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_runs" ADD CONSTRAINT "strategy_runs_version_id_experiment_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."experiment_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_ts_idx" ON "audit_logs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_logs_experiment_idx" ON "audit_logs" USING btree ("experiment_id","ts");--> statement-breakpoint
CREATE INDEX "data_snapshots_lookup_idx" ON "data_snapshots" USING btree ("source_id","symbol","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "datasets_checksum_uq" ON "datasets" USING btree ("source","kind","symbol","checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_versions_seq_uq" ON "experiment_versions" USING btree ("experiment_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_versions_label_uq" ON "experiment_versions" USING btree ("experiment_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_slug_uq" ON "experiments" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "experiments_status_idx" ON "experiments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "experiments_category_idx" ON "experiments" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "ideas_normalized_name_uq" ON "ideas" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "ideas_status_idx" ON "ideas" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_dedupe_uq" ON "job_runs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "job_runs_claim_idx" ON "job_runs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE INDEX "job_runs_name_idx" ON "job_runs" USING btree ("name","created_at");--> statement-breakpoint
CREATE INDEX "metrics_experiment_idx" ON "metrics" USING btree ("experiment_id","name","recorded_at");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "paper_accounts_experiment_idx" ON "paper_accounts" USING btree ("experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_accounts_active_uq" ON "paper_accounts" USING btree ("experiment_id") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "paper_fills_account_idx" ON "paper_fills" USING btree ("account_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_orders_client_id_uq" ON "paper_orders" USING btree ("account_id","client_order_id");--> statement-breakpoint
CREATE INDEX "paper_orders_account_idx" ON "paper_orders" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_positions_instrument_uq" ON "paper_positions" USING btree ("account_id","venue","symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_transactions_seq_uq" ON "paper_transactions" USING btree ("account_id","seq");--> statement-breakpoint
CREATE INDEX "performance_snapshots_account_idx" ON "performance_snapshots" USING btree ("account_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "research_sources_url_uq" ON "research_sources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "research_sources_found_idx" ON "research_sources" USING btree ("found_at");--> statement-breakpoint
CREATE INDEX "risk_events_created_idx" ON "risk_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "scores_experiment_idx" ON "scores" USING btree ("experiment_id","computed_at");--> statement-breakpoint
CREATE INDEX "strategy_runs_experiment_idx" ON "strategy_runs" USING btree ("experiment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_runs_idempotency_uq" ON "strategy_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "system_events_created_idx" ON "system_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "system_events_component_idx" ON "system_events" USING btree ("component","created_at");
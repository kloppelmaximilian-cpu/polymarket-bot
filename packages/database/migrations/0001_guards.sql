-- Integrity guards that must hold no matter which code path writes.

-- 1. The audit log is append-only.
CREATE OR REPLACE FUNCTION aoc_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION aoc_forbid_mutation();
--> statement-breakpoint

-- 2. A strategy version's parameters can never be rewritten. Results are tied
--    to a version; changing its parameters would silently re-label history.
CREATE OR REPLACE FUNCTION aoc_freeze_version_params() RETURNS trigger AS $$
BEGIN
  IF NEW.params IS DISTINCT FROM OLD.params
     OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.experiment_id IS DISTINCT FROM OLD.experiment_id
     OR NEW.strategy_module_version IS DISTINCT FROM OLD.strategy_module_version THEN
    RAISE EXCEPTION 'experiment_versions are immutable; create a new version instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER experiment_versions_immutable
  BEFORE UPDATE ON experiment_versions
  FOR EACH ROW EXECUTE FUNCTION aoc_freeze_version_params();
--> statement-breakpoint

-- 3. The paper ledger is append-only as well; corrections are new entries.
CREATE TRIGGER paper_transactions_append_only
  BEFORE UPDATE OR DELETE ON paper_transactions
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) -- cascades from a deleted account are allowed
  EXECUTE FUNCTION aoc_forbid_mutation();
--> statement-breakpoint

-- 4. Sanity constraints the application also checks.
ALTER TABLE paper_accounts ADD CONSTRAINT paper_accounts_capital_nonneg CHECK (starting_capital >= 0);
--> statement-breakpoint
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_qty_pos CHECK (quantity > 0);
--> statement-breakpoint
ALTER TABLE paper_fills ADD CONSTRAINT paper_fills_qty_pos CHECK (quantity > 0 AND price >= 0 AND fee >= 0);
--> statement-breakpoint
ALTER TABLE experiments ADD CONSTRAINT experiments_scores_range CHECK (
  automation_score BETWEEN 0 AND 100 AND scalability_score BETWEEN 0 AND 100 AND complexity_score BETWEEN 0 AND 100
);
--> statement-breakpoint
ALTER TABLE job_runs ADD CONSTRAINT job_runs_attempts_nonneg CHECK (attempts >= 0 AND max_attempts >= 1);

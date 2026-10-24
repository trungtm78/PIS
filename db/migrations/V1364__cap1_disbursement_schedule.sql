-- Authored by hand (not generated): registration of the disbursement schedule (ST-CAP-009, CAP 3.1 F7, BR-CAP-08).
-- V002 gave `disbursement_schedule_line` its columns, the CTMTQG subset CHECK and the grain CHECK (a MONTH line names a month, a WEEK line a
-- period). A registration is never edited: a new registration of the same key is a new revision that takes the place of the current one, and the old
-- row stays for the comparison of what was promised with what was paid. The database holds what the command relies on:
--   * one current row for each key (project, year, grain, month or period, source group, kind) and one row for each revision of a key;
--   * a registered amount is a monthly one and a weekly commitment a weekly one; a forecast carries the assumption it rests on; the assumption and
--     the month or the period go with the grain and nothing else;
--   * a row never changes after it is written, except that the revision that replaces it takes `is_current` from it;
--   * the rows are kept for good: the runtime role cannot delete or truncate them.

ALTER TABLE machvon.disbursement_schedule_line
  ADD CONSTRAINT schedule_kind_grain_chk CHECK (NOT (kind = 'REGISTERED' AND granularity <> 'MONTH') AND NOT (kind = 'WEEKLY_COMMITMENT' AND granularity <> 'WEEK')),
  ADD CONSTRAINT schedule_grain_exclusive_chk CHECK ((granularity = 'MONTH' AND period_id IS NULL) OR (granularity = 'WEEK' AND month IS NULL)),
  ADD CONSTRAINT schedule_forecast_assumption_chk CHECK (kind <> 'FORECAST' OR (assumption IS NOT NULL AND btrim(assumption) <> '')),
  ADD CONSTRAINT schedule_assumption_text_chk CHECK (assumption IS NULL OR (assumption = btrim(assumption) AND char_length(assumption) BETWEEN 1 AND 2000)),
  ADD CONSTRAINT schedule_year_chk CHECK (plan_year BETWEEN 1990 AND 2100),
  ADD CONSTRAINT schedule_supersedes_chk CHECK ((revision = 1) = (supersedes_id IS NULL));

-- One current row for a key, and one row for each revision of it. NULLS NOT DISTINCT: a monthly row has no period and a weekly one no month.
CREATE UNIQUE INDEX disbursement_schedule_current_uq
  ON machvon.disbursement_schedule_line (tenant_id, project_id, plan_year, granularity, month, period_id, bucket, budget_level, kind) NULLS NOT DISTINCT
  WHERE is_current;
CREATE UNIQUE INDEX disbursement_schedule_revision_uq
  ON machvon.disbursement_schedule_line (tenant_id, project_id, plan_year, granularity, month, period_id, bucket, budget_level, kind, revision) NULLS NOT DISTINCT;

-- The register is read by year and project, newest month last.
CREATE INDEX disbursement_schedule_year_idx
  ON machvon.disbursement_schedule_line (tenant_id, plan_year, project_id, month, id) WHERE is_current;

CREATE OR REPLACE FUNCTION machvon.guard_disbursement_schedule_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.allocation_line_id IS DISTINCT FROM OLD.allocation_line_id
     OR NEW.plan_year IS DISTINCT FROM OLD.plan_year
     OR NEW.granularity IS DISTINCT FROM OLD.granularity
     OR NEW.period_id IS DISTINCT FROM OLD.period_id
     OR NEW.month IS DISTINCT FROM OLD.month
     OR NEW.bucket IS DISTINCT FROM OLD.bucket
     OR NEW.budget_level IS DISTINCT FROM OLD.budget_level
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd
     OR NEW.ctmtqg_subset_vnd IS DISTINCT FROM OLD.ctmtqg_subset_vnd
     OR NEW.assumption IS DISTINCT FROM OLD.assumption
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.source_report_revision_id IS DISTINCT FROM OLD.source_report_revision_id
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a registration of the disbursement schedule is never edited: a new revision takes its place' USING ERRCODE = '23514';
  END IF;
  IF OLD.is_current IS NOT TRUE OR NEW.is_current IS NOT FALSE THEN
    RAISE EXCEPTION 'a registration only stops being current when a newer revision of its key replaces it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER disbursement_schedule_update_guard
  BEFORE UPDATE ON machvon.disbursement_schedule_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_disbursement_schedule_update();

REVOKE DELETE, TRUNCATE ON TABLE machvon.disbursement_schedule_line FROM machvon_app;

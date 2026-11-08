-- Authored by hand (not generated): the vintages of the milestone forecast (GOV-11, G1-16, DIS 3 F8).
-- When a snapshot of a period is frozen, the job `dis-milestone-forecast` reads the year-end estimate of every investor unit over it and writes, for each directive milestone of the rule in force
-- (`DISBURSEMENT_MILESTONES`), what the figures project for that day, the target, and the status (achieved, missed, on track, at risk, off track, no data). A row is evidence of what was foreseen on
-- the day of the snapshot, so a later judgement of how good the forecast was (and the alert `DIS_MILESTONE_AT_RISK`) reads it and never recomputes it:
--   * one row for a (snapshot, milestone, investor unit): the job is idempotent and a redelivery adds nothing;
--   * append-only for every role (a trigger and no UPDATE, DELETE or TRUNCATE for the application role);
--   * the version of the rule that decided is on the row (0 for the built-in default), so the numbers behind it can be read back.

CREATE TABLE machvon.disbursement_milestone_forecast (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  plan_year integer NOT NULL,
  as_of_date date NOT NULL,
  treasury_cutoff_date date NOT NULL,
  unit_id uuid NOT NULL,
  rule_code text NOT NULL,
  rule_version integer NOT NULL,
  rule_source text NOT NULL,
  milestone_code text NOT NULL,
  milestone_date date NOT NULL,
  target_pct numeric(7, 2) NOT NULL,
  margin_pct numeric(7, 2) NOT NULL,
  target_vnd numeric(24, 0) NOT NULL,
  plan_total_vnd numeric(24, 0) NOT NULL,
  disbursed_vnd numeric(24, 0),
  projected_vnd numeric(24, 0),
  projected_pct numeric(10, 2),
  gap_pct numeric(10, 2),
  basis text NOT NULL,
  coverage text NOT NULL,
  status text NOT NULL,
  projects integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  CONSTRAINT milestone_forecast_unique UNIQUE (tenant_id, snapshot_id, milestone_code, unit_id),
  CONSTRAINT milestone_forecast_code_chk CHECK (milestone_code ~ '^[A-Z][A-Z0-9_]{1,39}$' AND rule_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT milestone_forecast_rule_chk CHECK (rule_source IN ('RULE', 'DEFAULT') AND rule_version >= 0 AND (rule_source = 'DEFAULT') = (rule_version = 0)),
  CONSTRAINT milestone_forecast_year_chk CHECK (plan_year BETWEEN 1990 AND 2100 AND extract(year FROM milestone_date) = plan_year),
  CONSTRAINT milestone_forecast_target_chk CHECK (target_pct BETWEEN 0 AND 100 AND margin_pct BETWEEN 0 AND 50 AND target_vnd >= 0 AND plan_total_vnd >= 0),
  CONSTRAINT milestone_forecast_basis_chk CHECK (basis IN ('ACTUAL', 'FORECAST')),
  CONSTRAINT milestone_forecast_coverage_chk CHECK (coverage IN ('COMPLETE', 'PARTIAL', 'NONE')),
  CONSTRAINT milestone_forecast_status_chk CHECK (status IN ('ACHIEVED', 'MISSED', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'NO_DATA')),
  CONSTRAINT milestone_forecast_projection_chk CHECK ((projected_vnd IS NULL) = (projected_pct IS NULL)),
  CONSTRAINT milestone_forecast_no_data_chk CHECK ((status = 'NO_DATA') OR (projected_vnd IS NOT NULL AND coverage <> 'NONE')),
  CONSTRAINT milestone_forecast_projects_chk CHECK (projects >= 0)
);

-- Read by snapshot (the latest vintage of an investor), by investor over time (how a milestone moved from snapshot to snapshot) and by status for the alert.
CREATE INDEX milestone_forecast_snapshot_idx ON machvon.disbursement_milestone_forecast (tenant_id, snapshot_id, milestone_date, unit_id);
CREATE INDEX milestone_forecast_unit_idx ON machvon.disbursement_milestone_forecast (tenant_id, unit_id, milestone_date, created_at DESC);
CREATE INDEX milestone_forecast_alert_idx ON machvon.disbursement_milestone_forecast (tenant_id, created_at DESC, id) WHERE status IN ('AT_RISK', 'OFF_TRACK');

CREATE FUNCTION machvon.milestone_forecast_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a milestone forecast is the evidence of what was foreseen on the day of the snapshot and is append-only' USING ERRCODE = '23514', CONSTRAINT = 'milestone_forecast_append_only';
END;
$fn$;

CREATE TRIGGER milestone_forecast_append_only BEFORE UPDATE OR DELETE ON machvon.disbursement_milestone_forecast FOR EACH ROW EXECUTE FUNCTION machvon.milestone_forecast_append_only();

ALTER TABLE machvon.disbursement_milestone_forecast ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.disbursement_milestone_forecast FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.disbursement_milestone_forecast AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.disbursement_milestone_forecast AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.disbursement_milestone_forecast FROM machvon_app;

COMMENT ON TABLE machvon.disbursement_milestone_forecast IS 'GOV-11 G1-16: the projection of the cumulative disbursement to each directive milestone, per investor unit, written when a snapshot is frozen; append-only evidence.';

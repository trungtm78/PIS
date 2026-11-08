-- Authored by hand (not generated): the run of the milestone forecast for a snapshot (GOV-11, G1-16).
-- A frozen snapshot that has no vintages is either not read yet (the job did not run) or has nothing to say (no investor unit, no milestone in the rule). The screen must tell the two apart and never show
-- the first as "no milestones", so the job writes one row for each snapshot it has judged, whatever the outcome, with the rule that decided and how many rows it wrote.
--   * one row for a snapshot: the job is idempotent and a redelivery of the event finds the row and does nothing;
--   * append-only for every role (a trigger and no UPDATE, DELETE or TRUNCATE for the application role).

CREATE TABLE machvon.disbursement_milestone_run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  outcome text NOT NULL,
  rule_code text NOT NULL,
  rule_version integer NOT NULL,
  rule_source text NOT NULL,
  milestones integer NOT NULL,
  units integer NOT NULL,
  rows_written integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  CONSTRAINT milestone_run_snapshot_uq UNIQUE (tenant_id, snapshot_id),
  CONSTRAINT milestone_run_outcome_chk CHECK (outcome IN ('RECORDED', 'NO_MILESTONES', 'NO_PROJECTS')),
  CONSTRAINT milestone_run_rule_chk CHECK (rule_source IN ('RULE', 'DEFAULT') AND rule_version >= 0 AND (rule_source = 'DEFAULT') = (rule_version = 0) AND rule_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT milestone_run_counts_chk CHECK (milestones >= 0 AND units >= 0 AND rows_written = milestones * units AND (outcome = 'RECORDED') = (rows_written > 0))
);

CREATE INDEX milestone_run_recent_idx ON machvon.disbursement_milestone_run (tenant_id, created_at DESC, id);

CREATE FUNCTION machvon.milestone_run_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the run of the milestone forecast for a snapshot is append-only' USING ERRCODE = '23514', CONSTRAINT = 'milestone_run_append_only';
END;
$fn$;

CREATE TRIGGER milestone_run_append_only BEFORE UPDATE OR DELETE ON machvon.disbursement_milestone_run FOR EACH ROW EXECUTE FUNCTION machvon.milestone_run_append_only();

ALTER TABLE machvon.disbursement_milestone_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.disbursement_milestone_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.disbursement_milestone_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.disbursement_milestone_run AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.disbursement_milestone_run FROM machvon_app;

COMMENT ON TABLE machvon.disbursement_milestone_run IS 'GOV-11 G1-16: one row for each snapshot the milestone forecast judged, with the rule that decided and what it wrote; tells "not read yet" from "nothing to say".';

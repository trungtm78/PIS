-- Authored by hand (not generated): the differences between our figures and the statement of Oracle EBS, by project code (ENT-2, docs/ebs-connector.md). Each difference is an item with an owner who is not one of the people who
-- made the figures compared (the person who loaded the file, the person who ran the comparison), a due time from the rule EBS_RECONCILE_POLICY and, once settled, an explanation of one of four kinds with the audit of ADM-11
-- written by the command. One item is open at a time for a measure of a project in a period; a settled difference comes back only when a figure moved (the fingerprint of both values changes) or a timing difference or a waiver
-- reaches the day it is looked at again. The table never edits another module's record: a resolution says that ours or EBS is wrong, and the owner of that record corrects it through its own command.

CREATE TABLE machvon.ebs_reconciliation_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid,
  project_code text NOT NULL,
  period text NOT NULL,
  measure text NOT NULL,
  difference_kind text NOT NULL,
  ours numeric(24, 2),
  theirs numeric(24, 2),
  delta numeric(24, 2),
  fingerprint char(64) NOT NULL,
  source_record_id uuid,
  import_id uuid,
  state text NOT NULL DEFAULT 'OPEN',
  owner_id uuid NOT NULL,
  maker_ids uuid[] NOT NULL,
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  resolution_kind text,
  resolved_by uuid,
  resolved_at timestamptz,
  reason text,
  evidence_ref text,
  review_on date,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_record_id) REFERENCES machvon.ebs_record (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id),
  CONSTRAINT ebs_item_project_chk CHECK (project_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$'),
  CONSTRAINT ebs_item_period_chk CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ebs_item_measure_chk CHECK (measure IN ('DISBURSED_VND', 'COMMITTED_VND')),
  CONSTRAINT ebs_item_kind_chk CHECK (difference_kind IN ('AMOUNT_MISMATCH', 'MISSING_OURS')),
  CONSTRAINT ebs_item_figures_chk CHECK (theirs IS NOT NULL AND ((difference_kind = 'MISSING_OURS') = (ours IS NULL)) AND ((difference_kind = 'MISSING_OURS') = (delta IS NULL))),
  CONSTRAINT ebs_item_fingerprint_chk CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ebs_item_state_chk CHECK (state IN ('OPEN', 'RESOLVED')),
  CONSTRAINT ebs_item_owner_chk CHECK (NOT (owner_id = ANY (maker_ids))),
  CONSTRAINT ebs_item_makers_chk CHECK (cardinality(maker_ids) >= 1),
  CONSTRAINT ebs_item_resolution_chk CHECK (
    (state = 'OPEN') = (resolution_kind IS NULL AND resolved_by IS NULL AND resolved_at IS NULL AND reason IS NULL AND evidence_ref IS NULL AND review_on IS NULL)
    AND (resolution_kind IS NULL OR resolution_kind IN ('OURS_WRONG', 'EBS_WRONG', 'TIMING', 'WAIVED'))
    AND (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000))
    AND (resolution_kind IS NULL OR resolution_kind NOT IN ('OURS_WRONG', 'EBS_WRONG') OR evidence_ref IS NOT NULL)
    AND (resolution_kind IS NULL OR resolution_kind NOT IN ('TIMING', 'WAIVED') OR review_on IS NOT NULL)
  ),
  CONSTRAINT ebs_item_maker_checker_chk CHECK (resolved_by IS NULL OR NOT (resolved_by = ANY (maker_ids))),
  CONSTRAINT ebs_item_version_chk CHECK (version >= 1)
);

CREATE INDEX ebs_item_state_idx ON machvon.ebs_reconciliation_item (tenant_id, state, due_at, id);
CREATE INDEX ebs_item_owner_idx ON machvon.ebs_reconciliation_item (tenant_id, owner_id, state, due_at);
CREATE INDEX ebs_item_project_idx ON machvon.ebs_reconciliation_item (tenant_id, project_code, period, measure, state);
CREATE INDEX ebs_item_project_id_idx ON machvon.ebs_reconciliation_item (tenant_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX ebs_item_record_idx ON machvon.ebs_reconciliation_item (tenant_id, source_record_id) WHERE source_record_id IS NOT NULL;
CREATE INDEX ebs_item_import_idx ON machvon.ebs_reconciliation_item (tenant_id, import_id) WHERE import_id IS NOT NULL;
CREATE UNIQUE INDEX ebs_item_open_uq ON machvon.ebs_reconciliation_item (tenant_id, project_code, period, measure) WHERE state = 'OPEN';

CREATE FUNCTION machvon.guard_ebs_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_code IS DISTINCT FROM OLD.project_code OR NEW.period IS DISTINCT FROM OLD.period OR NEW.measure IS DISTINCT FROM OLD.measure
     OR NEW.maker_ids IS DISTINCT FROM OLD.maker_ids OR NEW.opened_by IS DISTINCT FROM OLD.opened_by OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'an item keeps the project, the period, the measure, its makers and its time' USING ERRCODE = '23514';
  END IF;
  -- The figures of an open item are refreshed when a later reading moves them (the item always shows the latest comparison); a settled item keeps what it was settled on.
  IF (NEW.difference_kind IS DISTINCT FROM OLD.difference_kind OR NEW.ours IS DISTINCT FROM OLD.ours OR NEW.theirs IS DISTINCT FROM OLD.theirs OR NEW.delta IS DISTINCT FROM OLD.delta OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint)
     AND NOT (OLD.state = 'OPEN' AND NEW.state = 'OPEN') THEN
    RAISE EXCEPTION 'a settled item keeps the difference it was settled on' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'RESOLVED' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.resolution_kind IS DISTINCT FROM OLD.resolution_kind OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by OR NEW.reason IS DISTINCT FROM OLD.reason) THEN
    RAISE EXCEPTION 'a settled item is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ebs_item_guard BEFORE UPDATE ON machvon.ebs_reconciliation_item FOR EACH ROW EXECUTE FUNCTION machvon.guard_ebs_item();

ALTER TABLE machvon.ebs_reconciliation_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ebs_reconciliation_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ebs_reconciliation_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ebs_reconciliation_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.ebs_reconciliation_item FROM machvon_app;

COMMENT ON TABLE machvon.ebs_reconciliation_item IS 'ENT-2: a difference between our figure and the statement of Oracle EBS for a project code, a period and a measure; owner not among its makers; settled with an explanation; PENDING-EXTERNAL layout.';

-- ST-DGV-004 (DGV.md F7, BR-DGV-09): source field mappings (D04) that an owner confirms, the gate that sends a batch to quarantine while its mapping is not confirmed, and the reconciliation of two sources
-- (PAY treasury against DIS reported) whose differences are classified, owned and never merged into one number.

-- ---- mappings ----------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.dataset_source_mapping ADD COLUMN decided_by uuid;
ALTER TABLE machvon.dataset_source_mapping ADD COLUMN decided_at timestamptz;
ALTER TABLE machvon.dataset_source_mapping ADD COLUMN decision_note text;
ALTER TABLE machvon.dataset_source_mapping
  ADD CONSTRAINT dataset_source_mapping_decision_chk CHECK ((status IN ('PROPOSED')) = (decided_by IS NULL) OR status = 'RETIRED') NOT VALID,
  ADD CONSTRAINT dataset_source_mapping_sod_chk CHECK (decided_by IS NULL OR status = 'RETIRED' OR decided_by <> created_by) NOT VALID;
-- A rejected or retired mapping can be proposed again, and a confirmed one is replaced by proposing another and confirming it (which retires the old): one proposed and one confirmed at most for a key.
DROP INDEX machvon.dataset_source_mapping_map_uq;
CREATE UNIQUE INDEX dataset_source_mapping_map_uq ON machvon.dataset_source_mapping (tenant_id, dataset_id, source_system, source_field, target_field) WHERE status = 'PROPOSED';
CREATE UNIQUE INDEX dataset_source_mapping_confirmed_uq ON machvon.dataset_source_mapping (tenant_id, dataset_id, source_system, source_field, target_field) WHERE status = 'CONFIRMED';
CREATE INDEX dataset_source_mapping_lookup_idx ON machvon.dataset_source_mapping (tenant_id, dataset_id, source_system, status);

CREATE FUNCTION machvon.guard_dataset_source_mapping() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.dataset_id, NEW.source_system, NEW.source_field, NEW.target_field, NEW.transform_rule, NEW.unit, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.dataset_id, OLD.source_system, OLD.source_field, OLD.target_field, OLD.transform_rule, OLD.unit, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a source mapping says is not changed: propose another' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('PROPOSED', 'CONFIRMED'), ('PROPOSED', 'REJECTED'), ('CONFIRMED', 'RETIRED'), ('PROPOSED', 'RETIRED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'a source mapping does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', DETAIL = 'MAPPING_STATE_INVALID';
  END IF;
  IF OLD.status IN ('CONFIRMED', 'REJECTED') AND NEW.status = OLD.status AND (NEW.decided_by, NEW.decided_at, NEW.confirmed_by, NEW.confirmed_at, NEW.decision_note) IS DISTINCT FROM (OLD.decided_by, OLD.decided_at, OLD.confirmed_by, OLD.confirmed_at, OLD.decision_note) THEN
    RAISE EXCEPTION 'the decision on a source mapping is written once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dataset_source_mapping_guard BEFORE UPDATE ON machvon.dataset_source_mapping
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_dataset_source_mapping();
REVOKE DELETE, TRUNCATE ON TABLE machvon.dataset_source_mapping FROM machvon_app;

-- ---- the gate of a batch ------------------------------------------------------------------------------------------------------------
-- What the pipeline did with a batch of a source: applied with the confirmed mappings (and their units), or kept out in quarantine because a field of it has no confirmed mapping. Written once, never changed.
CREATE TABLE machvon.dataset_batch_gate (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  source_system text NOT NULL,
  batch_ref text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('APPLIED', 'QUARANTINED')),
  reason text CHECK (reason IN ('MAPPING_NOT_CONFIRMED')),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  fields jsonb NOT NULL,
  gated_at timestamptz NOT NULL DEFAULT now(),
  gated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT dataset_batch_gate_dataset_fk FOREIGN KEY (tenant_id, dataset_id) REFERENCES machvon.dataset (tenant_id, id),
  CONSTRAINT dataset_batch_gate_reason_chk CHECK ((outcome = 'QUARANTINED') = (reason IS NOT NULL))
);
ALTER TABLE machvon.dataset_batch_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.dataset_batch_gate FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON machvon.dataset_batch_gate AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_boundary ON machvon.dataset_batch_gate AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX dataset_batch_gate_dataset_idx ON machvon.dataset_batch_gate (tenant_id, dataset_id, gated_at DESC, id DESC);
CREATE INDEX dataset_batch_gate_gated_by_idx ON machvon.dataset_batch_gate (tenant_id, gated_by);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.dataset_batch_gate FROM machvon_app;

-- ---- reconciliation -----------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.reconciliation_run ADD COLUMN dataset_id uuid;
ALTER TABLE machvon.reconciliation_run ADD COLUMN snapshot_id uuid;
ALTER TABLE machvon.reconciliation_run ADD COLUMN differences_truncated boolean NOT NULL DEFAULT false;
-- The whole count of the differences and the count by kind, whatever part of the differences is kept one by one.
ALTER TABLE machvon.reconciliation_run ADD COLUMN differences_count integer NOT NULL DEFAULT 0;
ALTER TABLE machvon.reconciliation_run ADD COLUMN by_kind jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE machvon.reconciliation_run
  ADD CONSTRAINT reconciliation_run_dataset_fk FOREIGN KEY (tenant_id, dataset_id) REFERENCES machvon.dataset (tenant_id, id),
  ADD CONSTRAINT reconciliation_run_counts_chk CHECK (count_a >= 0 AND count_b >= 0 AND tolerance_vnd >= 0) NOT VALID,
  ADD CONSTRAINT reconciliation_run_incident_chk CHECK ((result = 'DIFFERENT') = (incident_id IS NOT NULL)) NOT VALID;
CREATE INDEX reconciliation_run_period_idx ON machvon.reconciliation_run (tenant_id, recon_code, as_of_period, created_at DESC, id DESC);
CREATE INDEX reconciliation_run_dataset_idx ON machvon.reconciliation_run (tenant_id, dataset_id);
CREATE INDEX reconciliation_run_snapshot_idx ON machvon.reconciliation_run (tenant_id, snapshot_id);

-- A reconciliation is a measurement: written once with its incident, never changed or erased.
CREATE FUNCTION machvon.guard_reconciliation_run() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.recon_code, NEW.source_a, NEW.source_b, NEW.as_of_period, NEW.basis, NEW.count_a, NEW.count_b, NEW.total_a_vnd, NEW.total_b_vnd, NEW.tolerance_vnd, NEW.differences_json, NEW.differences_truncated, NEW.differences_count, NEW.by_kind, NEW.result, NEW.owner_user_id, NEW.dataset_id, NEW.snapshot_id)
     IS DISTINCT FROM (OLD.recon_code, OLD.source_a, OLD.source_b, OLD.as_of_period, OLD.basis, OLD.count_a, OLD.count_b, OLD.total_a_vnd, OLD.total_b_vnd, OLD.tolerance_vnd, OLD.differences_json, OLD.differences_truncated, OLD.differences_count, OLD.by_kind, OLD.result, OLD.owner_user_id, OLD.dataset_id, OLD.snapshot_id)
     OR (OLD.incident_id IS NOT NULL AND NEW.incident_id IS DISTINCT FROM OLD.incident_id) THEN
    RAISE EXCEPTION 'a reconciliation is a measurement: it is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER reconciliation_run_guard BEFORE UPDATE ON machvon.reconciliation_run
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_reconciliation_run();
REVOKE DELETE, TRUNCATE ON TABLE machvon.reconciliation_run FROM machvon_app;

-- ---- an incident can be about a reconciliation as well as a rule --------------------------------------------------------------------
ALTER TABLE machvon.quality_incident ALTER COLUMN rule_id DROP NOT NULL;
ALTER TABLE machvon.quality_incident ADD COLUMN reconciliation_id uuid;
ALTER TABLE machvon.quality_incident
  ADD CONSTRAINT quality_incident_reconciliation_fk FOREIGN KEY (tenant_id, reconciliation_id) REFERENCES machvon.reconciliation_run (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT quality_incident_cause_chk CHECK ((rule_id IS NULL) <> (reconciliation_id IS NULL)) NOT VALID;
CREATE INDEX quality_incident_reconciliation_idx ON machvon.quality_incident (tenant_id, reconciliation_id);

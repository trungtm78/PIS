-- ST-ADM-015: the reorganisation of organisation units as a saga (ADM 3.2). The table of V002 keeps the proposal in mapping_json; this adds the decision, the result and the record of the steps already done, so that a saga that
-- failed is carried on from the step that failed and the ones done are skipped.

ALTER TABLE machvon.unit_reorganization ADD COLUMN decided_at timestamptz;
ALTER TABLE machvon.unit_reorganization ADD COLUMN decision_reason text;
ALTER TABLE machvon.unit_reorganization ADD COLUMN decision_evidence_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE machvon.unit_reorganization ADD COLUMN applied_at timestamptz;

-- What the saga did, one row per step and item, keyed as the design says (reorg:{id}:{step}:{item}): a row is written in the transaction of its step, so a step is done once whatever the retries.
CREATE TABLE machvon.unit_reorganization_step (
  tenant_id uuid NOT NULL,
  reorganization_id uuid NOT NULL,
  step_key text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  done_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reorganization_id, step_key),
  CONSTRAINT unit_reorganization_step_fk FOREIGN KEY (tenant_id, reorganization_id) REFERENCES machvon.unit_reorganization (tenant_id, id),
  CONSTRAINT unit_reorganization_step_key_chk CHECK (step_key ~ '^[a-z-]+(:[0-9a-f-]{36})*$')
);
ALTER TABLE machvon.unit_reorganization_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.unit_reorganization_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.unit_reorganization_step AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.unit_reorganization_step AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.unit_reorganization_step FROM machvon_app;

-- The proposal does not change; the state only moves along the lines of the design: Draft to PendingApproval or Cancelled; PendingApproval to Applying (approved), Draft (returned) or Cancelled; Applying to Applied or Failed;
-- Failed to Applying (decided again). Applied and Cancelled are final. Approval is by someone other than the proposer (the table says so too).
CREATE FUNCTION machvon.guard_unit_reorganization() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.kind, NEW.effective_from, NEW.legal_basis_ref, NEW.mapping_json, NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM (OLD.kind, OLD.effective_from, OLD.legal_basis_ref, OLD.mapping_json, OLD.requested_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a reorganisation proposes is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('Applied', 'Cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a reorganisation that is over is not changed' USING ERRCODE = '23514', DETAIL = 'REORG_STATE_INVALID';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'Draft' AND NEW.status IN ('PendingApproval', 'Cancelled'))
    OR (OLD.status = 'PendingApproval' AND NEW.status IN ('Approved', 'Applying', 'Draft', 'Cancelled'))
    OR (OLD.status = 'Approved' AND NEW.status IN ('Applying', 'Cancelled'))
    OR (OLD.status = 'Applying' AND NEW.status IN ('Applied', 'Failed'))
    OR (OLD.status = 'Failed' AND NEW.status = 'Applying')) THEN
    RAISE EXCEPTION 'a reorganisation does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', DETAIL = 'REORG_STATE_INVALID';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER unit_reorganization_guard BEFORE UPDATE ON machvon.unit_reorganization FOR EACH ROW EXECUTE FUNCTION machvon.guard_unit_reorganization();
REVOKE DELETE, TRUNCATE ON TABLE machvon.unit_reorganization FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.organization_unit_succession FROM machvon_app;

-- The job reads the sagas that are running.
CREATE INDEX unit_reorganization_open_idx ON machvon.unit_reorganization (tenant_id, effective_from) WHERE status IN ('Applying');

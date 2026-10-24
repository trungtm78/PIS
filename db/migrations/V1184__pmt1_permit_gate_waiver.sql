-- Authored by hand (not generated): the time-limited waivers of the permit gates (ST-PMT-005, BR-PMT-05).
-- V002 gave `permit_gate_waiver` (project, gate, permit type, reason, decision document, last day, approver, status ACTIVE, EXPIRED or REVOKED) with
-- the row-level security of the tenant and `permit_gate_waiver_maker_chk` (the approver is not the maker). A waiver lets a gate pass without a permit
-- until its last day, so it is a legal act that must be explainable later; this migration puts into the database what the commands rely on:
--   * a waiver names the code of the permit type it waives, copied from the version the waiver names (the requirement of a gate is about the type, as
--     in the gate rule), and at most one waiver of a project, a gate and a permit type is ACTIVE at a time;
--   * the maker of a waiver is the person who asked for it and the approver is someone else (V002); the reason is not blank; the gate is one of the five;
--   * a waiver keeps its project, gate, permit type, reason, decision document, last day, approver and maker for good: it is never extended or edited,
--     it only ends, as EXPIRED by the job on the day after its last day or as REVOKED by a decision that gives its words;
--   * a waiver is never deleted (the decision it rests on is kept with the project).

ALTER TABLE machvon.permit_gate_waiver
  ADD COLUMN permit_type_code text,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid,
  ADD COLUMN revoked_reason text;

CREATE FUNCTION machvon.fill_permit_gate_waiver_type_code() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  SELECT t.code INTO NEW.permit_type_code
    FROM machvon.permit_type t
   WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.permit_type_id;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_gate_waiver_type_code_fill BEFORE INSERT ON machvon.permit_gate_waiver
  FOR EACH ROW EXECUTE FUNCTION machvon.fill_permit_gate_waiver_type_code();

ALTER TABLE machvon.permit_gate_waiver
  ADD CONSTRAINT permit_gate_waiver_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  ADD CONSTRAINT permit_gate_waiver_type_fk FOREIGN KEY (tenant_id, permit_type_id) REFERENCES machvon.permit_type (tenant_id, id),
  ADD CONSTRAINT permit_gate_waiver_document_fk FOREIGN KEY (tenant_id, decision_document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  ADD CONSTRAINT permit_gate_waiver_gate_chk CHECK (gate_code IN ('CONTRACT_ACTIVATION', 'START_CONSTRUCTION', 'ACCEPTANCE_COMPLETION', 'HANDOVER', 'ADVANCE_DISBURSEMENT')),
  ADD CONSTRAINT permit_gate_waiver_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000),
  ADD CONSTRAINT permit_gate_waiver_revoked_chk CHECK (
    (status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL)
    AND (revoked_reason IS NULL OR (revoked_reason = btrim(revoked_reason) AND char_length(revoked_reason) BETWEEN 1 AND 2000))
  );

-- At most one waiver of a project, a gate and a permit type code is in force at a time.
CREATE UNIQUE INDEX permit_gate_waiver_one_active_uq ON machvon.permit_gate_waiver (tenant_id, project_id, gate_code, permit_type_code) WHERE status = 'ACTIVE';
-- The job that ends the waivers whose last day has passed reads the ACTIVE ones by last day.
CREATE INDEX permit_gate_waiver_expiry_idx ON machvon.permit_gate_waiver (tenant_id, valid_until) WHERE status = 'ACTIVE';
CREATE INDEX permit_gate_waiver_listing_idx ON machvon.permit_gate_waiver (tenant_id, created_at DESC, id DESC);

CREATE FUNCTION machvon.guard_permit_gate_waiver() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a permit gate waiver is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'a permit gate waiver starts in force' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.gate_code, NEW.permit_type_id, NEW.permit_type_code, NEW.reason, NEW.decision_document_version_id, NEW.valid_until,
      NEW.approved_by, NEW.approved_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.gate_code, OLD.permit_type_id, OLD.permit_type_code, OLD.reason, OLD.decision_document_version_id, OLD.valid_until,
      OLD.approved_by, OLD.approved_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a permit gate waiver keeps what was decided; it only ends' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'an ended permit gate waiver never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status NOT IN ('ACTIVE', 'EXPIRED', 'REVOKED') THEN
    RAISE EXCEPTION 'the state transition of the permit gate waiver is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_gate_waiver_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.permit_gate_waiver
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_permit_gate_waiver();

REVOKE DELETE, TRUNCATE ON TABLE machvon.permit_gate_waiver FROM machvon_app;

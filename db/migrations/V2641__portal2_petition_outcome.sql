-- Authored by hand (not generated): the recorded outcome of a petition of a contractor (PORTAL-2; docs/plans/portal2.md, docs/vendor-investigation.md section 8).
-- The petition module records that a petition was answered (RESOLVED) or passed up (ESCALATED), never what the decision was, so the share of petitions upheld could not be measured. An outcome is the decision of the
-- authority on the petition: UPHELD (the contractor was right), REJECTED, or WITHDRAWN (the contractor withdrew it), with the reference of the decision (number and day, optionally the document that carries it).
-- Maker and checker: one person records it (PROPOSED), a different person confirms (CONFIRMED) or returns it with a reason (RETURNED); a confirmed outcome is final. One live outcome per petition.

CREATE TABLE machvon.procurement_petition_outcome (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  petition_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('UPHELD', 'REJECTED', 'WITHDRAWN')),
  decision_ref text NOT NULL CHECK (decision_ref = btrim(decision_ref) AND char_length(decision_ref) BETWEEN 3 AND 120),
  decision_on date NOT NULL,
  decision_document_id uuid,
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 1000)),
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'CONFIRMED', 'RETURNED')),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  checked_by uuid,
  checked_at timestamptz,
  return_reason text CHECK (return_reason IS NULL OR (return_reason = btrim(return_reason) AND char_length(return_reason) BETWEEN 5 AND 1000)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, petition_id) REFERENCES machvon.procurement_petition (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, checked_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT petition_outcome_sod_chk CHECK (checked_by IS NULL OR checked_by <> recorded_by),
  CONSTRAINT petition_outcome_check_chk CHECK ((checked_by IS NULL) = (checked_at IS NULL) AND (status = 'PROPOSED') = (checked_by IS NULL)),
  CONSTRAINT petition_outcome_return_chk CHECK ((status = 'RETURNED') = (return_reason IS NOT NULL))
);
CREATE UNIQUE INDEX petition_outcome_live_uq ON machvon.procurement_petition_outcome (tenant_id, petition_id) WHERE status IN ('PROPOSED', 'CONFIRMED');
CREATE INDEX petition_outcome_petition_idx ON machvon.procurement_petition_outcome (tenant_id, petition_id, recorded_at DESC);
CREATE INDEX petition_outcome_status_idx ON machvon.procurement_petition_outcome (tenant_id, status, recorded_at DESC);
CREATE INDEX petition_outcome_recorder_idx ON machvon.procurement_petition_outcome (tenant_id, recorded_by);
CREATE INDEX petition_outcome_checker_idx ON machvon.procurement_petition_outcome (tenant_id, checked_by) WHERE checked_by IS NOT NULL;
CREATE INDEX petition_outcome_document_idx ON machvon.procurement_petition_outcome (tenant_id, decision_document_id) WHERE decision_document_id IS NOT NULL;

ALTER TABLE machvon.procurement_petition_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.procurement_petition_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.procurement_petition_outcome AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.procurement_petition_outcome AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.procurement_petition_outcome FROM machvon_app;

-- What was recorded never changes except through the check: the petition, the outcome, the reference and the day stay as the recorder wrote them, and a confirmed outcome is final.
CREATE FUNCTION machvon.guard_petition_outcome() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.petition_id, NEW.outcome, NEW.decision_ref, NEW.decision_on, NEW.decision_document_id, NEW.recorded_by, NEW.recorded_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.petition_id, OLD.outcome, OLD.decision_ref, OLD.decision_on, OLD.decision_document_id, OLD.recorded_by, OLD.recorded_at) THEN
    RAISE EXCEPTION 'what an outcome says never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'PROPOSED' THEN
    RAISE EXCEPTION 'PETITION_OUTCOME_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER petition_outcome_guard BEFORE UPDATE ON machvon.procurement_petition_outcome
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_petition_outcome();

COMMENT ON TABLE machvon.procurement_petition_outcome IS 'PORTAL-2: the decision on a petition of a contractor (upheld, rejected, withdrawn) with its reference; recorded by one person and confirmed by another.';

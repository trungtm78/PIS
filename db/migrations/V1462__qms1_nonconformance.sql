-- Authored by hand (not generated): the non-conformance of the work under a contract and the actions that put it right (ST-QMS-006, QMS 3.3, BR-QMS-07, UAT-AC361).
-- The tables quality_nonconformance and corrective_action, the checks that a critical non-conformance holds back the acceptance, that who verifies is not who put it right, and that a closed one is
-- verified and closed by a person, are in V002. This adds the words the commands keep (the note of the evidence, the note of the closing, the reason of a reopening), the guard of the edges of the
-- status of both tables, what a non-conformance is about never changing, the independence of whoever closes it, and that neither is ever deleted.

ALTER TABLE machvon.quality_nonconformance
  ADD COLUMN closure_note text,
  ADD COLUMN reopen_reason text,
  ADD COLUMN reopened_at timestamptz,
  ADD COLUMN reopened_by uuid,
  ADD COLUMN reopen_count integer NOT NULL DEFAULT 0;

ALTER TABLE machvon.corrective_action
  ADD COLUMN evidence_note text,
  ADD COLUMN submitted_by uuid;

ALTER TABLE machvon.quality_nonconformance
  ADD CONSTRAINT quality_nonconformance_text_chk CHECK (
    (title IS NULL OR (title = btrim(title) AND title <> '' AND char_length(title) <= 2000))
    AND (description IS NULL OR (description = btrim(description) AND description <> '' AND char_length(description) <= 2000))
    AND (closure_note IS NULL OR (closure_note = btrim(closure_note) AND closure_note <> '' AND char_length(closure_note) <= 2000))
    AND (reopen_reason IS NULL OR (reopen_reason = btrim(reopen_reason) AND reopen_reason <> '' AND char_length(reopen_reason) <= 2000))
  ),
  -- A non-conformance that was closed by the commands says why; the closer is not the person responsible for it.
  ADD CONSTRAINT quality_nonconformance_closer_chk CHECK (closed_by IS NULL OR closed_by <> action_owner_id),
  ADD CONSTRAINT quality_nonconformance_reopen_chk CHECK ((reopen_count = 0) = (reopened_at IS NULL) AND reopen_count >= 0);

ALTER TABLE machvon.corrective_action
  ADD CONSTRAINT corrective_action_text_chk CHECK (
    description = btrim(description) AND description <> '' AND char_length(description) <= 2000
    AND (evidence_note IS NULL OR (evidence_note = btrim(evidence_note) AND evidence_note <> '' AND char_length(evidence_note) <= 2000))
    AND (verification_note IS NULL OR (verification_note = btrim(verification_note) AND verification_note <> '' AND char_length(verification_note) <= 2000))
  ),
  -- What was submitted names the evidence and who submitted it; what was verified or rejected names who did.
  ADD CONSTRAINT corrective_action_submit_chk CHECK (status = 'ASSIGNED' OR (submitted_at IS NOT NULL AND submitted_by IS NOT NULL)),
  ADD CONSTRAINT corrective_action_reject_chk CHECK (status <> 'REJECTED' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verification_note IS NOT NULL));

-- The foreign keys of the owner, the non-conformance and the documents are in V002; the person who verified an action is a member too.
ALTER TABLE machvon.corrective_action
  ADD CONSTRAINT corrective_action_verifier_fk FOREIGN KEY (tenant_id, verified_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT corrective_action_submitter_fk FOREIGN KEY (tenant_id, submitted_by) REFERENCES machvon.membership (tenant_id, id);

REVOKE DELETE, TRUNCATE ON TABLE machvon.quality_nonconformance FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.corrective_action FROM machvon_app;

CREATE FUNCTION machvon.guard_quality_nonconformance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.severity, NEW.ncr_no, NEW.source_kind, NEW.inspection_id, NEW.material_test_id, NEW.site_diary_id, NEW.measurement_id, NEW.action_owner_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.severity, OLD.ncr_no, OLD.source_kind, OLD.inspection_id, OLD.material_test_id, OLD.site_diary_id, OLD.measurement_id, OLD.action_owner_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a non-conformance is about never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('OPEN', 'ACTION_ASSIGNED'), ('REOPENED', 'ACTION_ASSIGNED'), ('ACTION_ASSIGNED', 'ACTION_SUBMITTED'), ('ACTION_SUBMITTED', 'ACTION_ASSIGNED'), ('ACTION_ASSIGNED', 'VERIFIED'),
                   ('ACTION_SUBMITTED', 'VERIFIED'), ('VERIFIED', 'CLOSED'), ('CLOSED', 'REOPENED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'NCR_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  -- A non-conformance is closed once, with its note, after it was verified; a closed one changes only by being reopened.
  IF NEW.status = 'CLOSED' AND OLD.status <> 'CLOSED' AND NEW.closure_note IS NULL THEN
    RAISE EXCEPTION 'NCR_STATE_INVALID: a non-conformance is closed with its note' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'CLOSED' AND NEW.status = 'CLOSED' THEN
    RAISE EXCEPTION 'NCR_STATE_INVALID: a closed non-conformance is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER quality_nonconformance_guard BEFORE INSERT OR UPDATE ON machvon.quality_nonconformance
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_quality_nonconformance();

CREATE FUNCTION machvon.guard_corrective_action() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ASSIGNED' THEN
      RAISE EXCEPTION 'CORRECTIVE_ACTION_STATE_INVALID: an action is assigned first' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.nonconformance_id, NEW.description, NEW.owner_membership_id, NEW.due_at, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.nonconformance_id, OLD.description, OLD.owner_membership_id, OLD.due_at, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an action is about never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('ASSIGNED', 'SUBMITTED'), ('SUBMITTED', 'VERIFIED'), ('SUBMITTED', 'REJECTED'), ('REJECTED', 'SUBMITTED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'CORRECTIVE_ACTION_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  -- An action that was verified is final.
  IF OLD.status = 'VERIFIED' THEN
    RAISE EXCEPTION 'CORRECTIVE_ACTION_STATE_INVALID: a verified action is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER corrective_action_guard BEFORE INSERT OR UPDATE ON machvon.corrective_action
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_corrective_action();

-- Authored by hand (not generated): the warranty claim and the answer to it (ST-AST-004, AST 3.3, BR-AST-03, UAT-AC390, UAT-AC391).
-- The table warranty_claim, its statuses, severities and bearers of the cost, the claim number that is unique in an obligation, the verified claim that names its verifier and the day it was fixed, the guard that no
-- claim is opened on a closed obligation, and no delete are in V002 and V1522. This adds what the answer to a claim records (who acknowledged it and the day the contractor committed to, who said it was put right with
-- its evidence and note, the note of the verification, the time the late answer was escalated), that the days follow one another, that the person who verifies is neither the one who reported the defect nor the one who
-- said it was put right, and a guard that what a claim says never changes, that its status only moves along the lifecycle, and that the issue opened for a late answer and the time it was escalated are written once.

ALTER TABLE machvon.warranty_claim
  ADD COLUMN committed_fix_on date,
  ADD COLUMN acknowledged_by uuid,
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledge_note text,
  ADD COLUMN fixed_by uuid,
  ADD COLUMN fix_note text,
  ADD COLUMN fix_evidence_photo_id uuid,
  ADD COLUMN fix_evidence_document_version_id uuid,
  ADD COLUMN verification_note text,
  ADD COLUMN escalated_at timestamptz;

-- No command wrote a claim before this one, so a claim that stands in a database was put there by hand. One that already stands past the first answer is given the acknowledgement the new constraint asks of it (who and when
-- it was last changed by, and the day the answer was committed to, never before the report), so that it can go on through the lifecycle. The constraints that judge the days, the repair and the verifier are added NOT VALID: they
-- bind every claim written or changed from now on and do not reject the claims already there, which the migration cannot give evidence it never had.
UPDATE machvon.warranty_claim
   SET acknowledged_by = updated_by,
       acknowledged_at = updated_at,
       committed_fix_on = greatest(reported_on, coalesce(fixed_on, response_due_on))
 WHERE status IN ('ACKNOWLEDGED', 'REPAIRING', 'FIXED', 'DISPUTED') AND acknowledged_by IS NULL;

ALTER TABLE machvon.warranty_claim
  ADD CONSTRAINT warranty_claim_dates_chk CHECK (
    response_due_on >= reported_on
    AND (committed_fix_on IS NULL OR committed_fix_on >= reported_on)
    AND (fixed_on IS NULL OR fixed_on >= reported_on)
  ) NOT VALID,
  ADD CONSTRAINT warranty_claim_answer_text_chk CHECK (
    (acknowledge_note IS NULL OR (acknowledge_note = btrim(acknowledge_note) AND acknowledge_note <> '' AND char_length(acknowledge_note) <= 2000))
    AND (fix_note IS NULL OR (fix_note = btrim(fix_note) AND fix_note <> '' AND char_length(fix_note) <= 2000))
    AND (verification_note IS NULL OR (verification_note = btrim(verification_note) AND verification_note <> '' AND char_length(verification_note) <= 2000))
  ),
  ADD CONSTRAINT warranty_claim_ack_chk CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
  -- A claim that is acknowledged, or being put right, names who acknowledged it and the day committed to; one that is fixed also names who fixed it, the day, and the evidence.
  ADD CONSTRAINT warranty_claim_answer_chk CHECK (
    (status NOT IN ('ACKNOWLEDGED', 'REPAIRING', 'FIXED') OR (acknowledged_by IS NOT NULL AND committed_fix_on IS NOT NULL))
    AND (status <> 'FIXED' OR (fixed_by IS NOT NULL AND fixed_on IS NOT NULL AND fix_note IS NOT NULL AND (fix_evidence_photo_id IS NOT NULL OR fix_evidence_document_version_id IS NOT NULL)))
  ) NOT VALID,
  -- The repair is verified by somebody other than the person who reported the defect and the one who said it was put right.
  ADD CONSTRAINT warranty_claim_verifier_chk CHECK (status NOT IN ('VERIFIED', 'CLOSED') OR (verified_by <> reported_by AND (fixed_by IS NULL OR verified_by <> fixed_by))) NOT VALID,
  ADD CONSTRAINT warranty_claim_acknowledged_by_fk FOREIGN KEY (tenant_id, acknowledged_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT warranty_claim_fixed_by_fk FOREIGN KEY (tenant_id, fixed_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT warranty_claim_fix_photo_fk FOREIGN KEY (tenant_id, fix_evidence_photo_id) REFERENCES machvon.site_photo (tenant_id, id),
  ADD CONSTRAINT warranty_claim_fix_document_fk FOREIGN KEY (tenant_id, fix_evidence_document_version_id) REFERENCES machvon.document_version (tenant_id, id);

CREATE INDEX IF NOT EXISTS warranty_claim_fix_evidence_photo_id_idx ON machvon.warranty_claim (tenant_id, fix_evidence_photo_id);
CREATE INDEX IF NOT EXISTS warranty_claim_fix_evidence_document_version_id_idx ON machvon.warranty_claim (tenant_id, fix_evidence_document_version_id);

CREATE FUNCTION machvon.guard_warranty_claim_moves() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.obligation_id, NEW.claim_no, NEW.reported_on, NEW.reported_by, NEW.defect_description, NEW.severity, NEW.location_text, NEW.evidence_photo_id, NEW.evidence_document_version_id,
      NEW.responder_contractor_id, NEW.response_due_on, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.obligation_id, OLD.claim_no, OLD.reported_on, OLD.reported_by, OLD.defect_description, OLD.severity, OLD.location_text, OLD.evidence_photo_id, OLD.evidence_document_version_id,
      OLD.responder_contractor_id, OLD.response_due_on, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a warranty claim says never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('OPEN', 'ACKNOWLEDGED'), ('ACKNOWLEDGED', 'REPAIRING'), ('ACKNOWLEDGED', 'FIXED'), ('REPAIRING', 'FIXED'), ('FIXED', 'VERIFIED'), ('FIXED', 'DISPUTED'), ('DISPUTED', 'FIXED'), ('VERIFIED', 'CLOSED'))) THEN
    RAISE EXCEPTION 'CLAIM_STATE_INVALID: this move of the status of a claim is not allowed' USING ERRCODE = '23514';
  END IF;
  -- The issue opened for a late answer and the time it was escalated are written once; a claim that was acknowledged keeps who acknowledged it and the day committed to.
  IF (OLD.issue_id IS NOT NULL AND NEW.issue_id IS DISTINCT FROM OLD.issue_id)
     OR (OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS DISTINCT FROM OLD.escalated_at)
     OR (OLD.acknowledged_by IS NOT NULL AND (NEW.acknowledged_by, NEW.acknowledged_at, NEW.committed_fix_on) IS DISTINCT FROM (OLD.acknowledged_by, OLD.acknowledged_at, OLD.committed_fix_on)) THEN
    RAISE EXCEPTION 'what the answer to a claim records is written once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER warranty_claim_moves_guard BEFORE UPDATE ON machvon.warranty_claim
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_warranty_claim_moves();

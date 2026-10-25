-- Authored by hand (not generated): the measurements of work done under a contract (ST-CTR-008, CTR 3.4, BR-CTR-03).
-- The table measurement comes from the generated schema (V002, with the extension columns of CTR, the cumulative, correction, decided and maker-checker checks and the unique index of the
-- revision). This adds what the commands rely on: the identity of a measurement is never missing, a measurement that left the draft says who submitted it and carries its evidence, the text
-- is trimmed, the number of the record of the contractor is unique in the contract unless the person says why not, a measurement keeps its place and moves along its edges only, what was
-- approved is never edited (it is corrected, which makes the next revision of the measurement), and nothing is deleted.

ALTER TABLE machvon.measurement
  ADD CONSTRAINT measurement_identity_chk CHECK (contract_id IS NOT NULL AND boq_item_id IS NOT NULL AND created_by IS NOT NULL),
  ADD CONSTRAINT measurement_submitted_chk CHECK (status NOT IN ('SUBMITTED', 'APPROVED', 'REJECTED') OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL)),
  ADD CONSTRAINT measurement_evidence_chk CHECK (jsonb_typeof(evidence_refs) = 'array' AND (status = 'DRAFT' OR jsonb_array_length(evidence_refs) > 0)),
  ADD CONSTRAINT measurement_revision_no_chk CHECK (revision >= 1 AND (correction_of_id IS NULL OR revision > 1)),
  ADD CONSTRAINT measurement_text_chk CHECK (
    (reference_no IS NULL OR (reference_no = btrim(reference_no) AND reference_no <> '' AND char_length(reference_no) <= 2000))
    AND (duplicate_override_reason IS NULL OR (duplicate_override_reason = btrim(duplicate_override_reason) AND duplicate_override_reason <> '' AND char_length(duplicate_override_reason) <= 2000))
    AND (correction_reason IS NULL OR (correction_reason = btrim(correction_reason) AND correction_reason <> '' AND char_length(correction_reason) <= 2000))
  );

-- The number of the record of the contractor is used once in a contract: a second measurement with it is a duplicate unless it says why it is not (the one that was rejected or corrected
-- no longer holds the number). The index of the generated schema only released the number of a corrected one.
DROP INDEX machvon.measurement_reference_uq;
CREATE UNIQUE INDEX measurement_reference_uq ON machvon.measurement (tenant_id, contract_id, reference_no)
  WHERE reference_no IS NOT NULL AND duplicate_override_reason IS NULL AND status NOT IN ('SUPERSEDED', 'REJECTED');

-- A measurement keeps its place: the contract, the revision, the line and the item, the period, the number of its revision and the measurement it corrects never change. Once it is over
-- (rejected, or corrected by another) it is kept as it is. The status moves along DRAFT, SUBMITTED, APPROVED (or REJECTED, or back to DRAFT) and APPROVED, SUPERSEDED; what was approved keeps
-- its quantity, its cumulative, its evidence and its number; and what was submitted keeps its quantity, so the person who decides decides what was sent.
CREATE FUNCTION machvon.guard_measurement() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.contract_revision_id, NEW.boq_line_id, NEW.boq_item_id, NEW.period_id, NEW.revision, NEW.correction_of_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.contract_revision_id, OLD.boq_line_id, OLD.boq_item_id, OLD.period_id, OLD.revision, OLD.correction_of_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a measurement keeps its place' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REJECTED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'a measurement that is over is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('DRAFT', 'SUBMITTED'),
        ('SUBMITTED', 'APPROVED'), ('SUBMITTED', 'REJECTED'), ('SUBMITTED', 'DRAFT'),
        ('APPROVED', 'SUPERSEDED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'MEASUREMENT_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'APPROVED'
     AND (NEW.quantity_period, NEW.quantity_cumulative, NEW.evidence_refs, NEW.reference_no, NEW.duplicate_override_reason, NEW.decided_by, NEW.decided_at, NEW.submitted_by, NEW.submitted_at)
         IS DISTINCT FROM
         (OLD.quantity_period, OLD.quantity_cumulative, OLD.evidence_refs, OLD.reference_no, OLD.duplicate_override_reason, OLD.decided_by, OLD.decided_at, OLD.submitted_by, OLD.submitted_at) THEN
    RAISE EXCEPTION 'a measurement that was approved is corrected, not edited' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SUBMITTED' AND (NEW.quantity_period, NEW.evidence_refs, NEW.reference_no) IS DISTINCT FROM (OLD.quantity_period, OLD.evidence_refs, OLD.reference_no) THEN
    RAISE EXCEPTION 'a measurement that was submitted keeps what was sent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER measurement_guard BEFORE UPDATE ON machvon.measurement
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_measurement();

-- The measurements of a contract are part of its dossier: no command deletes one, and the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.measurement FROM machvon_app;

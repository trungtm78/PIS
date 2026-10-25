-- Authored by hand (not generated): the acceptance of work done under a contract (ST-CTR-009, CTR 3.4, BR-CTR-05).
-- The tables acceptance and acceptance_line come from the generated schema (V002, with the foreign keys, the unique index of an active line for a measurement and the checks of the approval and of
-- the maker and the checker). This adds what the commands rely on: the day of the acceptance (the day the price of each line was taken), who sent it and when, the reason of a decision, who
-- rejected it and who revoked it and why, the shape of each status, the guard of the edges of the status, and a line that is kept as it is.
-- A line is created inactive and counts as accepted only when the acceptance is approved (it becomes active then, and again inactive when the acceptance is revoked): two acceptances can wait with
-- the same measurement, and the unique index lets only one of them be approved.

ALTER TABLE machvon.acceptance
  ADD COLUMN accepted_on date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN decision_reason text,
  ADD COLUMN decision_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN rejected_by uuid,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid,
  ADD COLUMN revoke_reason text,
  ADD COLUMN revoke_approval_document_version_id uuid;

ALTER TABLE machvon.acceptance
  ADD CONSTRAINT acceptance_text_chk CHECK (
    (acceptance_no IS NULL OR (acceptance_no = btrim(acceptance_no) AND acceptance_no <> '' AND char_length(acceptance_no) <= 100))
    AND (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND decision_reason <> '' AND char_length(decision_reason) <= 2000))
    AND (revoke_reason IS NULL OR (revoke_reason = btrim(revoke_reason) AND revoke_reason <> '' AND char_length(revoke_reason) <= 2000))
  ),
  ADD CONSTRAINT acceptance_lists_chk CHECK (
    jsonb_typeof(measurement_ids) = 'array' AND jsonb_array_length(measurement_ids) > 0
    AND jsonb_typeof(signer_refs) = 'array' AND jsonb_typeof(decision_evidence_ids) = 'array'
  ),
  ADD CONSTRAINT acceptance_amount_chk CHECK (accepted_amount_vnd > 0),
  -- A draft has not been sent; every other status has.
  ADD CONSTRAINT acceptance_submitted_chk CHECK ((status = 'DRAFT') = (submitted_by IS NULL AND submitted_at IS NULL)),
  -- Approved and revoked acceptances carry the approval; rejected ones carry the rejection; the reason of a decision is kept with every decision.
  ADD CONSTRAINT acceptance_decided_chk CHECK (
    ((status IN ('APPROVED', 'REVOKED')) = (approved_at IS NOT NULL AND decided_by IS NOT NULL))
    AND ((status = 'REJECTED') = (rejected_at IS NOT NULL AND rejected_by IS NOT NULL))
    AND ((status IN ('APPROVED', 'REJECTED', 'REVOKED')) = (decision_reason IS NOT NULL))
  ),
  ADD CONSTRAINT acceptance_revoked_chk CHECK (
    (status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL AND revoke_approval_document_version_id IS NOT NULL)
  ),
  -- Whoever rejects does not send, and whoever revokes neither sent nor approved.
  ADD CONSTRAINT acceptance_reject_checker_chk CHECK (rejected_by IS NULL OR submitted_by IS NULL OR rejected_by <> submitted_by),
  ADD CONSTRAINT acceptance_revoke_checker_chk CHECK (revoked_by IS NULL OR ((submitted_by IS NULL OR revoked_by <> submitted_by) AND (decided_by IS NULL OR revoked_by <> decided_by)));

-- The paper that approves a revocation is looked up with the tenant like every other identifier.
CREATE INDEX acceptance_revoke_approval_document_version_id_idx ON machvon.acceptance (tenant_id, revoke_approval_document_version_id);

-- What an acceptance says never changes: the contract, the measurements, the paper, the period, the number, the day and the amount. It moves DRAFT -> SUBMITTED -> APPROVED | REJECTED | DRAFT,
-- and APPROVED -> REVOKED; rejected and revoked acceptances are kept as they are, and the approval of an approved one does not change.
CREATE FUNCTION machvon.guard_acceptance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.measurement_ids, NEW.document_version_id, NEW.period_id, NEW.acceptance_no, NEW.accepted_on, NEW.accepted_amount_vnd, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.measurement_ids, OLD.document_version_id, OLD.period_id, OLD.acceptance_no, OLD.accepted_on, OLD.accepted_amount_vnd, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an acceptance says never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REJECTED', 'REVOKED') THEN
    RAISE EXCEPTION 'an acceptance that is over is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'APPROVED' AND (NEW.approved_at, NEW.decided_by, NEW.decision_reason, NEW.quality_acceptance_id, NEW.signer_refs, NEW.submitted_by) IS DISTINCT FROM
     (OLD.approved_at, OLD.decided_by, OLD.decision_reason, OLD.quality_acceptance_id, OLD.signer_refs, OLD.submitted_by) THEN
    RAISE EXCEPTION 'the approval of an acceptance is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'SUBMITTED'), ('SUBMITTED', 'APPROVED'), ('SUBMITTED', 'REJECTED'), ('SUBMITTED', 'DRAFT'), ('APPROVED', 'REVOKED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'ACCEPTANCE_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  -- Sent, an acceptance is worth what its lines are worth, and rests on one line for each measurement it names.
  IF NEW.status = 'SUBMITTED' AND OLD.status = 'DRAFT' AND (
    (SELECT COALESCE(sum(amount_vnd), 0) FROM machvon.acceptance_line WHERE tenant_id = NEW.tenant_id AND acceptance_id = NEW.id) <> NEW.accepted_amount_vnd
    OR (SELECT count(*) FROM machvon.acceptance_line WHERE tenant_id = NEW.tenant_id AND acceptance_id = NEW.id) <> jsonb_array_length(NEW.measurement_ids)
  ) THEN
    RAISE EXCEPTION 'an acceptance is worth what its lines are worth' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER acceptance_guard BEFORE UPDATE ON machvon.acceptance
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_acceptance();

-- A line is written with its acceptance while it is a draft, and never changes: the quantity, the price of the day and the amount are the ones the acceptance was worth. Only whether it counts
-- as accepted changes, with the acceptance: it counts when the acceptance is approved and stops counting when it is revoked.
CREATE FUNCTION machvon.guard_acceptance_line() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM machvon.acceptance WHERE tenant_id = NEW.tenant_id AND id = NEW.acceptance_id;
  IF TG_OP = 'INSERT' THEN
    IF parent_status IS DISTINCT FROM 'DRAFT' OR NEW.active THEN
      RAISE EXCEPTION 'a line is written with its acceptance, while it is a draft, and does not count yet' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.acceptance_id, NEW.measurement_id, NEW.boq_item_id, NEW.party_id, NEW.contract_revision_id, NEW.quantity, NEW.unit_price_snapshot, NEW.amount_vnd, NEW.retention_pct_snapshot, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.acceptance_id, OLD.measurement_id, OLD.boq_item_id, OLD.party_id, OLD.contract_revision_id, OLD.quantity, OLD.unit_price_snapshot, OLD.amount_vnd, OLD.retention_pct_snapshot, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a line of an acceptance says never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active AND NOT ((NEW.active AND parent_status = 'APPROVED') OR (NOT NEW.active AND parent_status = 'REVOKED')) THEN
    RAISE EXCEPTION 'a line counts when its acceptance is approved and stops counting when it is revoked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER acceptance_line_guard BEFORE INSERT OR UPDATE ON machvon.acceptance_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_acceptance_line();

-- The acceptances of a contract and their lines are part of its dossier: no command deletes them, and the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.acceptance FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.acceptance_line FROM machvon_app;

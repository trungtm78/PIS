-- Authored by hand (not generated): the result of the selection of a contractor (ST-BID-006, BID 3 F7).
-- The table procurement_result comes from the generated schema (V002). This adds what the commands rely on: the evaluation minutes that the result rests on while the structured
-- evaluation report does not exist yet (ST-BID-012), when the result was submitted and who turned it down and why, the shape of each outcome, the guarantee that one result is open
-- for a package at a time, and a result that is kept as it was written once it is decided.

ALTER TABLE machvon.procurement_result
  ADD COLUMN evaluation_minutes_document_id uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN rejected_by uuid,
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN decision_comment text;

ALTER TABLE machvon.procurement_result ADD FOREIGN KEY (tenant_id, evaluation_minutes_document_id) REFERENCES machvon.document (tenant_id, id);
CREATE INDEX procurement_result_evaluation_minutes_document_id_idx ON machvon.procurement_result (tenant_id, evaluation_minutes_document_id);

-- An award names its winner and its price (procurement_result_award_chk); the other two outcomes name neither.
ALTER TABLE machvon.procurement_result
  ADD CONSTRAINT procurement_result_outcome_chk CHECK (outcome = 'AWARDED' OR (winner_contractor_id IS NULL AND award_price_vnd IS NULL));

-- A result that is submitted or rejected rests on an evaluation: the structured report, or, until that exists, the evaluation minutes issued through DOC. (An approved result was submitted
-- first, and what it rests on never changes; rows that were written before this existed carry neither.)
ALTER TABLE machvon.procurement_result
  ADD CONSTRAINT procurement_result_basis_chk CHECK (
    status NOT IN ('SUBMITTED', 'REJECTED') OR evaluation_report_id IS NOT NULL OR evaluation_minutes_document_id IS NOT NULL
  );

-- Whoever submitted it, once it is no longer a draft (a draft that was cancelled never was submitted).
ALTER TABLE machvon.procurement_result
  ADD CONSTRAINT procurement_result_submitted_chk CHECK (status IN ('DRAFT', 'CANCELLED') OR submitted_by IS NOT NULL);

-- Approval has its day (the people and the decision document are held by procurement_result_approved_chk); a rejection has its decider, its day and its reason, and the decider is not
-- the one who submitted the result.
ALTER TABLE machvon.procurement_result
  ADD CONSTRAINT procurement_result_approved_at_chk CHECK (status <> 'APPROVED' OR approved_at IS NOT NULL),
  ADD CONSTRAINT procurement_result_rejected_chk CHECK (
    (status = 'REJECTED') = (rejected_by IS NOT NULL)
    AND (status <> 'REJECTED' OR (rejected_by <> submitted_by AND rejected_at IS NOT NULL AND decision_comment IS NOT NULL AND btrim(decision_comment) <> ''))
  ),
  ADD CONSTRAINT procurement_result_comment_chk CHECK (decision_comment IS NULL OR char_length(decision_comment) <= 2000);

-- One result is open for a package at a time: a result is decided (or cancelled) before the next one is submitted.
CREATE UNIQUE INDEX procurement_result_one_open_uq ON machvon.procurement_result (tenant_id, package_id) WHERE status IN ('DRAFT', 'SUBMITTED');

-- What a result says never changes: only its status moves, along DRAFT or SUBMITTED to a decision, and a decided result is kept as it is.
CREATE FUNCTION machvon.guard_procurement_result() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.package_id, NEW.outcome, NEW.winner_contractor_id, NEW.award_price_vnd, NEW.evaluation_report_id, NEW.evaluation_minutes_document_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.package_id, OLD.outcome, OLD.winner_contractor_id, OLD.award_price_vnd, OLD.evaluation_report_id, OLD.evaluation_minutes_document_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a result of the selection says never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a decided result is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'SUBMITTED'), ('DRAFT', 'CANCELLED'), ('SUBMITTED', 'APPROVED'), ('SUBMITTED', 'REJECTED'), ('SUBMITTED', 'CANCELLED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'RESULT_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER procurement_result_guard BEFORE UPDATE ON machvon.procurement_result
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_procurement_result();

-- The results of a package are part of its dossier: no command deletes one, and the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.procurement_result FROM machvon_app;

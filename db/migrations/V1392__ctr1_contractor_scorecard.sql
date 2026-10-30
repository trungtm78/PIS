-- Authored by hand (not generated): the scorecard of a contractor and the log of its violations (ST-CTR-014, CTR 3.6, BR-CTR-11, UAT-AC315, UAT-PLAN-17).
-- The tables contractor_performance and contractor_violation, the approver who is not the evaluator, the approved row that has its day and the sanction that rests on a document of decision are in V002 and
-- V1385. This adds that an evaluation is open once for a kind and a period and approved once, that what an evaluation says never changes (a correction is a new revision), that a violation names who confirmed
-- it, when, and that it was not the person who recorded it, the guards of the moves of the status of both, and that neither is ever deleted.

ALTER TABLE machvon.contractor_violation
  ADD COLUMN confirmed_by uuid,
  ADD COLUMN confirmed_at timestamptz;

ALTER TABLE machvon.contractor_violation
  ADD CONSTRAINT contractor_violation_confirmed_by_fk FOREIGN KEY (tenant_id, confirmed_by) REFERENCES machvon.membership (tenant_id, id),
  -- A violation that was confirmed has the person who confirmed it and the time; the one who confirms it is not the one who recorded it.
  ADD CONSTRAINT contractor_violation_confirmation_chk CHECK (
    (confirmed_by IS NULL) = (confirmed_at IS NULL)
    AND (status = 'REVOKED' OR (status = 'RECORDED') = (confirmed_by IS NULL))
    AND (confirmed_by IS NULL OR confirmed_by <> created_by)
  ),
  -- A sanction is an amount only for liquidated damages, and there it is more than zero.
  ADD CONSTRAINT contractor_violation_amount_chk CHECK ((penalty_kind = 'LIQUIDATED_DAMAGES') = (penalty_amount_vnd > 0)),
  ADD CONSTRAINT contractor_violation_description_chk CHECK (description = btrim(description) AND description <> '' AND char_length(description) <= 2000);

-- A suggestion that a termination made (V1385) is recorded with a sanction already chosen: it is a proposal until a person confirms it, with a sanction that the amount rule allows.
-- The scorecard reads the confirmed violations of a contractor by day.
CREATE INDEX contractor_violation_confirmed_idx ON machvon.contractor_violation (tenant_id, contractor_id, occurred_on) WHERE status = 'CONFIRMED';

-- One evaluation is open for a contract, a kind and a period at a time, and one is approved: a new approval for the same period supersedes the one before it (a revision).
CREATE UNIQUE INDEX contractor_performance_open_uq ON machvon.contractor_performance (tenant_id, contract_id, evaluation_kind, period_label) WHERE status IN ('DRAFT', 'SUBMITTED');
CREATE UNIQUE INDEX contractor_performance_approved_uq ON machvon.contractor_performance (tenant_id, contract_id, evaluation_kind, period_label) WHERE status = 'APPROVED';

-- The words of the approver, kept with the approval and never in the trail.
ALTER TABLE machvon.contractor_performance
  ADD COLUMN approval_note text;

ALTER TABLE machvon.contractor_performance
  ADD CONSTRAINT contractor_performance_remarks_chk CHECK (remarks IS NULL OR (remarks = btrim(remarks) AND remarks <> '' AND char_length(remarks) <= 2000)),
  ADD CONSTRAINT contractor_performance_note_chk CHECK (approval_note IS NULL OR (approval_note = btrim(approval_note) AND approval_note <> '' AND char_length(approval_note) <= 2000 AND approved_by IS NOT NULL)),
  ADD CONSTRAINT contractor_performance_period_chk CHECK (period_label = btrim(period_label) AND period_label <> '' AND char_length(period_label) <= 40),
  -- Whoever approved an evaluation is on it, with the day; an evaluation that waits for approval has neither.
  ADD CONSTRAINT contractor_performance_approval_chk CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (status IN ('DRAFT', 'SUBMITTED')) = (approved_by IS NULL));

CREATE FUNCTION machvon.guard_contractor_performance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.contractor_id, NEW.evaluation_kind, NEW.period_label, NEW.revision, NEW.score_quality, NEW.score_schedule, NEW.score_safety_env, NEW.score_cooperation, NEW.score_financial,
      NEW.overall_score, NEW.rating, NEW.weights_rule_version_id, NEW.remarks, NEW.evaluated_by, NEW.supersedes_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.contractor_id, OLD.evaluation_kind, OLD.period_label, OLD.revision, OLD.score_quality, OLD.score_schedule, OLD.score_safety_env, OLD.score_cooperation, OLD.score_financial,
      OLD.overall_score, OLD.rating, OLD.weights_rule_version_id, OLD.remarks, OLD.evaluated_by, OLD.supersedes_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an evaluation says never changes: a correction is a new revision' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('APPROVED', 'SUPERSEDED') AND (NEW.approved_by, NEW.approved_at, NEW.approval_note) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.approval_note) THEN
    RAISE EXCEPTION 'the approval of an evaluation does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'SUBMITTED'), ('DRAFT', 'APPROVED'), ('SUBMITTED', 'APPROVED'), ('APPROVED', 'SUPERSEDED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'this move of the status of an evaluation is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contractor_performance_guard BEFORE UPDATE ON machvon.contractor_performance
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_performance();

CREATE FUNCTION machvon.guard_contractor_violation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.contractor_id, NEW.violation_kind, NEW.severity, NEW.occurred_on, NEW.description, NEW.evidence_document_version_id, NEW.source_module, NEW.source_ref_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.contractor_id, OLD.violation_kind, OLD.severity, OLD.occurred_on, OLD.description, OLD.evidence_document_version_id, OLD.source_module, OLD.source_ref_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a violation says never changes' USING ERRCODE = '23514';
  END IF;
  -- The sanction and its decision are chosen once, when the violation is confirmed; they are not changed afterwards, whatever happens to its status.
  IF OLD.status <> 'RECORDED' AND (NEW.penalty_kind, NEW.penalty_amount_vnd, NEW.decision_document_version_id, NEW.confirmed_by, NEW.confirmed_at)
     IS DISTINCT FROM (OLD.penalty_kind, OLD.penalty_amount_vnd, OLD.decision_document_version_id, OLD.confirmed_by, OLD.confirmed_at) THEN
    RAISE EXCEPTION 'the sanction of a confirmed violation does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('RECORDED', 'CONFIRMED'), ('RECORDED', 'REVOKED'), ('CONFIRMED', 'APPEALED'), ('CONFIRMED', 'REVOKED'), ('APPEALED', 'CONFIRMED'), ('APPEALED', 'REVOKED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'this move of the status of a violation is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contractor_violation_guard BEFORE UPDATE ON machvon.contractor_violation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_violation();

-- Neither the scorecard nor the log of violations is ever deleted.
REVOKE DELETE, TRUNCATE ON machvon.contractor_performance, machvon.contractor_violation FROM machvon_app;

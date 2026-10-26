-- ST-DIS-005: the transactional submit of a weekly report (DIS 3 F1 step 8, BR-DIS-07, BR-DIS-09).
--
-- A report that is no longer a draft was handed in by someone at a time the server took: the table says so (SUBMITTED, UNDER_REVIEW, ACCEPTED, RETURNED, AMENDMENT_REQUESTED, WITHDRAWN and SUPERSEDED
-- all carry `submitted_by` and `submitted_at`), and what the submit sealed (who, when, whether it was late, the hash of the content) is fixed once the report leaves the draft: the review that follows moves
-- the status, who decided and the current mark, and nothing else of it.

ALTER TABLE machvon.report_revision
  ADD CONSTRAINT report_revision_submitted_chk CHECK (status = 'DRAFT' OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL));

CREATE OR REPLACE FUNCTION machvon.report_revision_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a report revision is kept: a draft is deleted softly, a submitted one is never deleted' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_guard';
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.period_id <> OLD.period_id OR NEW.plan_version_id <> OLD.plan_version_id OR NEW.revision <> OLD.revision
     OR NEW.report_type <> OLD.report_type OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'a report revision keeps its project, period, plan version, number and type for good' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_identity_guard';
  END IF;
  -- What was handed in is not edited: only the transitions of the review (status, who decided, the current mark) move a revision that is no longer a draft.
  IF OLD.status <> 'DRAFT' AND (NEW.measurement_basis <> OLD.measurement_basis OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.negative_delta_explanation IS DISTINCT FROM OLD.negative_delta_explanation OR NEW.source_kind <> OLD.source_kind) THEN
    RAISE EXCEPTION 'a submitted report revision is not edited' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_immutable_guard';
  END IF;
  -- What the submit sealed is fixed with it.
  IF OLD.status <> 'DRAFT' AND (NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.is_late <> OLD.is_late
     OR NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id) THEN
    RAISE EXCEPTION 'who handed a report in, when, and whether it was late are fixed with the submit' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_sealed_guard';
  END IF;
  RETURN NEW;
END
$fn$;

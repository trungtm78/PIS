-- ST-DIS-007: the withdrawal of a report that was handed in, and the soft deletion and restore of a draft (DIS 3 F3).
--
-- 1. A report that was withdrawn says who took it back, when and why (at least 20 characters); the three go together with the status, and they are fixed once written.
-- 2. A draft is deleted with a reason and the instant of the deletion; a deletion is not rewritten while it stands (a draft is restored, which clears both, or it stays deleted). Only a draft is ever
--    deleted (V1042 `report_revision_delete_chk`).

ALTER TABLE machvon.report_revision
  ADD COLUMN withdrawn_by uuid,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_reason text;

ALTER TABLE machvon.report_revision
  ADD CONSTRAINT report_revision_withdrawn_chk CHECK ((status = 'WITHDRAWN') = (withdrawn_by IS NOT NULL) AND (withdrawn_by IS NULL) = (withdrawn_at IS NULL) AND (withdrawn_by IS NULL) = (withdrawn_reason IS NULL)),
  ADD CONSTRAINT report_revision_withdrawn_reason_chk CHECK (withdrawn_reason IS NULL OR (withdrawn_reason = btrim(withdrawn_reason) AND char_length(withdrawn_reason) BETWEEN 20 AND 2000));

CREATE OR REPLACE FUNCTION machvon.report_revision_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a report revision is kept: a draft is deleted softly, a submitted one is never deleted' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_guard';
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.period_id <> OLD.period_id OR NEW.plan_version_id <> OLD.plan_version_id OR NEW.revision <> OLD.revision
     OR NEW.report_type <> OLD.report_type OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.amendment_reason IS DISTINCT FROM OLD.amendment_reason THEN
    RAISE EXCEPTION 'a report revision keeps its project, period, plan version, number, type and the reason it was made for good' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_identity_guard';
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
  -- Who accepted a report and when are fixed with the acceptance.
  IF OLD.accepted_by IS NOT NULL AND (NEW.accepted_by IS DISTINCT FROM OLD.accepted_by OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at) THEN
    RAISE EXCEPTION 'who accepted a report and when are fixed with the acceptance' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_accepted_guard';
  END IF;
  -- Who withdrew a report, when and why are fixed with the withdrawal.
  IF OLD.withdrawn_by IS NOT NULL AND (NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason) THEN
    RAISE EXCEPTION 'who withdrew a report, when and why are fixed with the withdrawal' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_withdrawn_guard';
  END IF;
  -- A deletion stands as it was made until the draft is restored.
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL AND (NEW.deleted_at <> OLD.deleted_at OR NEW.deleted_reason IS DISTINCT FROM OLD.deleted_reason) THEN
    RAISE EXCEPTION 'a deletion stands as it was made until the draft is restored' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_deleted_guard';
  END IF;
  -- A report moves along the graph of its state machine and no other way.
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED')
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('UNDER_REVIEW', 'ACCEPTED', 'RETURNED', 'WITHDRAWN'))
    OR (OLD.status = 'UNDER_REVIEW' AND NEW.status IN ('ACCEPTED', 'RETURNED'))
    OR (OLD.status = 'ACCEPTED' AND NEW.status IN ('AMENDMENT_REQUESTED', 'SUPERSEDED'))
    OR (OLD.status = 'AMENDMENT_REQUESTED' AND NEW.status = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'a report does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'report_revision_transition_guard';
  END IF;
  RETURN NEW;
END
$fn$;

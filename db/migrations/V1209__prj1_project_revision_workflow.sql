-- Authored by hand (not generated): the revisions of a project (ST-PRJ-008, PRJ 3.1 F6, BR-PRJ-13).
-- V002 gave `project_revision` its columns, the check that an approved revision names its document and day, the check that the one who decides is not the one who proposed and the unique number of a
-- revision inside a project; V1201 took away the right to delete. This adds what the decision leaves behind (the reason), the keys to the project, the document and the revision it replaces, the one
-- pending revision of a project, and a guard that keeps the order of a revision's life.

ALTER TABLE machvon.project_revision ADD COLUMN decision_reason text;

-- A revision other than the first is proposed IN_REVIEW and ends APPROVED or REJECTED (an approved one is SUPERSEDED by the next approval); whoever decided it, when and why is on it, and nothing is on a
-- revision that was not decided. The first revision (INITIAL) is written with the project and is not decided here.
ALTER TABLE machvon.project_revision
  ADD CONSTRAINT project_revision_decided_chk CHECK (
    change_kind = 'INITIAL'
    OR (
      ((status IN ('DRAFT', 'IN_REVIEW')) = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL))
      AND (status NOT IN ('APPROVED', 'REJECTED', 'SUPERSEDED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL))
      AND (status NOT IN ('DRAFT', 'IN_REVIEW') OR (decision_document_id IS NULL AND effective_from IS NULL))
    )
  ),
  ADD CONSTRAINT project_revision_reason_chk CHECK (change_kind = 'INITIAL' OR char_length(reason) BETWEEN 10 AND 2000),
  ADD CONSTRAINT project_revision_decision_reason_chk CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 5 AND 2000);

ALTER TABLE machvon.project_revision
  ADD CONSTRAINT project_revision_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  ADD CONSTRAINT project_revision_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id),
  ADD CONSTRAINT project_revision_supersedes_fk FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.project_revision (tenant_id, id);

-- One revision waits for a decision at a time.
CREATE UNIQUE INDEX project_revision_pending_uq ON machvon.project_revision (tenant_id, project_id) WHERE status = 'IN_REVIEW';
CREATE INDEX project_revision_list_idx ON machvon.project_revision (tenant_id, project_id, revision DESC);
CREATE INDEX project_revision_document_idx ON machvon.project_revision (tenant_id, decision_document_id) WHERE decision_document_id IS NOT NULL;

-- DRAFT -> IN_REVIEW -> APPROVED | REJECTED, APPROVED -> SUPERSEDED; a rejected or superseded revision never changes again, an approved one changes only to be superseded, and what a revision proposes
-- (its project, number, kind, before and after, total, reason, author) never changes at all.
CREATE FUNCTION machvon.guard_project_revision_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status IN ('REJECTED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'a rejected or superseded revision is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.change_kind IS DISTINCT FROM OLD.change_kind
     OR NEW.before_json IS DISTINCT FROM OLD.before_json OR NEW.after_json IS DISTINCT FROM OLD.after_json OR NEW.total_investment_vnd IS DISTINCT FROM OLD.total_investment_vnd
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a revision keeps what it proposed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'APPROVED' AND (NEW.status <> 'SUPERSEDED' OR NEW.decision_document_id IS DISTINCT FROM OLD.decision_document_id OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
    RAISE EXCEPTION 'an approved revision can only be superseded' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'IN_REVIEW' AND NEW.status = 'DRAFT' THEN
    RAISE EXCEPTION 'a revision does not go back to a draft' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('DRAFT', 'IN_REVIEW') AND NEW.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'only an approved revision is superseded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_revision_update_guard BEFORE UPDATE ON machvon.project_revision
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_revision_update();

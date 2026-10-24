-- Authored by hand (not generated): the appraisal sheets of a project (ST-PRJ-003, PRJ 3.1 F2, BR-PRJ-03 to BR-PRJ-05).
-- The table project_appraisal comes from the generated schema (V002); this adds what the appraisal relies on: the columns of the decision,
-- the shape checks, the keys to the project and to the decision document, a guard that keeps a decided or voided sheet as it was, a guard
-- that keeps the proposer of a project from appraising or deciding it, and the loss of the right to delete (a sheet is kept for good).

ALTER TABLE machvon.project_appraisal ALTER COLUMN status SET DEFAULT 'SUBMITTED';

-- The decision is taken once for the round and written on every sheet of the round: what was decided, why, against what the sheets said,
-- and for ADMIT the group the project was put in.
ALTER TABLE machvon.project_appraisal ADD COLUMN decision_reason text;
ALTER TABLE machvon.project_appraisal ADD COLUMN override_reason text;
ALTER TABLE machvon.project_appraisal ADD COLUMN decided_group text;
-- What the appraiser wrote about the sheet (the opinion of PRJ-10).
ALTER TABLE machvon.project_appraisal ADD COLUMN note text;
ALTER TABLE machvon.project_appraisal ADD CONSTRAINT project_appraisal_note_chk CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 2000));

ALTER TABLE machvon.project_appraisal
  ADD CONSTRAINT project_appraisal_scores_chk CHECK (jsonb_typeof(scores_json) = 'array' AND jsonb_array_length(scores_json) BETWEEN 1 AND 50);

-- A decision is only on a decided sheet; a decided sheet says who decided when and why; an ADMIT names the decision document and the group;
-- the other decisions name no group; an override reason is a real reason (at least 20 characters, as the contract says).
ALTER TABLE machvon.project_appraisal
  ADD CONSTRAINT project_appraisal_decision_shape_chk CHECK (
    (status = 'DECIDED') = (decision IS NOT NULL)
    AND (status <> 'DECIDED' OR (decided_at IS NOT NULL AND decision_reason IS NOT NULL AND btrim(decision_reason) <> ''))
    AND (status = 'DECIDED' OR (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND override_reason IS NULL AND decided_group IS NULL))
    AND (override_reason IS NULL OR length(btrim(override_reason)) >= 20)
    AND (decision IS DISTINCT FROM 'ADMIT' OR (decision_document_id IS NOT NULL AND decided_group IS NOT NULL))
    AND (decision IS NOT DISTINCT FROM 'ADMIT' OR decided_group IS NULL)
    AND (decided_group IS NULL OR decided_group IN ('QTQG', 'A', 'B', 'C'))
  );

ALTER TABLE machvon.project_appraisal
  ADD CONSTRAINT project_appraisal_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id);
ALTER TABLE machvon.project_appraisal
  ADD CONSTRAINT project_appraisal_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id);

CREATE INDEX project_appraisal_round_status_idx ON machvon.project_appraisal (tenant_id, project_id, round, status);
CREATE INDEX project_appraisal_decision_document_idx ON machvon.project_appraisal (tenant_id, decision_document_id) WHERE decision_document_id IS NOT NULL;

-- A sheet moves DRAFT -> SUBMITTED -> DECIDED, or is voided from DRAFT or SUBMITTED (the project was cancelled); a decided or voided sheet
-- never changes again, and what names the sheet (project, round, appraiser, criteria set, creator) never changes at all.
CREATE FUNCTION machvon.guard_project_appraisal_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status IN ('DECIDED', 'VOID') THEN
    RAISE EXCEPTION 'a decided or voided appraisal sheet is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.round IS DISTINCT FROM OLD.round
     OR NEW.appraiser_membership_id IS DISTINCT FROM OLD.appraiser_membership_id OR NEW.criteria_set_version_id IS DISTINCT FROM OLD.criteria_set_version_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an appraisal sheet keeps its project, round, appraiser and criteria set' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'DRAFT' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'an appraisal sheet does not go back to a draft' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_appraisal_update_guard BEFORE UPDATE ON machvon.project_appraisal
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_appraisal_update();

-- The person who proposed a project (created it, or sent it to appraisal) neither scores it nor decides on it (PRJ 3.1 section 2).
CREATE FUNCTION machvon.guard_project_appraisal_proposer() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  who uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    who := NEW.appraiser_membership_id;
  ELSIF NEW.decided_by IS NOT NULL AND NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
    who := NEW.decided_by;
  ELSE
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM machvon.project p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id AND p.created_by = who)
     OR EXISTS (
       SELECT 1 FROM machvon.project_stage_change c
        WHERE c.tenant_id = NEW.tenant_id AND c.project_id = NEW.project_id AND c.operation = 'submitProjectForAppraisal' AND c.actor_kind = 'USER' AND c.actor_id = who
     ) THEN
    RAISE EXCEPTION 'the proposer of a project does not appraise it or decide on it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_appraisal_proposer_guard BEFORE INSERT OR UPDATE ON machvon.project_appraisal
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_appraisal_proposer();

-- The sheets say who judged a project and on what; they are kept with the project (PRJ.md section 6: retention permanent) and no command
-- deletes one.
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_appraisal FROM machvon_app;

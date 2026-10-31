-- Authored by hand (not generated): the investment evaluation of a project, from its plan to its decision (ST-MNE-009, MNE F9, BR-MNE-08, UAT-AC292).
-- V002 gave `mne_evaluation` its columns, the status, the check that a submitted evaluation has a conclusion and a day, and the check that the approver is not the planner. This keeps who submitted and who decided, and when, with the
-- reason of the decision; says that the findings are a list, that the texts are trimmed and sized, that a decision is by one who neither planned nor submitted the evaluation, that the report an approved evaluation is linked to is
-- set only then, and moves the status along the edges of MNE 4 and nowhere else; what was submitted does not change; an evaluation is never deleted.

ALTER TABLE machvon.mne_evaluation
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN decided_by uuid,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text;

-- The evaluations that exist were made before the workflow kept who submitted and who decided: they are given what the table did know (the last person to touch an evaluation submitted it, and an approval was decided by the approver, with the
-- day it was last changed), and the new checks are added NOT VALID so that they judge what is written from now on and do not refuse a database that holds a row written under the old rules.
-- The migration runs as the owner of the tables, to which row-level security applies: it works tenant by tenant.
DO $backfill$
DECLARE
  one_tenant uuid;
BEGIN
  FOR one_tenant IN SELECT id FROM machvon.tenant ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', one_tenant::text, true);
    UPDATE machvon.mne_evaluation SET submitted_by = updated_by, submitted_at = updated_at WHERE status IN ('SUBMITTED', 'APPROVED', 'RETURNED') AND submitted_by IS NULL;
    -- The texts are brought to the shape the checks ask for (trimmed, not too short, not too long), because the guard makes them unchangeable and a row that could not be repaired would be stuck: a short text is marked as written before.
    UPDATE machvon.mne_evaluation
       SET evaluator_name = btrim(left(btrim(evaluator_name), 300)),
           scope_text = btrim(left(btrim(scope_text), 2000)),
           recommendations_text = nullif(btrim(left(btrim(recommendations_text), 2000)), '')
     WHERE evaluator_name <> btrim(evaluator_name) OR char_length(evaluator_name) > 300 OR scope_text <> btrim(scope_text) OR char_length(scope_text) > 2000
        OR (recommendations_text IS NOT NULL AND (recommendations_text <> btrim(recommendations_text) OR char_length(recommendations_text) NOT BETWEEN 1 AND 2000));
    UPDATE machvon.mne_evaluation
       SET evaluator_name = CASE WHEN char_length(evaluator_name) < 2 THEN evaluator_name || ' (n/a)' ELSE evaluator_name END,
           scope_text = CASE WHEN char_length(scope_text) < 10 THEN scope_text || ' (scope recorded before the workflow)' ELSE scope_text END
     WHERE char_length(evaluator_name) < 2 OR char_length(scope_text) < 10;
    -- The findings are a list: a value of the old table that is not one becomes a list of that value (nothing becomes an empty list), so that the evaluation can still be decided.
    UPDATE machvon.mne_evaluation SET findings_json = CASE jsonb_typeof(findings_json) WHEN 'null' THEN '[]'::jsonb ELSE jsonb_build_array(findings_json) END WHERE jsonb_typeof(findings_json) <> 'array';
    UPDATE machvon.mne_evaluation SET decided_by = coalesce(approved_by, updated_by), decided_at = updated_at, decision_reason = 'Decided before the workflow kept the reason of a decision' WHERE status IN ('APPROVED', 'RETURNED') AND decided_by IS NULL;
  END LOOP;
END
$backfill$;

ALTER TABLE machvon.mne_evaluation
  ADD CONSTRAINT mne_evaluation_text_chk CHECK (
    evaluator_name = btrim(evaluator_name) AND char_length(evaluator_name) BETWEEN 2 AND 300
    AND scope_text = btrim(scope_text) AND char_length(scope_text) BETWEEN 10 AND 2000
    AND (recommendations_text IS NULL OR (recommendations_text = btrim(recommendations_text) AND char_length(recommendations_text) <= 2000))
    AND (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 5 AND 2000))
  ) NOT VALID,
  ADD CONSTRAINT mne_evaluation_findings_chk CHECK (jsonb_typeof(findings_json) = 'array') NOT VALID,
  ADD CONSTRAINT mne_evaluation_submitted_chk CHECK ((submitted_by IS NULL) = (submitted_at IS NULL) AND (status NOT IN ('SUBMITTED', 'APPROVED', 'RETURNED') OR submitted_by IS NOT NULL)) NOT VALID,
  -- A decision is one fact: who, when and why together, and it stands only while the evaluation is decided (a returned one that is submitted again starts afresh).
  ADD CONSTRAINT mne_evaluation_decision_chk CHECK (
    (decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL) = (decision_reason IS NULL)
    AND (status IN ('APPROVED', 'RETURNED')) = (decided_by IS NOT NULL)
    AND (status = 'APPROVED') = (approved_by IS NOT NULL)
    AND (approved_by IS NULL OR approved_by = decided_by)
  ) NOT VALID,
  ADD CONSTRAINT mne_evaluation_decider_chk CHECK (decided_by IS NULL OR (decided_by <> created_by AND decided_by IS DISTINCT FROM submitted_by)) NOT VALID,
  ADD CONSTRAINT mne_evaluation_report_chk CHECK (mne_report_id IS NULL OR status = 'APPROVED') NOT VALID,
  ADD CONSTRAINT mne_evaluation_submitted_by_fk FOREIGN KEY (tenant_id, submitted_by) REFERENCES machvon.membership (tenant_id, id) NOT VALID,
  ADD CONSTRAINT mne_evaluation_decided_by_fk FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id) NOT VALID;

CREATE INDEX mne_evaluation_submitted_by_idx ON machvon.mne_evaluation (tenant_id, submitted_by);
CREATE INDEX mne_evaluation_decided_by_idx ON machvon.mne_evaluation (tenant_id, decided_by);
CREATE INDEX mne_evaluation_status_idx ON machvon.mne_evaluation (tenant_id, project_id, status);

REVOKE DELETE, TRUNCATE ON TABLE machvon.mne_evaluation FROM machvon_app;

CREATE FUNCTION machvon.guard_mne_evaluation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.evaluation_kind, NEW.evaluator_kind, NEW.evaluator_name, NEW.scope_text, NEW.planned_date, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.evaluation_kind, OLD.evaluator_kind, OLD.evaluator_name, OLD.scope_text, OLD.planned_date, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an evaluation is about never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('PLANNED', 'IN_PROGRESS'), ('PLANNED', 'SUBMITTED'), ('IN_PROGRESS', 'SUBMITTED'), ('SUBMITTED', 'APPROVED'), ('SUBMITTED', 'RETURNED'), ('RETURNED', 'SUBMITTED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'EVALUATION_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  -- What was submitted does not change while it waits for its decision, in the decision itself, or after it was approved; a returned evaluation is corrected by submitting it again.
  IF OLD.status IN ('SUBMITTED', 'APPROVED') AND (NEW.findings_json, NEW.conclusion, NEW.recommendations_text, NEW.report_document_id, NEW.completed_date, NEW.submitted_by, NEW.submitted_at)
     IS DISTINCT FROM (OLD.findings_json, OLD.conclusion, OLD.recommendations_text, OLD.report_document_id, OLD.completed_date, OLD.submitted_by, OLD.submitted_at) THEN
    RAISE EXCEPTION 'EVALUATION_STATE_INVALID: what was submitted does not change' USING ERRCODE = '23514';
  END IF;
  -- An approved evaluation is final, the link to its report included once it is set.
  IF OLD.status = 'APPROVED' AND (NEW.status, NEW.approved_by, NEW.decided_by, NEW.decided_at, NEW.decision_reason, NEW.mne_report_id) IS DISTINCT FROM (OLD.status, OLD.approved_by, OLD.decided_by, OLD.decided_at, OLD.decision_reason, OLD.mne_report_id) THEN
    RAISE EXCEPTION 'EVALUATION_STATE_INVALID: an approved evaluation is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER mne_evaluation_guard BEFORE UPDATE ON machvon.mne_evaluation FOR EACH ROW EXECUTE FUNCTION machvon.guard_mne_evaluation();

-- ST-DIS-006: the decision of a reviewer on a weekly report and the chain of corrections (DIS 3 F2, state machine of section 4, BR-DIS-02).
--
-- 1. Every decision is kept as it was taken, once: who decided, when, why, on what evidence, and for a return what is to be fixed and by when. A decision is never edited or deleted, and the person who
--    handed the report in is never the person who decides on it (maker-checker).
-- 2. A report moves along the graph of the state machine and no other way (DRAFT, SUBMITTED, UNDER_REVIEW, ACCEPTED, RETURNED, AMENDMENT_REQUESTED, SUPERSEDED, WITHDRAWN); who accepted it and when are
--    fixed once written; a report that was returned or asked to be amended says why.
-- 3. The accepted revision is unambiguous: the revision that is current is accepted (or is asked to be amended while the next one is prepared), and there is at most one for a project and a period
--    (V002 `current_report`).

CREATE TABLE machvon.report_decision (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  report_revision_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED')),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000),
  evidence_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_ids) <= 20),
  return_items text[] NOT NULL DEFAULT '{}' CHECK (cardinality(return_items) <= 20),
  due_at timestamptz,
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT report_decision_report_fk FOREIGN KEY (tenant_id, report_revision_id) REFERENCES machvon.report_revision (tenant_id, id),
  CONSTRAINT report_decision_return_chk CHECK (decision <> 'RETURNED' OR (cardinality(return_items) > 0 AND due_at IS NOT NULL)),
  CONSTRAINT report_decision_accepted_chk CHECK (decision <> 'ACCEPTED' OR (cardinality(return_items) = 0 AND due_at IS NULL))
);
CREATE INDEX report_decision_report_idx ON machvon.report_decision (tenant_id, report_revision_id, decided_at, id);

ALTER TABLE machvon.report_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_decision AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_decision AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION machvon.report_decision_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  maker uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a decision on a report is kept as it was taken' USING ERRCODE = '23514', CONSTRAINT = 'report_decision_immutable_guard';
  END IF;
  SELECT r.submitted_by INTO maker FROM machvon.report_revision r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.report_revision_id;
  IF maker IS NULL THEN
    RAISE EXCEPTION 'a decision is taken on a report that was handed in' USING ERRCODE = '23514', CONSTRAINT = 'report_decision_submitted_guard';
  END IF;
  IF maker = NEW.decided_by THEN
    RAISE EXCEPTION 'the person who handed a report in does not decide on it' USING ERRCODE = '23514', CONSTRAINT = 'report_decision_sod_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER report_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.report_decision FOR EACH ROW EXECUTE FUNCTION machvon.report_decision_guard();

ALTER TABLE machvon.report_revision
  ADD CONSTRAINT report_revision_accepted_chk CHECK ((status IN ('ACCEPTED', 'AMENDMENT_REQUESTED', 'SUPERSEDED')) = (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
  ADD CONSTRAINT report_revision_returned_chk CHECK (status NOT IN ('RETURNED', 'AMENDMENT_REQUESTED') OR returned_reason IS NOT NULL),
  ADD CONSTRAINT report_revision_current_chk CHECK ((status <> 'ACCEPTED' OR is_current) AND (NOT is_current OR status IN ('ACCEPTED', 'AMENDMENT_REQUESTED')));

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

-- Authored by hand (not generated): the evidence, the ledger of assignments and the exceptions of the tasks of a project workflow (PWF-1, docs PWF 6, BR-PWF-14, 34, 35, R34).
-- Evidence is only added to: a task is completed on what was attached, and what was attached stays. The ledger of assignments (`project_task_assignment`) is only added to as well: it says who answered for a task, in which
-- role, for which period and for what share, so that the score of a person is computed from the period they held the task (PWF-3) and the periods of one person in one role of one task never overlap. An exception is a
-- request with a reason that another person decides: four kinds (waive a requirement, cancel the task, pause it, an external delay); only a pause or an external delay that was approved is a period excused from the KPI.

CREATE TABLE machvon.project_task_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  -- The checklist item the evidence belongs to, when it belongs to one.
  item_code text CHECK (item_code IS NULL OR item_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  evidence_kind text NOT NULL CHECK (evidence_kind = btrim(evidence_kind) AND char_length(evidence_kind) BETWEEN 1 AND 60),
  document_id uuid,
  -- The abstract type of legal document the evidence is (resolved by the edition, R42) and the form template it was made from (DOC).
  legal_doc_type text CHECK (legal_doc_type IS NULL OR legal_doc_type ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  form_template_code text CHECK (form_template_code IS NULL OR char_length(form_template_code) BETWEEN 1 AND 80),
  external_ref text CHECK (external_ref IS NULL OR char_length(external_ref) BETWEEN 1 AND 300),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  attached_by uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.project_task (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES machvon.document (tenant_id, id),
  FOREIGN KEY (tenant_id, attached_by) REFERENCES machvon.membership (tenant_id, id),
  -- Evidence points at something: a document, a form made from a template, or a reference outside the system.
  CONSTRAINT project_task_evidence_target_chk CHECK (document_id IS NOT NULL OR form_template_code IS NOT NULL OR external_ref IS NOT NULL)
);

CREATE INDEX project_task_evidence_task_idx ON machvon.project_task_evidence (tenant_id, task_id, attached_at);
CREATE INDEX project_task_evidence_document_idx ON machvon.project_task_evidence (tenant_id, document_id) WHERE document_id IS NOT NULL;

CREATE TABLE machvon.project_task_assignment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('RESPONSIBLE', 'ACCOUNTABLE', 'CONSULTED', 'INFORMED')),
  valid_from date NOT NULL,
  valid_to date,
  share_pct integer NOT NULL CHECK (share_pct BETWEEN 1 AND 100),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 500),
  assigned_by uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.project_task (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_task_assignment_window_chk CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- One person holds one role of one task once at a time (the periods may touch on no day).
  CONSTRAINT project_task_assignment_no_overlap
    EXCLUDE USING gist (tenant_id WITH =, task_id WITH =, membership_id WITH =, role WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);

-- "My tasks" and the load by person (R35): a person, a role, the periods they held.
CREATE INDEX project_task_assignment_member_idx ON machvon.project_task_assignment (tenant_id, membership_id, role, valid_from);
CREATE INDEX project_task_assignment_task_idx ON machvon.project_task_assignment (tenant_id, task_id, role, valid_from);

CREATE TABLE machvon.project_task_exception (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('WAIVE_REQUIREMENT', 'CANCEL_TASK', 'PAUSE', 'EXTERNAL_DELAY')),
  -- WAIVE_REQUIREMENT: the codes of the items, evidence, legal document types or forms that are waived (the code TASK waives the task for the gate).
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  valid_from date NOT NULL,
  valid_to date,
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 20 AND 1000),
  evidence_ref text CHECK (evidence_ref IS NULL OR char_length(evidence_ref) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'USED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 5 AND 500),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.project_task (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_task_exception_window_chk CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- Whoever decides is not the one who asked, and a request that is still open has no decision.
  CONSTRAINT project_task_exception_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT project_task_exception_decision_chk CHECK ((status = 'REQUESTED') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL))
);

CREATE INDEX project_task_exception_task_idx ON machvon.project_task_exception (tenant_id, task_id, status);
CREATE INDEX project_task_exception_open_idx ON machvon.project_task_exception (tenant_id, requested_at) WHERE status = 'REQUESTED';

-- The three tables: tenant boundary and kept for good; then the rules of what may change.
ALTER TABLE machvon.project_task_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task_evidence AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task_evidence AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_task_evidence FROM machvon_app;

ALTER TABLE machvon.project_task_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task_assignment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task_assignment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_task_assignment FROM machvon_app;

ALTER TABLE machvon.project_task_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task_exception AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task_exception AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_task_exception FROM machvon_app;

CREATE TRIGGER project_task_evidence_immutable BEFORE UPDATE OR DELETE ON machvon.project_task_evidence
  FOR EACH ROW EXECUTE FUNCTION machvon.pwf_forbid_change();
CREATE TRIGGER project_task_assignment_immutable BEFORE UPDATE OR DELETE ON machvon.project_task_assignment
  FOR EACH ROW EXECUTE FUNCTION machvon.pwf_forbid_change();

-- An exception keeps what was asked for good; it is decided once (REQUESTED to APPROVED or REJECTED), and an approved one may be marked USED.
CREATE FUNCTION machvon.guard_project_task_exception() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an exception of a task is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.task_id, NEW.kind, NEW.items, NEW.valid_from, NEW.reason, NEW.evidence_ref, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.task_id, OLD.kind, OLD.items, OLD.valid_from, OLD.reason, OLD.evidence_ref, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'an exception keeps what was asked for good' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('REJECTED', 'USED') THEN
    RAISE EXCEPTION 'a rejected or used exception never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED', 'REJECTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'USED')
  ) THEN
    RAISE EXCEPTION 'an exception cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  -- The end of a pause or delay is the only thing an approved exception may still gain (when the task resumes).
  IF OLD.status = 'APPROVED' AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
    RAISE EXCEPTION 'the decision on an exception never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_task_exception_guard BEFORE UPDATE OR DELETE ON machvon.project_task_exception
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_task_exception();

COMMENT ON TABLE machvon.project_task_evidence IS 'Evidence attached to a task of a workflow (PWF-1): documents, legal document types, forms; append-only.';
COMMENT ON TABLE machvon.project_task_assignment IS 'The ledger of assignments of a task (R34): who, in which role, for which period and share; append-only, no overlap for one person in one role.';
COMMENT ON TABLE machvon.project_task_exception IS 'A request to waive a requirement, cancel, pause or excuse an external delay of a task (PWF-1); the decider is not the requester.';

-- Authored by hand (not generated): the checklist of a visit of a step (PRC-1). When a package enters a step, the items of the step in the frozen definition become rows here (name, required, owner role, due day and the kinds of evidence are
-- copied, so the definition can change later without moving them). An item is OPEN until it is DONE (with its evidence, by one person) or WAIVED (by an approved exception); the evidence is a separate append-only table that links
-- a paper of DOC, a milestone of the package, a receipt of an outside system (EGP) or a note.

CREATE TABLE machvon.package_checklist_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  step_visit_id uuid NOT NULL,
  package_id uuid NOT NULL,
  step_code text NOT NULL CHECK (step_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  item_code text NOT NULL CHECK (item_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 3 AND 200),
  required boolean NOT NULL,
  owner_role text NOT NULL CHECK (owner_role ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  due_on date,
  evidence_kinds text[] NOT NULL DEFAULT '{}',
  evidence_required boolean NOT NULL DEFAULT false,
  milestone_kind text CHECK (milestone_kind IS NULL OR milestone_kind IN ('INVITATION_PUBLISHED', 'CLARIFICATION_DEADLINE', 'BID_CLOSING', 'BID_OPENING', 'EVALUATION_DONE', 'RESULT_APPROVED', 'RESULT_PUBLISHED', 'CONTRACT_SIGNED')),
  owner_membership_id uuid,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'WAIVED')),
  -- Who finished it: a person, the milestone of the package that carries the evidence by itself (no person), or an approved exception that waived it.
  completed_via text CHECK (completed_via IS NULL OR completed_via IN ('PERSON', 'MILESTONE', 'EXCEPTION')),
  completed_by uuid,
  completed_at timestamptz,
  completion_note text CHECK (completion_note IS NULL OR (completion_note = btrim(completion_note) AND char_length(completion_note) BETWEEN 1 AND 500)),
  waived_exception_id uuid,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT package_checklist_item_uq UNIQUE (tenant_id, step_visit_id, item_code),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.package_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, step_visit_id) REFERENCES machvon.package_step (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT package_checklist_item_done_chk CHECK (
    CASE status
      WHEN 'OPEN' THEN completed_via IS NULL AND completed_by IS NULL AND completed_at IS NULL AND waived_exception_id IS NULL
      WHEN 'DONE' THEN completed_at IS NOT NULL AND completed_via IN ('PERSON', 'MILESTONE') AND ((completed_via = 'PERSON') = (completed_by IS NOT NULL)) AND waived_exception_id IS NULL
      ELSE completed_at IS NOT NULL AND completed_via = 'EXCEPTION' AND waived_exception_id IS NOT NULL AND completed_by IS NOT NULL
    END
  )
);

CREATE INDEX package_checklist_item_workflow_idx ON machvon.package_checklist_item (tenant_id, workflow_id, step_visit_id);
CREATE INDEX package_checklist_item_due_idx ON machvon.package_checklist_item (tenant_id, due_on) WHERE status = 'OPEN' AND required;
CREATE INDEX package_checklist_item_owner_idx ON machvon.package_checklist_item (tenant_id, owner_membership_id) WHERE owner_membership_id IS NOT NULL AND status = 'OPEN';
CREATE INDEX package_checklist_item_step_idx ON machvon.package_checklist_item (tenant_id, step_code, item_code, status);

ALTER TABLE machvon.package_checklist_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.package_checklist_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.package_checklist_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.package_checklist_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.package_checklist_item FROM machvon_app;

-- What an item says never changes; it moves OPEN -> DONE | WAIVED once, the owner can be assigned while it is open, and a finished item is kept as it is.
CREATE FUNCTION machvon.guard_package_checklist_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'the checklist of a package workflow is never deleted (% by %)', TG_OP, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.workflow_id, NEW.step_visit_id, NEW.package_id, NEW.step_code, NEW.item_code, NEW.name, NEW.required, NEW.owner_role, NEW.due_on, NEW.evidence_kinds, NEW.evidence_required, NEW.milestone_kind, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.workflow_id, OLD.step_visit_id, OLD.package_id, OLD.step_code, OLD.item_code, OLD.name, OLD.required, OLD.owner_role, OLD.due_on, OLD.evidence_kinds, OLD.evidence_required, OLD.milestone_kind, OLD.created_at) THEN
    RAISE EXCEPTION 'what an item of a checklist says never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'a finished item of a checklist never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER package_checklist_item_guard BEFORE UPDATE OR DELETE ON machvon.package_checklist_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_package_checklist_item();

-- The evidence of an item: a paper of DOC, a milestone of the package, the reference of a receipt from an outside system, or a note (an attestation always has one). Append-only.
CREATE TABLE machvon.package_checklist_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  document_id uuid,
  milestone_id uuid,
  external_ref text CHECK (external_ref IS NULL OR (external_ref = btrim(external_ref) AND char_length(external_ref) BETWEEN 1 AND 200)),
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 500)),
  attached_by uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES machvon.package_checklist_item (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.package_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES machvon.document (tenant_id, id),
  FOREIGN KEY (tenant_id, milestone_id) REFERENCES machvon.procurement_milestone (tenant_id, id),
  FOREIGN KEY (tenant_id, attached_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT package_checklist_evidence_points_chk CHECK (document_id IS NOT NULL OR milestone_id IS NOT NULL OR external_ref IS NOT NULL OR note IS NOT NULL),
  CONSTRAINT package_checklist_evidence_attestation_chk CHECK (evidence_kind <> 'ATTESTATION' OR note IS NOT NULL)
);

CREATE INDEX package_checklist_evidence_item_idx ON machvon.package_checklist_evidence (tenant_id, item_id);
CREATE INDEX package_checklist_evidence_document_idx ON machvon.package_checklist_evidence (tenant_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX package_checklist_evidence_milestone_idx ON machvon.package_checklist_evidence (tenant_id, milestone_id) WHERE milestone_id IS NOT NULL;
CREATE INDEX package_checklist_evidence_workflow_idx ON machvon.package_checklist_evidence (tenant_id, workflow_id);

ALTER TABLE machvon.package_checklist_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.package_checklist_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.package_checklist_evidence AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.package_checklist_evidence AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.package_checklist_evidence FROM machvon_app;

COMMENT ON TABLE machvon.package_checklist_item IS 'The checklist of a visit of a step (PRC-1): items copied from the frozen definition, done with evidence or waived by an approved exception.';
COMMENT ON TABLE machvon.package_checklist_evidence IS 'Append-only evidence of a checklist item: a DOC paper, a milestone, an outside receipt or a note.';

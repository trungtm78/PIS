-- ST-ADM-012 (ADM 3.7, BR-ADM-02, BR-ADM-05): the approval workflow engine. The three tables were laid down by V002 (workflow_version, workflow_instance, approval_task, with their checks, the one published definition per business type, the
-- one running instance per resource and the one open task per step and person); this adds what the engine needs beyond them and makes the database say what the application says: a published definition is not edited, an
-- instance that ended is not changed, a task is decided once, and none of the three is erased.

-- ---- the definitions ------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.workflow_version ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
-- Who last wrote the draft: the one who publishes is neither its author nor the last to edit it.
ALTER TABLE machvon.workflow_version ADD COLUMN last_edited_by uuid;
ALTER TABLE machvon.workflow_version ADD CONSTRAINT workflow_version_checker_chk CHECK (published_by IS NULL OR last_edited_by IS NULL OR published_by <> last_edited_by) NOT VALID;

CREATE FUNCTION machvon.guard_workflow_version() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- Only the definitions of approvals are held to this: the definitions of notifications keep their own lifecycle.
  IF OLD.kind <> 'APPROVAL' THEN
    RETURN NEW;
  END IF;
  IF (NEW.kind, NEW.business_type, NEW.revision, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.kind, OLD.business_type, OLD.revision, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a workflow version is is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'Draft' AND (NEW.definition_json IS DISTINCT FROM OLD.definition_json OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash OR NEW.last_edited_by IS DISTINCT FROM OLD.last_edited_by) THEN
    RAISE EXCEPTION 'a workflow version that was published is not edited' USING ERRCODE = '23514', DETAIL = 'WORKFLOW_NOT_DRAFT';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('Draft', 'Published'), ('Published', 'Superseded'), ('Published', 'Retired'), ('Superseded', 'Retired')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'a workflow version does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', DETAIL = 'WORKFLOW_NOT_DRAFT';
  END IF;
  IF OLD.status <> 'Draft' AND (NEW.published_by, NEW.published_at, NEW.effective_from, NEW.supersedes_id) IS DISTINCT FROM (OLD.published_by, OLD.published_at, OLD.effective_from, OLD.supersedes_id) THEN
    RAISE EXCEPTION 'who published a workflow version, and when, is written once' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'Published' AND OLD.status = 'Draft' AND (NEW.published_by IS NULL OR NEW.published_at IS NULL) THEN
    RAISE EXCEPTION 'a published workflow version says who published it and when' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER workflow_version_guard BEFORE UPDATE ON machvon.workflow_version FOR EACH ROW EXECUTE FUNCTION machvon.guard_workflow_version();
REVOKE DELETE, TRUNCATE ON TABLE machvon.workflow_version FROM machvon_app;

-- ---- the instances --------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.workflow_instance ADD COLUMN business_type text;
ALTER TABLE machvon.workflow_instance ADD COLUMN doa_approver_role_id uuid;
ALTER TABLE machvon.workflow_instance ADD COLUMN doa_levels integer;
ALTER TABLE machvon.workflow_instance ADD COLUMN current_step integer NOT NULL DEFAULT 0;
ALTER TABLE machvon.workflow_instance ADD COLUMN decision_seq integer NOT NULL DEFAULT 0;
-- The count of decisions when the instance entered its current step: the approvals that count for the step are those numbered after it (a return to an earlier step starts it again). A sequence, not a clock: nodes
-- with clocks that differ never disagree about which decision came first.
ALTER TABLE machvon.workflow_instance ADD COLUMN step_entered_seq integer NOT NULL DEFAULT 0;
ALTER TABLE machvon.workflow_instance
  ADD CONSTRAINT workflow_instance_version_fk FOREIGN KEY (tenant_id, workflow_version_id) REFERENCES machvon.workflow_version (tenant_id, id),
  ADD CONSTRAINT workflow_instance_done_chk CHECK ((status = 'Running') = (ended_at IS NULL) AND (status = 'Completed') = (outcome IS NOT NULL AND outcome <> 'CANCELLED') AND (status = 'Cancelled') = (outcome = 'CANCELLED')) NOT VALID,
  ADD CONSTRAINT workflow_instance_business_chk CHECK (business_type IS NOT NULL) NOT VALID;
CREATE INDEX workflow_instance_version_idx ON machvon.workflow_instance (tenant_id, workflow_version_id);
CREATE INDEX workflow_instance_resource_idx ON machvon.workflow_instance (tenant_id, resource_type, resource_id, started_at DESC);
CREATE INDEX workflow_instance_initiator_idx ON machvon.workflow_instance (tenant_id, initiator_membership_id);
CREATE INDEX workflow_instance_unit_idx ON machvon.workflow_instance (tenant_id, unit_id);
CREATE INDEX workflow_instance_doa_matrix_idx ON machvon.workflow_instance (tenant_id, doa_matrix_version_id);
CREATE INDEX workflow_instance_doa_role_idx ON machvon.workflow_instance (tenant_id, doa_approver_role_id);

CREATE FUNCTION machvon.guard_workflow_instance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.workflow_version_id, NEW.resource_type, NEW.resource_id, NEW.resource_version, NEW.business_type, NEW.document_type, NEW.amount_vnd, NEW.unit_id, NEW.initiator_membership_id, NEW.initiator_user_id, NEW.doa_matrix_version_id,
      NEW.doa_approver_role_id, NEW.doa_levels, NEW.started_at, NEW.temporal_workflow_id)
     IS DISTINCT FROM (OLD.workflow_version_id, OLD.resource_type, OLD.resource_id, OLD.resource_version, OLD.business_type, OLD.document_type, OLD.amount_vnd, OLD.unit_id, OLD.initiator_membership_id, OLD.initiator_user_id, OLD.doa_matrix_version_id,
      OLD.doa_approver_role_id, OLD.doa_levels, OLD.started_at, OLD.temporal_workflow_id) THEN
    RAISE EXCEPTION 'what a workflow instance was started on is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'Running' AND (NEW.status, NEW.outcome, NEW.ended_at, NEW.current_step, NEW.decision_seq) IS DISTINCT FROM (OLD.status, OLD.outcome, OLD.ended_at, OLD.current_step, OLD.decision_seq) THEN
    RAISE EXCEPTION 'a workflow instance that ended is not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision_seq < OLD.decision_seq THEN
    RAISE EXCEPTION 'the decisions of an instance are counted forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER workflow_instance_guard BEFORE UPDATE ON machvon.workflow_instance FOR EACH ROW EXECUTE FUNCTION machvon.guard_workflow_instance();
REVOKE DELETE, TRUNCATE ON TABLE machvon.workflow_instance FROM machvon_app;

-- ---- the tasks ------------------------------------------------------------------------------------------------------------------------
-- on_behalf_of_id (V002) is the member the decider acted for when they were delegated the task.
ALTER TABLE machvon.approval_task ADD COLUMN step_index integer;
ALTER TABLE machvon.approval_task ADD COLUMN return_to_step text;
-- The number of the decision of the instance this task was decided in.
ALTER TABLE machvon.approval_task ADD COLUMN decision_seq integer;
ALTER TABLE machvon.approval_task
  ADD CONSTRAINT approval_task_instance_fk FOREIGN KEY (tenant_id, workflow_instance_id) REFERENCES machvon.workflow_instance (tenant_id, id),
  ADD CONSTRAINT approval_task_step_chk CHECK (step_index IS NOT NULL AND step_index >= 0) NOT VALID;
CREATE INDEX approval_task_assignee_idx ON machvon.approval_task (tenant_id, assignee_id, status, due_at);
CREATE INDEX approval_task_instance_idx ON machvon.approval_task (tenant_id, workflow_instance_id, step_index);
CREATE INDEX approval_task_behalf_idx ON machvon.approval_task (tenant_id, on_behalf_of_id);
CREATE INDEX approval_task_delegation_idx ON machvon.approval_task (tenant_id, delegation_id);
CREATE INDEX approval_task_role_idx ON machvon.approval_task (tenant_id, required_role_id);

CREATE FUNCTION machvon.guard_approval_task() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.workflow_instance_id, NEW.step_id, NEW.step_index, NEW.assignee_id, NEW.due_at, NEW.created_at) IS DISTINCT FROM (OLD.workflow_instance_id, OLD.step_id, OLD.step_index, OLD.assignee_id, OLD.due_at, OLD.created_at) THEN
    RAISE EXCEPTION 'what an approval task is about is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'Pending' AND (NEW.status, NEW.decision, NEW.reason, NEW.decided_at, NEW.decided_by, NEW.on_behalf_of_id, NEW.delegation_id, NEW.return_to_step, NEW.decision_seq) IS DISTINCT FROM (OLD.status, OLD.decision, OLD.reason, OLD.decided_at, OLD.decided_by, OLD.on_behalf_of_id, OLD.delegation_id, OLD.return_to_step, OLD.decision_seq) THEN
    RAISE EXCEPTION 'the decision on an approval task is written once' USING ERRCODE = '23514', DETAIL = 'TASK_ALREADY_DECIDED';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER approval_task_guard BEFORE UPDATE ON machvon.approval_task FOR EACH ROW EXECUTE FUNCTION machvon.guard_approval_task();
REVOKE DELETE, TRUNCATE ON TABLE machvon.approval_task FROM machvon_app;

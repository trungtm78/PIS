-- Authored by hand (not generated): the tasks of a project workflow, their links and their checklists (PWF-1, docs PWF 6, BR-PWF-03, 05, 06, 09, 11, 14, R28, R35).
-- A task is made from a task of the frozen template when the workflow starts (a branch the project does not have is made too, marked `excluded`, so the order of the tasks around it is kept). The days of the schedule
-- (planned, late, float, critical, state) are what the last published schedule computed; the baseline days are those of the first schedule. A task of the kind MILESTONE is also a row of `project_milestone` (one
-- authoritative schedule: `milestone_id`), which look-ahead, the baseline process and the risk signals already read. The status follows
-- NOT_STARTED -> IN_PROGRESS -> AWAITING_APPROVAL -> DONE, back from AWAITING_APPROVAL to IN_PROGRESS when it is returned, IN_PROGRESS <-> ON_HOLD, and anything not done to CANCELLED.

CREATE TABLE machvon.project_task (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_code text NOT NULL CHECK (task_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 200),
  phase_code text NOT NULL CHECK (phase_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  kind text NOT NULL CHECK (kind IN ('TASK', 'MILESTONE')),
  required boolean NOT NULL,
  responsible_role text NOT NULL CHECK (responsible_role ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  approver_role text CHECK (approver_role IS NULL OR approver_role ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  priority text NOT NULL CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
  duration_working_days integer NOT NULL CHECK (duration_working_days BETWEEN 0 AND 3650),
  -- A task of a project of its own (added by an override) has no counterpart in the template: its code is not in the frozen template.
  own_task boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'DONE', 'ON_HOLD', 'CANCELLED')),
  -- A branch the project does not have (kept as a node of zero length) and a task of a running project that is not tracked (R36, BR-PWF-17: it never enters the KPIs).
  excluded boolean NOT NULL DEFAULT false,
  tracked boolean NOT NULL DEFAULT true,
  -- The schedule as last published.
  state text NOT NULL DEFAULT 'SCHEDULED' CHECK (state IN ('SCHEDULED', 'COMPLETED', 'PASS_THROUGH', 'CALENDAR_UNAVAILABLE')),
  planned_start date,
  planned_finish date,
  baseline_start date,
  baseline_finish date,
  late_start date,
  late_finish date,
  total_float integer,
  free_float integer,
  critical boolean NOT NULL DEFAULT false,
  driving_predecessor text,
  missing_year integer CHECK (missing_year IS NULL OR missing_year BETWEEN 1990 AND 2200),
  constraint_kind text CHECK (constraint_kind IS NULL OR constraint_kind IN ('SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO')),
  constraint_offset integer CHECK (constraint_offset IS NULL OR constraint_offset >= 0),
  -- The schedule version the dates above came from.
  schedule_version integer NOT NULL DEFAULT 0 CHECK (schedule_version >= 0),
  -- The progress.
  actual_start date,
  actual_finish date,
  remaining_working_days integer CHECK (remaining_working_days IS NULL OR remaining_working_days >= 0),
  percent_complete integer CHECK (percent_complete IS NULL OR percent_complete BETWEEN 0 AND 100),
  return_count integer NOT NULL DEFAULT 0 CHECK (return_count >= 0),
  reschedule_count integer NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  early_start_reason text CHECK (early_start_reason IS NULL OR char_length(early_start_reason) BETWEEN 20 AND 500),
  -- Money of the task, in whole dong.
  estimate_vnd numeric(24,0) CHECK (estimate_vnd IS NULL OR estimate_vnd >= 0),
  actual_vnd numeric(24,0) CHECK (actual_vnd IS NULL OR actual_vnd >= 0),
  -- Who asked for the completion and who approved it (the approver is never one who worked on the task).
  completion_requested_by uuid,
  completion_requested_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  -- The milestone row this task IS, when its kind is MILESTONE (R28).
  milestone_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_task_code_uq UNIQUE (tenant_id, workflow_id, task_code),
  CONSTRAINT project_task_workflow_uq UNIQUE (tenant_id, workflow_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.project_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, milestone_id) REFERENCES machvon.project_milestone (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, completion_requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, cancelled_by) REFERENCES machvon.membership (tenant_id, id),
  -- A milestone has no duration and only a milestone is a milestone row.
  CONSTRAINT project_task_milestone_chk CHECK (kind = 'TASK' OR duration_working_days = 0),
  CONSTRAINT project_task_milestone_link_chk CHECK (milestone_id IS NULL OR kind = 'MILESTONE'),
  CONSTRAINT project_task_dates_chk CHECK ((planned_start IS NULL) = (planned_finish IS NULL) AND (planned_start IS NULL OR planned_finish >= planned_start)),
  CONSTRAINT project_task_actual_chk CHECK (actual_finish IS NULL OR actual_start IS NULL OR actual_finish >= actual_start),
  -- A task that has been worked on says since when; a done task says when it ended and who approved it when it asked for approval.
  CONSTRAINT project_task_progress_chk CHECK (status = 'NOT_STARTED' OR status = 'CANCELLED' OR actual_start IS NOT NULL OR NOT tracked),
  CONSTRAINT project_task_done_chk CHECK (status <> 'DONE' OR actual_finish IS NOT NULL OR NOT tracked),
  CONSTRAINT project_task_cancel_chk CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CONSTRAINT project_task_missing_year_chk CHECK ((state = 'CALENDAR_UNAVAILABLE') = (missing_year IS NOT NULL)),
  CONSTRAINT project_task_constraint_chk CHECK ((constraint_kind IS NULL) = (constraint_offset IS NULL))
);

-- The reads of the deadline board and of "my tasks" (R35): by status and finish day across the tenant, by project and phase, and by milestone.
CREATE INDEX project_task_due_idx ON machvon.project_task (tenant_id, status, planned_finish) WHERE tracked AND NOT excluded;
CREATE INDEX project_task_project_idx ON machvon.project_task (tenant_id, project_id, phase_code, sort_order);
CREATE INDEX project_task_workflow_idx ON machvon.project_task (tenant_id, workflow_id, sort_order);
CREATE UNIQUE INDEX project_task_milestone_uq ON machvon.project_task (tenant_id, milestone_id) WHERE milestone_id IS NOT NULL;

ALTER TABLE machvon.project_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_task FROM machvon_app;

-- A task keeps its workflow, project, code, kind, branch and baseline days for good (the baseline is set once, from the first schedule), is never deleted, and moves only along the state machine.
CREATE FUNCTION machvon.guard_project_task() RETURNS trigger
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
    RAISE EXCEPTION 'a project task is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.workflow_id, NEW.project_id, NEW.task_code, NEW.kind, NEW.own_task, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.workflow_id, OLD.project_id, OLD.task_code, OLD.kind, OLD.own_task, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a project task keeps its workflow, project, code and kind for good' USING ERRCODE = '42501';
  END IF;
  IF OLD.baseline_start IS NOT NULL AND NEW.baseline_start IS DISTINCT FROM OLD.baseline_start OR OLD.baseline_finish IS NOT NULL AND NEW.baseline_finish IS DISTINCT FROM OLD.baseline_finish THEN
    RAISE EXCEPTION 'the first baseline of a task never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('DONE', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a done or cancelled task never changes its status' USING ERRCODE = '42501';
  END IF;
  IF OLD.excluded AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a task of a branch the project does not have never changes its status' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'NOT_STARTED' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('AWAITING_APPROVAL', 'DONE', 'ON_HOLD', 'CANCELLED'))
    OR (OLD.status = 'AWAITING_APPROVAL' AND NEW.status IN ('DONE', 'IN_PROGRESS', 'CANCELLED'))
    OR (OLD.status = 'ON_HOLD' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'a project task cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_task_guard BEFORE UPDATE OR DELETE ON machvon.project_task
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_task();

COMMENT ON TABLE machvon.project_task IS 'A task of the workflow of a project (PWF-1): the schedule as last published, the first baseline, the progress and the completion; a milestone task is also a project_milestone row.';

-- The links between tasks: read only after the workflow is made, except through an override of the project (BR-PWF-03). A task is never its own predecessor and a pair may be tied by several kinds, never by one kind twice.
CREATE TABLE machvon.project_task_dependency (
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  task_id uuid NOT NULL,
  predecessor_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FS', 'SS', 'FF', 'SF')),
  lag_working_days integer NOT NULL CHECK (lag_working_days BETWEEN -365 AND 365),
  -- Room for a lag in calendar days (D-03), not used yet.
  lag_unit text NOT NULL DEFAULT 'WORKING_DAYS' CHECK (lag_unit IN ('WORKING_DAYS')),
  PRIMARY KEY (tenant_id, task_id, predecessor_id, kind),
  FOREIGN KEY (tenant_id, workflow_id, task_id) REFERENCES machvon.project_task (tenant_id, workflow_id, id),
  FOREIGN KEY (tenant_id, workflow_id, predecessor_id) REFERENCES machvon.project_task (tenant_id, workflow_id, id),
  CONSTRAINT project_task_dependency_self_chk CHECK (task_id <> predecessor_id)
);

CREATE INDEX project_task_dependency_pred_idx ON machvon.project_task_dependency (tenant_id, predecessor_id);
CREATE INDEX project_task_dependency_workflow_idx ON machvon.project_task_dependency (tenant_id, workflow_id);

ALTER TABLE machvon.project_task_dependency ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task_dependency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task_dependency AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task_dependency AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE TRUNCATE ON TABLE machvon.project_task_dependency FROM machvon_app;

-- A link is written when the workflow is made or a task is added by an override. It is changed or removed only by an approved override of the project, which says so for its own transaction (`pwf.override`); nobody edits a link by accident.
CREATE FUNCTION machvon.guard_project_task_dependency() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' OR current_setting('pwf.override', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a link between tasks changes only by an override of the project (% by %)', TG_OP, current_user USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER project_task_dependency_guard BEFORE UPDATE OR DELETE ON machvon.project_task_dependency
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_task_dependency();

COMMENT ON TABLE machvon.project_task_dependency IS 'The links (FS, SS, FF, SF with a lag in working days) between the tasks of a workflow; written once.';

-- The checklist of a task, made from the template with the task: an item is done once, by one person, with the evidence kinds the template asks for.
CREATE TABLE machvon.project_task_checklist_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  item_code text NOT NULL CHECK (item_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 200),
  required boolean NOT NULL,
  evidence_kinds text[] NOT NULL DEFAULT '{}',
  done boolean NOT NULL DEFAULT false,
  done_by uuid,
  done_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_task_checklist_item_uq UNIQUE (tenant_id, task_id, item_code),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.project_task (tenant_id, id),
  FOREIGN KEY (tenant_id, done_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_task_checklist_done_chk CHECK (done = (done_by IS NOT NULL) AND done = (done_at IS NOT NULL))
);

ALTER TABLE machvon.project_task_checklist_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task_checklist_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task_checklist_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task_checklist_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_task_checklist_item FROM machvon_app;

-- An item that is done stays done and keeps who did it.
CREATE FUNCTION machvon.guard_project_task_checklist_item() RETURNS trigger
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
    RAISE EXCEPTION 'a checklist item is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.task_id, NEW.item_code, NEW.required, NEW.evidence_kinds) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.task_id, OLD.item_code, OLD.required, OLD.evidence_kinds) THEN
    RAISE EXCEPTION 'a checklist item keeps its code and what it asks for' USING ERRCODE = '42501';
  END IF;
  IF OLD.done AND (NEW.done IS DISTINCT FROM OLD.done OR NEW.done_by IS DISTINCT FROM OLD.done_by OR NEW.done_at IS DISTINCT FROM OLD.done_at) THEN
    RAISE EXCEPTION 'a checklist item that is done stays done' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_task_checklist_item_guard BEFORE UPDATE OR DELETE ON machvon.project_task_checklist_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_task_checklist_item();

COMMENT ON TABLE machvon.project_task_checklist_item IS 'The checklist of a task (PWF-1), made from the template; an item is done once, by one person.';

-- Authored by hand (not generated): the workflow of a project (PWF-1, docs PWF 3 F2, F3, BR-PWF-02, 07, 10, 11, R28, R29).
-- A project STARTS (or ADOPTS, when it is already running) one workflow: the approved template of its kind (the governance rule type PROJECT_WORKFLOW_TEMPLATE) is FROZEN into the row with the code, the version of the
-- rule and a hash, so a later change of the rule never moves a project under way. The phases of a workflow are not the legal stages of the project: they say which legal commands stay closed until their required tasks
-- are done (the gate, checked in the transaction of the command). The first baseline of the schedule is version 1 of `project_workflow_baseline`, taken from the first schedule and never changed; a later version is a
-- new row. The days of the schedule live in `project_task`; a task that is a milestone IS a row of `project_milestone` (R28: one authoritative schedule).

CREATE FUNCTION machvon.pwf_forbid_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only (% by %)', TG_TABLE_NAME, TG_OP, current_user USING ERRCODE = '42501';
END;
$fn$;

CREATE TABLE machvon.project_workflow (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  -- The frozen template: the code and version of the rule it came from (version 0 is the built-in default), a hash of the canonical params, and the params themselves.
  template_code text NOT NULL CHECK (template_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  template_rule_id uuid,
  template_rule_version integer NOT NULL CHECK (template_rule_version >= 0),
  template_hash text NOT NULL CHECK (template_hash ~ '^[0-9a-f]{64}$'),
  template jsonb NOT NULL CHECK (jsonb_typeof(template) = 'object'),
  -- The facts of the project the branches of the template read (project_group, funding_source, project_type), as they were when the workflow was made.
  facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(facts) = 'object'),
  planned_start_date date NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
  -- The number of the published schedule (0 until the first is published inside the same transaction that starts the workflow).
  schedule_version integer NOT NULL DEFAULT 0 CHECK (schedule_version >= 0),
  -- The calendar version of each year the schedule relies on: [{"year": 2026, "version": 3}].
  calendar_pins jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(calendar_pins) = 'array'),
  -- The baseline of the budget the project had when the workflow started (project_baseline version 0), when it had one: the schedule baseline below is the workflow's own.
  project_baseline_id uuid,
  -- Set when a running project was taken in (R36): the day the workflow is effective from.
  adopted_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  -- The number the commands send back in If-Match.
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_workflow_project_uq UNIQUE (tenant_id, project_id),
  CONSTRAINT project_workflow_scope_uq UNIQUE (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, project_baseline_id) REFERENCES machvon.project_baseline (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX project_workflow_status_idx ON machvon.project_workflow (tenant_id, status);
CREATE INDEX project_workflow_baseline_idx ON machvon.project_workflow (tenant_id, project_baseline_id) WHERE project_baseline_id IS NOT NULL;
CREATE INDEX project_workflow_rule_idx ON machvon.project_workflow (tenant_id, template_rule_id) WHERE template_rule_id IS NOT NULL;

ALTER TABLE machvon.project_workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_workflow FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_workflow AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_workflow AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Kept for good: the history of a project is read years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_workflow FROM machvon_app;

-- The workflow keeps its project, frozen template, facts and start for good; its status follows ACTIVE <-> ON_HOLD, and either one to COMPLETED or CANCELLED; an ended one never changes.
CREATE FUNCTION machvon.guard_project_workflow() RETURNS trigger
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
    RAISE EXCEPTION 'a project workflow is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.template_code, NEW.template_rule_id, NEW.template_rule_version, NEW.template_hash, NEW.template, NEW.facts, NEW.created_at, NEW.created_by, NEW.adopted_on)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.template_code, OLD.template_rule_id, OLD.template_rule_version, OLD.template_hash, OLD.template, OLD.facts, OLD.created_at, OLD.created_by, OLD.adopted_on) THEN
    RAISE EXCEPTION 'a project workflow keeps its project, frozen template, facts and start for good' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'an ended project workflow never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.schedule_version < OLD.schedule_version THEN
    RAISE EXCEPTION 'the schedule version of a workflow never goes back' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'ACTIVE' AND NEW.status IN ('ON_HOLD', 'COMPLETED', 'CANCELLED'))
    OR (OLD.status = 'ON_HOLD' AND NEW.status IN ('ACTIVE', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'a project workflow cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_workflow_guard BEFORE UPDATE OR DELETE ON machvon.project_workflow
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_workflow();

COMMENT ON TABLE machvon.project_workflow IS 'The workflow of a project (PWF-1): the frozen template, the facts of the branches, the planned start and the version of the published schedule; the tasks are project_task.';

-- A version of the baseline of the schedule: version 1 is taken from the first schedule and every later version only adds a row, so the deviation of a task is always measured against version 1 (BR-PWF-07).
CREATE TABLE machvon.project_workflow_baseline (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 1000),
  planned_start date,
  planned_finish date,
  -- The schedule version the baseline was taken from.
  schedule_version integer NOT NULL CHECK (schedule_version >= 1),
  taken_by uuid NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_workflow_baseline_version_uq UNIQUE (tenant_id, workflow_id, version),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.project_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, taken_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_workflow_baseline_days_chk CHECK (planned_start IS NULL OR planned_finish IS NULL OR planned_finish >= planned_start),
  -- A version after the first is approved by someone other than the one who took it (the baseline process of PRJ).
  CONSTRAINT project_workflow_baseline_checker_chk CHECK (version = 1 OR (approved_by IS NOT NULL AND approved_by <> taken_by))
);

ALTER TABLE machvon.project_workflow_baseline ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_workflow_baseline FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_workflow_baseline AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_workflow_baseline AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_workflow_baseline FROM machvon_app;

CREATE FUNCTION machvon.guard_project_workflow_baseline() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a baseline of a workflow is append-only (% by %)', TG_OP, current_user USING ERRCODE = '42501';
  END IF;
  IF NEW.version > 1 AND NOT EXISTS (SELECT 1 FROM machvon.project_workflow_baseline b WHERE b.tenant_id = NEW.tenant_id AND b.workflow_id = NEW.workflow_id AND b.version = NEW.version - 1) THEN
    RAISE EXCEPTION 'a baseline version follows the one before it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_workflow_baseline_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.project_workflow_baseline
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_workflow_baseline();

COMMENT ON TABLE machvon.project_workflow_baseline IS 'Versions of the baseline of the schedule of a workflow (PWF-1, BR-PWF-07): version 1 from the first schedule; only added to, never changed.';

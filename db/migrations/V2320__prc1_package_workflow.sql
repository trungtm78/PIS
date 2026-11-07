-- Authored by hand (not generated): the workflow of a procurement package (PRC-1 of docs/bid-workflow.md, BID): which step a package is at, which packages are at a step.
-- A package STARTS a workflow once (`package_workflow`): the definition of its selection method (the governance rule type PROCUREMENT_WORKFLOW) is frozen into the row with the version of the rule and a hash,
-- so a later change of the rule never moves a package already under way. Every visit of a step is a row of `package_step` (append-only: a visit is opened when the package enters the step and closed once when it
-- leaves, a return makes a new visit), so the history of a package is never edited and the timeline of the "Cay tien do" is derived from it. Money, code and method of the package stay in `procurement_package`.

CREATE TABLE machvon.package_workflow (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  method text NOT NULL CHECK (method ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  -- The frozen definition: the code and version of the rule it came from (version 0 is the built-in default), a hash of the canonical text, and the params themselves.
  definition_code text NOT NULL CHECK (definition_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  definition_rule_id uuid,
  definition_rule_version integer NOT NULL CHECK (definition_rule_version >= 0),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  status text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
  current_step_code text CHECK (current_step_code IS NULL OR current_step_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  current_visit integer CHECK (current_visit IS NULL OR current_visit >= 1),
  -- The person who answers for the package under its workflow; null is a package nobody holds (alert PRC_NO_OWNER).
  owner_membership_id uuid,
  hold_reason text CHECK (hold_reason IS NULL OR (hold_reason = btrim(hold_reason) AND char_length(hold_reason) BETWEEN 5 AND 500)),
  held_at timestamptz,
  held_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid NOT NULL,
  ended_at timestamptz,
  ended_by uuid,
  end_reason text CHECK (end_reason IS NULL OR (end_reason = btrim(end_reason) AND char_length(end_reason) BETWEEN 5 AND 500)),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  last_activity_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),
  -- The number the commands send back in If-Match.
  row_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT package_workflow_package_uq UNIQUE (tenant_id, package_id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, held_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, started_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by) REFERENCES machvon.membership (tenant_id, id),
  -- A package on hold says why, since when and who; a package that is not on hold says none of it.
  CONSTRAINT package_workflow_hold_chk CHECK ((status = 'ON_HOLD') = (hold_reason IS NOT NULL) AND (hold_reason IS NULL) = (held_at IS NULL) AND (held_at IS NULL) = (held_by IS NULL)),
  -- An ended workflow says when, by whom and why, and is in no step; a running one is in a step.
  CONSTRAINT package_workflow_end_chk CHECK ((status IN ('COMPLETED', 'CANCELLED')) = (ended_at IS NOT NULL) AND (ended_at IS NULL) = (ended_by IS NULL) AND (status <> 'CANCELLED' OR end_reason IS NOT NULL)),
  CONSTRAINT package_workflow_step_chk CHECK ((status IN ('COMPLETED', 'CANCELLED')) = (current_step_code IS NULL) AND (current_step_code IS NULL) = (current_visit IS NULL))
);

CREATE INDEX package_workflow_step_idx ON machvon.package_workflow (tenant_id, current_step_code, status);
CREATE INDEX package_workflow_status_idx ON machvon.package_workflow (tenant_id, status, last_activity_on);
CREATE INDEX package_workflow_owner_idx ON machvon.package_workflow (tenant_id, owner_membership_id) WHERE owner_membership_id IS NOT NULL;
CREATE INDEX package_workflow_ownerless_idx ON machvon.package_workflow (tenant_id, id) WHERE owner_membership_id IS NULL AND status IN ('IN_PROGRESS', 'ON_HOLD');
CREATE INDEX package_workflow_rule_idx ON machvon.package_workflow (tenant_id, definition_rule_id) WHERE definition_rule_id IS NOT NULL;

ALTER TABLE machvon.package_workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.package_workflow FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.package_workflow AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.package_workflow AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Kept for good: the history of a procurement is read years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.package_workflow FROM machvon_app;

-- The workflow keeps its package, method, frozen definition and start for good; its status follows IN_PROGRESS <-> ON_HOLD, IN_PROGRESS -> COMPLETED | CANCELLED, ON_HOLD -> CANCELLED; an ended one never changes.
CREATE FUNCTION machvon.guard_package_workflow() RETURNS trigger
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
    RAISE EXCEPTION 'a package workflow is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.package_id, NEW.method, NEW.definition_code, NEW.definition_rule_id, NEW.definition_rule_version, NEW.definition_hash, NEW.definition, NEW.started_at, NEW.started_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.package_id, OLD.method, OLD.definition_code, OLD.definition_rule_id, OLD.definition_rule_version, OLD.definition_hash, OLD.definition, OLD.started_at, OLD.started_by) THEN
    RAISE EXCEPTION 'a package workflow keeps its package, method, frozen definition and start for good' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'an ended package workflow never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('ON_HOLD', 'COMPLETED', 'CANCELLED'))
    OR (OLD.status = 'ON_HOLD' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'a package workflow cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER package_workflow_guard BEFORE UPDATE OR DELETE ON machvon.package_workflow
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_package_workflow();

COMMENT ON TABLE machvon.package_workflow IS 'The workflow of a procurement package (PRC-1): the frozen definition of its selection method, the current step and its holder; the history is package_step.';

-- A visit of a step: opened when the package enters the step, closed once when it leaves. A return makes a new visit, so the rows are the whole history, in order, and are never edited or deleted.
CREATE TABLE machvon.package_step (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  package_id uuid NOT NULL,
  visit integer NOT NULL CHECK (visit >= 1),
  step_code text NOT NULL CHECK (step_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  entered_at timestamptz NOT NULL DEFAULT now(),
  entered_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),
  entered_by uuid NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('START', 'ADVANCE', 'RETURN', 'CORRECTION')),
  -- The standard of the step in the frozen definition, and the day it falls due counted on the published working calendar (null, with the basis CALENDAR_UNAVAILABLE, when a year has no calendar: never guessed).
  standard_working_days integer NOT NULL CHECK (standard_working_days BETWEEN 0 AND 365),
  due_on date,
  due_basis text NOT NULL CHECK (due_basis IN ('WORKING_DAYS', 'CALENDAR_UNAVAILABLE')),
  exited_at timestamptz,
  exited_on date,
  exited_by uuid,
  exit_kind text CHECK (exit_kind IS NULL OR exit_kind IN ('ADVANCE', 'RETURN', 'CANCEL', 'COMPLETE', 'CORRECTED')),
  -- The person who approved the move out of a maker-checker step (never one who completed an item of it).
  approved_by uuid,
  working_days_spent integer CHECK (working_days_spent IS NULL OR working_days_spent >= 0),
  calendar_days_spent integer CHECK (calendar_days_spent IS NULL OR calendar_days_spent >= 0),
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 500)),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT package_step_visit_uq UNIQUE (tenant_id, workflow_id, visit),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.package_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, entered_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, exited_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT package_step_exit_chk CHECK ((exited_at IS NULL) = (exit_kind IS NULL) AND (exited_at IS NULL) = (exited_on IS NULL) AND (exited_at IS NULL) = (exited_by IS NULL) AND (exited_at IS NULL) = (calendar_days_spent IS NULL)),
  CONSTRAINT package_step_order_chk CHECK (exited_at IS NULL OR exited_at >= entered_at),
  CONSTRAINT package_step_due_chk CHECK ((due_on IS NULL) = (due_basis = 'CALENDAR_UNAVAILABLE') AND (due_on IS NULL OR due_on >= entered_on))
);

-- One open visit per workflow: a package is in one step at a time.
CREATE UNIQUE INDEX package_step_open_uq ON machvon.package_step (tenant_id, workflow_id) WHERE exited_at IS NULL;
CREATE INDEX package_step_package_idx ON machvon.package_step (tenant_id, package_id, visit);
CREATE INDEX package_step_step_idx ON machvon.package_step (tenant_id, step_code, exited_on);
CREATE INDEX package_step_open_due_idx ON machvon.package_step (tenant_id, due_on) WHERE exited_at IS NULL;

ALTER TABLE machvon.package_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.package_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.package_step AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.package_step AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.package_step FROM machvon_app;

-- Append-only: a visit is written once and closed once; what it says about the entry never changes, and a closed visit never changes at all.
CREATE FUNCTION machvon.guard_package_step() RETURNS trigger
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
    RAISE EXCEPTION 'the history of a package workflow is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF OLD.exited_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed visit of a step never changes' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.workflow_id, NEW.package_id, NEW.visit, NEW.step_code, NEW.entered_at, NEW.entered_on, NEW.entered_by, NEW.entry_kind, NEW.standard_working_days, NEW.due_basis)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.workflow_id, OLD.package_id, OLD.visit, OLD.step_code, OLD.entered_at, OLD.entered_on, OLD.entered_by, OLD.entry_kind, OLD.standard_working_days, OLD.due_basis) THEN
    RAISE EXCEPTION 'what a visit says about its entry never changes' USING ERRCODE = '42501';
  END IF;
  -- The day a step falls due only moves later (the days a package spent on hold are added when it resumes), never earlier and never from nothing to a day.
  IF NEW.due_on IS DISTINCT FROM OLD.due_on AND NOT (OLD.due_on IS NOT NULL AND NEW.due_on IS NOT NULL AND NEW.due_on > OLD.due_on) THEN
    RAISE EXCEPTION 'the due day of a step only moves later' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER package_step_guard BEFORE UPDATE OR DELETE ON machvon.package_step
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_package_step();

COMMENT ON TABLE machvon.package_step IS 'Append-only history of the steps of a package (PRC-1): a row per visit, closed once; the timeline is derived from it.';

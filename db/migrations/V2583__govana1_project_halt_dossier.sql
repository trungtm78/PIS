-- Authored by hand (not generated): the dossier of a halted project and its restart plan (G3-9 of docs/governance-roadmap-10of10.md, GOV-11b).
--   project_halt_dossier  why a project stands still (a cause of the closed list and the reason in words), since when, the order that halted it and the day a restart is expected; its status runs
--                         HALTED, then RESTART_PLANNED once a plan was saved by one person and approved by another, then RESTARTED (every step closed) or CANCELLED. One open dossier per project.
--   project_restart_step  the steps of a plan: words, who does it (a person or a unit), the day; a plan is a numbered version of steps, a new plan is a new version and the old one stays; a step is closed as DONE
--                         or DROPPED with words, once.
-- What a dossier is (project, cause, reason, the day it began, its author) and what a step is (words, owner, day) never change; only the status moves, with who moved it, when and why. Nothing is deleted. Every move has an
-- audit row and an event from the command. The causes, the age buckets and the minimum number of steps of a plan are the rule `BOTTLENECK_POLICY` of `machvon.governance_rule`.

CREATE TABLE machvon.project_halt_dossier (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  reason_text text NOT NULL CHECK (reason_text = btrim(reason_text) AND char_length(reason_text) BETWEEN 10 AND 2000),
  halted_on date NOT NULL,
  order_ref text CHECK (order_ref IS NULL OR (order_ref = btrim(order_ref) AND char_length(order_ref) BETWEEN 1 AND 200)),
  expected_restart_on date CHECK (expected_restart_on IS NULL OR expected_restart_on >= halted_on),
  status text NOT NULL DEFAULT 'HALTED' CHECK (status IN ('HALTED', 'RESTART_PLANNED', 'RESTARTED', 'CANCELLED')),
  -- The plan: its version (0 is no plan yet), who saved it and when, and what the second person decided about it.
  plan_version integer NOT NULL DEFAULT 0 CHECK (plan_version >= 0),
  plan_saved_by uuid,
  plan_saved_at timestamptz,
  plan_decision text CHECK (plan_decision IS NULL OR plan_decision IN ('APPROVED', 'RETURNED')),
  plan_decided_by uuid,
  plan_decided_at timestamptz,
  plan_decision_note text CHECK (plan_decision_note IS NULL OR (plan_decision_note = btrim(plan_decision_note) AND char_length(plan_decision_note) BETWEEN 5 AND 1000)),
  closed_by uuid,
  closed_at timestamptz,
  close_note text CHECK (close_note IS NULL OR (close_note = btrim(close_note) AND char_length(close_note) BETWEEN 5 AND 1000)),
  restarted_on date,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_saved_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_decided_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_halt_plan_chk CHECK ((plan_version = 0) = (plan_saved_by IS NULL AND plan_saved_at IS NULL)),
  CONSTRAINT project_halt_decision_chk CHECK ((plan_decision IS NULL) = (plan_decided_by IS NULL AND plan_decided_at IS NULL AND plan_decision_note IS NULL)),
  CONSTRAINT project_halt_sod_chk CHECK (plan_decided_by IS NULL OR plan_decided_by <> plan_saved_by),
  CONSTRAINT project_halt_planned_chk CHECK (status <> 'RESTART_PLANNED' OR (plan_version > 0 AND plan_decision = 'APPROVED')),
  CONSTRAINT project_halt_closed_chk CHECK ((status IN ('RESTARTED', 'CANCELLED')) = (closed_by IS NOT NULL AND closed_at IS NOT NULL AND close_note IS NOT NULL)),
  CONSTRAINT project_halt_restarted_chk CHECK ((status = 'RESTARTED') = (restarted_on IS NOT NULL))
);

CREATE UNIQUE INDEX project_halt_open_uq ON machvon.project_halt_dossier (tenant_id, project_id) WHERE status IN ('HALTED', 'RESTART_PLANNED');
CREATE INDEX project_halt_status_idx ON machvon.project_halt_dossier (tenant_id, status, halted_on, id);
CREATE INDEX project_halt_plan_saved_by_idx ON machvon.project_halt_dossier (tenant_id, plan_saved_by) WHERE plan_saved_by IS NOT NULL;
CREATE INDEX project_halt_plan_decided_by_idx ON machvon.project_halt_dossier (tenant_id, plan_decided_by) WHERE plan_decided_by IS NOT NULL;
CREATE INDEX project_halt_closed_by_idx ON machvon.project_halt_dossier (tenant_id, closed_by) WHERE closed_by IS NOT NULL;
CREATE INDEX project_halt_created_by_idx ON machvon.project_halt_dossier (tenant_id, created_by);

CREATE TABLE machvon.project_restart_step (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  dossier_id uuid NOT NULL,
  plan_version integer NOT NULL CHECK (plan_version >= 1),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 5 AND 300),
  owner_id uuid,
  owner_unit_id uuid,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'DROPPED')),
  closed_by uuid,
  closed_at timestamptz,
  close_note text CHECK (close_note IS NULL OR (close_note = btrim(close_note) AND char_length(close_note) BETWEEN 5 AND 1000)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, dossier_id) REFERENCES machvon.project_halt_dossier (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_restart_step_owner_chk CHECK (owner_id IS NOT NULL OR owner_unit_id IS NOT NULL),
  CONSTRAINT project_restart_step_closed_chk CHECK ((status = 'OPEN') = (closed_by IS NULL AND closed_at IS NULL AND close_note IS NULL))
);

CREATE UNIQUE INDEX project_restart_step_order_uq ON machvon.project_restart_step (tenant_id, dossier_id, plan_version, ordinal);
CREATE INDEX project_restart_step_owner_idx ON machvon.project_restart_step (tenant_id, owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX project_restart_step_unit_idx ON machvon.project_restart_step (tenant_id, owner_unit_id) WHERE owner_unit_id IS NOT NULL;
CREATE INDEX project_restart_step_closed_by_idx ON machvon.project_restart_step (tenant_id, closed_by) WHERE closed_by IS NOT NULL;
CREATE INDEX project_restart_step_due_idx ON machvon.project_restart_step (tenant_id, due_on) WHERE status = 'OPEN';

CREATE FUNCTION machvon.project_halt_dossier_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a halt dossier is kept' USING ERRCODE = '23514', CONSTRAINT = 'project_halt_dossier_guard';
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.reason_code <> OLD.reason_code OR NEW.reason_text <> OLD.reason_text OR NEW.halted_on <> OLD.halted_on OR NEW.order_ref IS DISTINCT FROM OLD.order_ref
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what a halt dossier says does not change' USING ERRCODE = '23514', CONSTRAINT = 'project_halt_identity_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'HALTED' AND NEW.status IN ('RESTART_PLANNED', 'CANCELLED'))
    OR (OLD.status = 'RESTART_PLANNED' AND NEW.status IN ('RESTARTED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'a halt dossier does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'project_halt_transition_guard';
  END IF;
  IF OLD.status IN ('RESTARTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a closed halt dossier is not changed' USING ERRCODE = '23514', CONSTRAINT = 'project_halt_closed_guard';
  END IF;
  IF NEW.plan_version < OLD.plan_version OR NEW.plan_version > OLD.plan_version + 1 THEN
    RAISE EXCEPTION 'a plan is saved as the next version' USING ERRCODE = '23514', CONSTRAINT = 'project_halt_plan_guard';
  END IF;
  IF NEW.plan_version <> OLD.plan_version AND OLD.status <> 'HALTED' THEN
    RAISE EXCEPTION 'a plan that was approved is not replaced' USING ERRCODE = '23514', CONSTRAINT = 'project_halt_plan_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER project_halt_dossier_guard BEFORE UPDATE OR DELETE ON machvon.project_halt_dossier FOR EACH ROW EXECUTE FUNCTION machvon.project_halt_dossier_guard();

CREATE FUNCTION machvon.project_restart_step_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a restart step is kept' USING ERRCODE = '23514', CONSTRAINT = 'project_restart_step_guard';
  END IF;
  IF NEW.dossier_id <> OLD.dossier_id OR NEW.plan_version <> OLD.plan_version OR NEW.ordinal <> OLD.ordinal OR NEW.title <> OLD.title OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.owner_unit_id IS DISTINCT FROM OLD.owner_unit_id OR NEW.due_on <> OLD.due_on THEN
    RAISE EXCEPTION 'what a restart step says does not change' USING ERRCODE = '23514', CONSTRAINT = 'project_restart_step_identity_guard';
  END IF;
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'a closed restart step is not changed' USING ERRCODE = '23514', CONSTRAINT = 'project_restart_step_closed_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER project_restart_step_guard BEFORE UPDATE OR DELETE ON machvon.project_restart_step FOR EACH ROW EXECUTE FUNCTION machvon.project_restart_step_guard();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_halt_dossier', 'project_restart_step'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE machvon.%I FROM machvon_app', t);
  END LOOP;
END $$;

COMMENT ON TABLE machvon.project_halt_dossier IS 'Why a project stands still and how it restarts: cause, reason, the order, and a plan saved by one person and approved by another; only the status and the plan move.';
COMMENT ON TABLE machvon.project_restart_step IS 'A step of a restart plan: words, owner and day; a plan is a numbered version of steps; a step is closed once as done or dropped, with words.';

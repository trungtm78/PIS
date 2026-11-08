-- Authored by hand (not generated): the look-ahead plan of a project (GOV-11a, G1-19, QMS and PRJ, roadmap K13).
-- A look-ahead plan is the rolling plan of the work of the next 2 to 6 weeks (the window is the rule `LOOK_AHEAD_POLICY`, flagged not confirmed). It has items of work; an item may have constraints (what has to be
-- ready before it starts); at the end of the week each item is recorded as done or not done, a not-done one with a reason of the standard list, so the share of the committed work that was done (PPC) is read week by week.
--   * one plan for a project and a week (the Monday it starts on); a plan is a draft until it is published, and what it plans does not change after that;
--   * an item is recorded once, done or not done; a not-done item has a reason, a done one has none;
--   * a constraint is cleared once, by a person, with the day; a cleared constraint is never reopened (a new one is raised);
--   * the rows are kept: the runtime role cannot delete or truncate them.

CREATE TABLE machvon.look_ahead_plan (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  owner_unit_id uuid NOT NULL,
  week_start date NOT NULL,
  horizon_weeks integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  policy_version integer NOT NULL DEFAULT 0,
  published_by uuid,
  published_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT look_ahead_plan_week_uq UNIQUE (tenant_id, project_id, week_start),
  CONSTRAINT look_ahead_plan_monday_chk CHECK (extract(isodow FROM week_start) = 1),
  CONSTRAINT look_ahead_plan_horizon_chk CHECK (horizon_weeks BETWEEN 1 AND 26 AND policy_version >= 0),
  CONSTRAINT look_ahead_plan_status_chk CHECK (status IN ('DRAFT', 'PUBLISHED') AND ((status = 'PUBLISHED') = (published_by IS NOT NULL AND published_at IS NOT NULL))),
  CONSTRAINT look_ahead_plan_version_chk CHECK (version >= 1)
);
CREATE INDEX look_ahead_plan_project_idx ON machvon.look_ahead_plan (tenant_id, project_id, week_start DESC);
CREATE INDEX look_ahead_plan_unit_idx ON machvon.look_ahead_plan (tenant_id, owner_unit_id, week_start DESC);

CREATE TABLE machvon.look_ahead_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  sequence integer NOT NULL,
  description text NOT NULL,
  planned_start date NOT NULL,
  planned_finish date NOT NULL,
  responsible text,
  outcome text NOT NULL DEFAULT 'PLANNED',
  variance_reason_code text,
  outcome_by uuid,
  outcome_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES machvon.look_ahead_plan (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT look_ahead_item_sequence_uq UNIQUE (tenant_id, plan_id, sequence),
  CONSTRAINT look_ahead_item_dates_chk CHECK (planned_start <= planned_finish AND char_length(btrim(description)) BETWEEN 3 AND 500 AND sequence >= 1),
  CONSTRAINT look_ahead_item_outcome_chk CHECK (
    outcome IN ('PLANNED', 'DONE', 'NOT_DONE')
    AND ((outcome = 'PLANNED') = (outcome_by IS NULL AND outcome_at IS NULL))
    AND ((outcome = 'NOT_DONE') = (variance_reason_code IS NOT NULL))
    AND (variance_reason_code IS NULL OR variance_reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$')
  ),
  CONSTRAINT look_ahead_item_version_chk CHECK (version >= 1)
);
CREATE INDEX look_ahead_item_plan_idx ON machvon.look_ahead_item (tenant_id, plan_id, sequence);
CREATE INDEX look_ahead_item_project_idx ON machvon.look_ahead_item (tenant_id, project_id, planned_start, id);

CREATE TABLE machvon.look_ahead_constraint (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  description text NOT NULL,
  owner_membership_id uuid,
  due_on date,
  status text NOT NULL DEFAULT 'OPEN',
  raised_by uuid NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  cleared_by uuid,
  cleared_at timestamptz,
  clear_note text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES machvon.look_ahead_item (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES machvon.look_ahead_plan (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT look_ahead_constraint_kind_chk CHECK (kind ~ '^[A-Z][A-Z0-9_]{1,39}$' AND char_length(btrim(description)) BETWEEN 3 AND 500),
  CONSTRAINT look_ahead_constraint_status_chk CHECK (status IN ('OPEN', 'CLEARED') AND ((status = 'CLEARED') = (cleared_by IS NOT NULL AND cleared_at IS NOT NULL))),
  CONSTRAINT look_ahead_constraint_version_chk CHECK (version >= 1)
);
CREATE INDEX look_ahead_constraint_item_idx ON machvon.look_ahead_constraint (tenant_id, item_id, status);
CREATE INDEX look_ahead_constraint_plan_idx ON machvon.look_ahead_constraint (tenant_id, plan_id);
CREATE INDEX look_ahead_constraint_project_idx ON machvon.look_ahead_constraint (tenant_id, project_id, status, due_on);

CREATE FUNCTION machvon.guard_look_ahead() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a look-ahead record is kept' USING ERRCODE = '23514', CONSTRAINT = 'look_ahead_guard';
  END IF;
  IF TG_TABLE_NAME = 'look_ahead_plan' THEN
    IF NEW.project_id <> OLD.project_id OR NEW.week_start <> OLD.week_start OR NEW.owner_unit_id <> OLD.owner_unit_id OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'what a look-ahead plan is does not change' USING ERRCODE = '23514', CONSTRAINT = 'look_ahead_plan_identity_guard';
    END IF;
    IF OLD.status = 'PUBLISHED' AND (NEW.status <> 'PUBLISHED' OR NEW.horizon_weeks <> OLD.horizon_weeks OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
      RAISE EXCEPTION 'a published look-ahead plan is not changed' USING ERRCODE = '23514', CONSTRAINT = 'look_ahead_plan_published_guard';
    END IF;
  ELSIF TG_TABLE_NAME = 'look_ahead_item' THEN
    IF NEW.plan_id <> OLD.plan_id OR NEW.project_id <> OLD.project_id OR NEW.sequence <> OLD.sequence OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'what a look-ahead item is does not change' USING ERRCODE = '23514', CONSTRAINT = 'look_ahead_item_identity_guard';
    END IF;
    IF OLD.outcome <> 'PLANNED' AND (NEW.outcome <> OLD.outcome OR NEW.variance_reason_code IS DISTINCT FROM OLD.variance_reason_code OR NEW.outcome_by IS DISTINCT FROM OLD.outcome_by OR NEW.outcome_at IS DISTINCT FROM OLD.outcome_at) THEN
      RAISE EXCEPTION 'the outcome of a look-ahead item is recorded once' USING ERRCODE = '23514', CONSTRAINT = 'look_ahead_item_outcome_guard';
    END IF;
  ELSE
    IF NEW.item_id <> OLD.item_id OR NEW.plan_id <> OLD.plan_id OR NEW.project_id <> OLD.project_id OR NEW.kind <> OLD.kind OR NEW.raised_by <> OLD.raised_by OR NEW.raised_at <> OLD.raised_at THEN
      RAISE EXCEPTION 'what a constraint is does not change' USING ERRCODE = '23514', CONSTRAINT = 'look_ahead_constraint_identity_guard';
    END IF;
    IF OLD.status = 'CLEARED' AND (NEW.status <> 'CLEARED' OR NEW.cleared_by IS DISTINCT FROM OLD.cleared_by OR NEW.cleared_at IS DISTINCT FROM OLD.cleared_at OR NEW.clear_note IS DISTINCT FROM OLD.clear_note) THEN
      RAISE EXCEPTION 'a cleared constraint is not reopened' USING ERRCODE = '23514', CONSTRAINT = 'look_ahead_constraint_cleared_guard';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER look_ahead_plan_guard BEFORE UPDATE OR DELETE ON machvon.look_ahead_plan FOR EACH ROW EXECUTE FUNCTION machvon.guard_look_ahead();
CREATE TRIGGER look_ahead_item_guard BEFORE UPDATE OR DELETE ON machvon.look_ahead_item FOR EACH ROW EXECUTE FUNCTION machvon.guard_look_ahead();
CREATE TRIGGER look_ahead_constraint_guard BEFORE UPDATE OR DELETE ON machvon.look_ahead_constraint FOR EACH ROW EXECUTE FUNCTION machvon.guard_look_ahead();

DO $rls$
DECLARE
  one text;
BEGIN
  FOREACH one IN ARRAY ARRAY['look_ahead_plan', 'look_ahead_item', 'look_ahead_constraint'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', one);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', one);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, one);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, one);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE machvon.%I FROM machvon_app', one);
  END LOOP;
END
$rls$;

COMMENT ON TABLE machvon.look_ahead_plan IS 'GOV-11a G1-19: the rolling look-ahead plan of a project for a week and the weeks after it; published once.';
COMMENT ON TABLE machvon.look_ahead_item IS 'GOV-11a G1-19: one item of work of a look-ahead plan; its outcome (done or not done with a reason) is recorded once and gives the PPC.';
COMMENT ON TABLE machvon.look_ahead_constraint IS 'GOV-11a G1-19: what has to be ready before an item starts; raised and cleared once.';

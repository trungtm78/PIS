-- Authored by hand (not generated): the enforcement of a land recovery (ST-LND-011, LND 3.3, UC-LND-03, LND-09, UAT-AC385).
-- V002 gave `land_enforcement_case` its columns, the guard of the units of the caller (`scope_units_guard`), the rule that the steps of execution and completion carry a decision and a day
-- (`land_enforcement_exec_chk`) and that a suspension says why. This adds what the commands rely on, whatever the application checked first:
--   * the step a case was suspended from, so that it can be taken up again where it stopped;
--   * the words and the days: the legal basis is trimmed and bounded, the days follow the day the case started, a completed case says the day it was carried out;
--   * one case is open for a parcel at a time (a case is open until it is completed, a suspended one included);
--   * what a case is (project, parcel, household, plan, the unit that answers, the authority, the day it started, its legal basis) never changes, its step only moves along the procedure, and a completed case is final;
--   * a case is never deleted.

ALTER TABLE machvon.land_enforcement_case
  ADD COLUMN suspended_from text CHECK (suspended_from IN ('PERSUASION', 'NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING'));

ALTER TABLE machvon.land_enforcement_case
  ADD CONSTRAINT land_enforcement_text_chk CHECK (
    legal_basis = btrim(legal_basis) AND char_length(legal_basis) BETWEEN 1 AND 2000
    AND (suspend_reason IS NULL OR (suspend_reason = btrim(suspend_reason) AND char_length(suspend_reason) BETWEEN 1 AND 2000))
  ),
  ADD CONSTRAINT land_enforcement_dates_chk CHECK ((planned_on IS NULL OR planned_on >= started_on) AND (executed_on IS NULL OR executed_on >= started_on)),
  ADD CONSTRAINT land_enforcement_completed_chk CHECK (step <> 'COMPLETED' OR executed_on IS NOT NULL),
  ADD CONSTRAINT land_enforcement_suspended_chk CHECK ((step = 'SUSPENDED') = (suspended_from IS NOT NULL));

-- A parcel has one open case: of two asked for at once, the unique index lets one in.
CREATE UNIQUE INDEX land_enforcement_open_uq ON machvon.land_enforcement_case (tenant_id, parcel_id) WHERE step <> 'COMPLETED';

CREATE FUNCTION machvon.guard_land_enforcement_case() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  flow constant text[] := ARRAY['PERSUASION', 'NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING', 'COMPLETED'];
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.parcel_id, NEW.household_id, NEW.plan_id, NEW.owner_unit_id, NEW.authority_unit_id, NEW.started_on, NEW.legal_basis, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.parcel_id, OLD.household_id, OLD.plan_id, OLD.owner_unit_id, OLD.authority_unit_id, OLD.started_on, OLD.legal_basis, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an enforcement case is never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.step = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a completed enforcement case is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.step IS DISTINCT FROM OLD.step THEN
    IF NEW.step = 'SUSPENDED' THEN
      -- Suspended from the step it stood at, which it remembers.
      IF NEW.suspended_from IS DISTINCT FROM OLD.step THEN
        RAISE EXCEPTION 'ENFORCEMENT_STEP_INVALID: a case is suspended from the step it stands at' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.step = 'SUSPENDED' THEN
      -- Taken up again at the step it was suspended from or at the one after it, and not at persuasion.
      IF NEW.step = 'PERSUASION' OR NOT (NEW.step = OLD.suspended_from OR array_position(flow, NEW.step) = array_position(flow, OLD.suspended_from) + 1) THEN
        RAISE EXCEPTION 'ENFORCEMENT_STEP_INVALID: a suspended case is taken up again where it stopped' USING ERRCODE = '23514';
      END IF;
    ELSIF array_position(flow, NEW.step) IS DISTINCT FROM array_position(flow, OLD.step) + 1 THEN
      RAISE EXCEPTION 'ENFORCEMENT_STEP_INVALID: this move of the step of an enforcement case is not allowed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER land_enforcement_case_guard BEFORE UPDATE ON machvon.land_enforcement_case
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_land_enforcement_case();

REVOKE DELETE, TRUNCATE ON TABLE machvon.land_enforcement_case FROM machvon_app;

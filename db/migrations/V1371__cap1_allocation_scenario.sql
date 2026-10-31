-- Authored by hand (not generated): the simulation of an allocation (ST-CAP-013, CAP 3.1 F8, CAP-09).
-- V002 gave `allocation_scenario` its columns and its states, and no command has written to it, so the table holds no row of an older rule. A scenario states moves and limits (the assumptions and the constraints),
-- is run to a result, and is promoted to a DRAFT reallocation proposal. It never writes the ledger or an allocation line. The database keeps what the commands rely on, whatever the application checked first:
--   * what the scenario asks never changes (code, year, snapshot, plan, constraints, assumptions, who made it and when): a different question is a new scenario;
--   * a scenario starts as a DRAFT with no result; it is run (DRAFT to RUN), may be run again (RUN to RUN) and is promoted once (RUN to PROMOTED); a promoted or archived scenario is final;
--   * a result exists exactly when the scenario has been run, and the proposal it became exists exactly when it was promoted; the result that was promoted does not change;
--   * the code is trimmed and at most 50 characters, the year is a plausible one, the constraints and assumptions are objects;
--   * a scenario is never deleted.

ALTER TABLE machvon.allocation_scenario
  ADD CONSTRAINT allocation_scenario_code_chk CHECK (code = btrim(code) AND char_length(code) BETWEEN 1 AND 50),
  ADD CONSTRAINT allocation_scenario_year_chk CHECK (plan_year BETWEEN 1990 AND 2100),
  ADD CONSTRAINT allocation_scenario_shape_chk CHECK (jsonb_typeof(constraints_json) = 'object' AND jsonb_typeof(assumptions_json) = 'object'),
  ADD CONSTRAINT allocation_scenario_result_chk CHECK ((status = 'DRAFT' AND result_json IS NULL) OR (status IN ('RUN', 'PROMOTED') AND result_json IS NOT NULL) OR status = 'ARCHIVED'),
  ADD CONSTRAINT allocation_scenario_promoted_chk CHECK ((status = 'PROMOTED' AND promoted_proposal_id IS NOT NULL) OR (status IN ('DRAFT', 'RUN') AND promoted_proposal_id IS NULL) OR status = 'ARCHIVED');

CREATE INDEX allocation_scenario_list_idx ON machvon.allocation_scenario (tenant_id, created_at DESC, id DESC);

CREATE FUNCTION machvon.guard_allocation_scenario() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a scenario starts as a draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.code, NEW.plan_year, NEW.input_snapshot_id, NEW.base_capital_plan_id, NEW.constraints_json, NEW.assumptions_json, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.code, OLD.plan_year, OLD.input_snapshot_id, OLD.base_capital_plan_id, OLD.constraints_json, OLD.assumptions_json, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what the scenario asks does not change' USING ERRCODE = '23514';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (('DRAFT', 'RUN'), ('RUN', 'RUN'), ('RUN', 'PROMOTED')) THEN
    RAISE EXCEPTION 'STAGE_TRANSITION_DENIED' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'PROMOTED' AND NEW.result_json IS DISTINCT FROM OLD.result_json THEN
    RAISE EXCEPTION 'the result that was promoted does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER allocation_scenario_guard BEFORE INSERT OR UPDATE ON machvon.allocation_scenario
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_allocation_scenario();

REVOKE DELETE, TRUNCATE ON TABLE machvon.allocation_scenario FROM machvon_app;

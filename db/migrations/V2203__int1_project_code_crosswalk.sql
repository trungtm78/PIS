-- Authored by hand (not generated): the codes of our projects in the other systems of the organization (INT-1 part 3), on the table that already holds the identity of things in other systems: `master_crosswalk`
-- (EGP-1 extended it with `subject_type`/`subject_id` and the maker-checker life PROPOSED, ACTIVE, REJECTED, RETIRED in V1940). No new table of external identities: a project code in another system is a row with
--   subject_type = 'PROJECT', external_type = 'PROJECT_CODE', source_system = a system registered in `int_source_system` (and not the one the e-GP lane owns), the code, the days it holds.
-- What V1940 already guarantees applies unchanged: one external code stands for one subject at a time, one project holds one ACTIVE code per system, a proposal waits once, another person approves, a decided row is final.
-- This migration adds what is specific to these rows: the system must be registered and ACTIVE for the tenant, and the code must fit the pattern the system declared (a trigger, so no path around the application).

CREATE FUNCTION machvon.guard_crosswalk_project_code() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  declared record;
BEGIN
  IF NEW.subject_type IS DISTINCT FROM 'PROJECT' THEN
    RAISE EXCEPTION 'a project code is the code of a project' USING ERRCODE = '23514';
  END IF;
  SELECT s.status, s.code_pattern INTO declared FROM machvon.int_source_system s WHERE s.tenant_id = NEW.tenant_id AND s.code = NEW.source_system;
  IF NOT FOUND OR declared.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'the system % is not registered for this tenant or has been retired', NEW.source_system USING ERRCODE = '23514';
  END IF;
  IF declared.code_pattern IS NOT NULL AND NEW.external_code !~ ('^(?:' || declared.code_pattern || ')$') THEN
    RAISE EXCEPTION 'the code does not fit the format of the system %', NEW.source_system USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER master_crosswalk_project_code_guard BEFORE INSERT ON machvon.master_crosswalk
  FOR EACH ROW WHEN (NEW.external_type = 'PROJECT_CODE') EXECUTE FUNCTION machvon.guard_crosswalk_project_code();

-- The list of the codes of the projects of one system, newest first (the screen and the open API).
CREATE INDEX master_crosswalk_project_code_idx ON machvon.master_crosswalk (tenant_id, source_system, status, created_at DESC, id DESC) WHERE external_type = 'PROJECT_CODE';
CREATE INDEX master_crosswalk_project_code_lookup_idx ON machvon.master_crosswalk (tenant_id, source_system, external_code) WHERE external_type = 'PROJECT_CODE' AND status = 'ACTIVE';

COMMENT ON FUNCTION machvon.guard_crosswalk_project_code() IS 'INT-1: a PROJECT_CODE row names a project and a system registered and ACTIVE for the tenant, and a code that fits the pattern of that system.';

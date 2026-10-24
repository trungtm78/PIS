-- Authored by hand (not generated): the project register (ST-PRJ-001, PRJ 3.1 F1).
-- The tables project and project_revision come from the generated schema (V002); this adds what the register relies on:
-- defaults for the columns the application does not write, checks on the text of the identity, one initial revision per project,
-- a guard that keeps the internal code for good (BR-PRJ-01: a code is never reused) and the conversion of the legacy statuses.

ALTER TABLE machvon.project ALTER COLUMN version SET DEFAULT 1;
ALTER TABLE machvon.project ALTER COLUMN status_changed_at SET DEFAULT now();

-- The code and the name are stored as they were typed after trimming: a code that differs only by a space would defeat the unique index.
ALTER TABLE machvon.project
  ADD CONSTRAINT project_identity_text_chk CHECK (code = btrim(code) AND code <> '' AND name = btrim(name) AND name <> '');
ALTER TABLE machvon.project
  ADD CONSTRAINT project_year_range_chk CHECK ((start_year IS NULL OR start_year BETWEEN 1990 AND 2100) AND (end_year IS NULL OR end_year BETWEEN 1990 AND 2100));

-- The first revision of a project is written with the project and is revision 1; with the unique (project, revision) it is the only one of its kind.
ALTER TABLE machvon.project_revision
  ADD CONSTRAINT project_revision_initial_chk CHECK (change_kind <> 'INITIAL' OR revision = 1);

-- A project keeps its internal code for good, in every tenant: the code is the name the paper trail refers to.
CREATE FUNCTION machvon.guard_project_identity() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'a project keeps its internal code' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_identity_guard BEFORE UPDATE ON machvon.project
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_identity();

-- CR-PRJ-01: the status of the v1.3 register in the stages of the PIMA life cycle. A project that was Active is BUDGETED while it has a
-- capital plan and no investment decision yet, and IMPLEMENTATION otherwise. Data from the legacy register is converted with this
-- function (the mapping is exercised on synthetic data until D04 delivers the real data).
CREATE FUNCTION machvon.prj_legacy_project_status(legacy text, has_capital_plan boolean, has_investment_decision boolean) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE legacy
    WHEN 'Draft' THEN 'CONCEPT'
    WHEN 'InReview' THEN 'APPRAISAL'
    WHEN 'Approved' THEN 'PIPELINE'
    WHEN 'Active' THEN CASE WHEN has_capital_plan AND NOT has_investment_decision THEN 'BUDGETED' ELSE 'IMPLEMENTATION' END
    WHEN 'Closed' THEN 'CLOSED'
  END
$fn$;

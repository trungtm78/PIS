-- Authored by hand (not generated): the post-investment effectiveness of a project, targets part (MR-1, MR.03 merged with G4-7; docs/prj-effectiveness.md).
--   * `effect_target_set`: the target indicators of a project as one set. A set is written as DRAFT by one person and FIXED by another (the maker is not the approver); once FIXED its numbers never change.
--     A change after that is a new draft that names the set it replaces and why; fixing it marks the earlier set SUPERSEDED, so the numbers the project was approved on stay on record.
--   * `effect_indicator`: one target of a set: what is measured, in which unit, in which direction it is good, the baseline and the target, where the actual value comes from and how it is computed.
-- Indicators change only while their set is a DRAFT (the database keeps it, whatever the application does).

CREATE TABLE machvon.effect_target_set (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  -- The ground the targets were set on: the number and date of the decision that approved the investment, as written in the document.
  basis text NOT NULL,
  basis_document_id uuid,
  supersedes_id uuid,
  supersede_reason text,
  drafted_by uuid NOT NULL,
  drafted_at timestamptz NOT NULL DEFAULT now(),
  fixed_by uuid,
  fixed_at timestamptz,
  fixed_on date,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, basis_document_id) REFERENCES machvon.document (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.effect_target_set (tenant_id, id),
  FOREIGN KEY (tenant_id, drafted_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, fixed_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT effect_target_set_status_chk CHECK (status IN ('DRAFT', 'FIXED', 'SUPERSEDED')),
  CONSTRAINT effect_target_set_basis_chk CHECK (basis = btrim(basis) AND char_length(basis) BETWEEN 3 AND 500),
  CONSTRAINT effect_target_set_reason_chk CHECK ((supersedes_id IS NULL) = (supersede_reason IS NULL) AND (supersede_reason IS NULL OR (supersede_reason = btrim(supersede_reason) AND char_length(supersede_reason) BETWEEN 10 AND 2000))),
  CONSTRAINT effect_target_set_fixed_chk CHECK (
    (status = 'DRAFT' AND fixed_by IS NULL AND fixed_at IS NULL AND fixed_on IS NULL)
    OR (status IN ('FIXED', 'SUPERSEDED') AND fixed_by IS NOT NULL AND fixed_at IS NOT NULL AND fixed_on IS NOT NULL AND fixed_by <> drafted_by)
  ),
  CONSTRAINT effect_target_set_version_chk CHECK (version_no >= 1 AND row_version >= 1),
  CONSTRAINT effect_target_set_no_uq UNIQUE (tenant_id, project_id, version_no),
  CONSTRAINT effect_target_set_project_uq UNIQUE (tenant_id, project_id, id)
);
CREATE UNIQUE INDEX effect_target_set_draft_uq ON machvon.effect_target_set (tenant_id, project_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX effect_target_set_fixed_uq ON machvon.effect_target_set (tenant_id, project_id) WHERE status = 'FIXED';
CREATE INDEX effect_target_set_document_idx ON machvon.effect_target_set (tenant_id, basis_document_id) WHERE basis_document_id IS NOT NULL;
CREATE INDEX effect_target_set_supersedes_idx ON machvon.effect_target_set (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX effect_target_set_drafted_idx ON machvon.effect_target_set (tenant_id, drafted_by);
CREATE INDEX effect_target_set_fixed_by_idx ON machvon.effect_target_set (tenant_id, fixed_by) WHERE fixed_by IS NOT NULL;

CREATE TABLE machvon.effect_indicator (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  target_set_id uuid NOT NULL,
  project_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  direction text NOT NULL,
  baseline_value numeric(24, 6),
  baseline_on date,
  target_value numeric(24, 6) NOT NULL,
  -- How long after the commissioning the actual is measured, in months; the calendar and the screens say when a measurement is due from it.
  measure_after_months integer,
  data_source text NOT NULL,
  formula text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, target_set_id) REFERENCES machvon.effect_target_set (tenant_id, project_id, id),
  CONSTRAINT effect_indicator_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT effect_indicator_words_chk CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 3 AND 200
    AND unit = btrim(unit) AND char_length(unit) BETWEEN 1 AND 40
    AND data_source = btrim(data_source) AND char_length(data_source) BETWEEN 3 AND 500
    AND formula = btrim(formula) AND char_length(formula) BETWEEN 3 AND 500
  ),
  CONSTRAINT effect_indicator_direction_chk CHECK (direction IN ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER')),
  CONSTRAINT effect_indicator_baseline_chk CHECK ((baseline_value IS NULL) = (baseline_on IS NULL)),
  CONSTRAINT effect_indicator_months_chk CHECK (measure_after_months IS NULL OR measure_after_months BETWEEN 0 AND 240),
  CONSTRAINT effect_indicator_code_uq UNIQUE (tenant_id, target_set_id, code)
);
CREATE INDEX effect_indicator_project_idx ON machvon.effect_indicator (tenant_id, project_id, code);

-- A set that was fixed is never rewritten: only its status goes on (FIXED -> SUPERSEDED), what it says and who drafted it never change.
CREATE FUNCTION machvon.guard_effect_target_set() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.version_no IS DISTINCT FROM OLD.version_no OR NEW.drafted_by IS DISTINCT FROM OLD.drafted_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a target set keeps its project, its number and its author' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'a superseded target set is never changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'FIXED' AND (NEW.status <> 'SUPERSEDED' OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.fixed_by IS DISTINCT FROM OLD.fixed_by OR NEW.fixed_on IS DISTINCT FROM OLD.fixed_on) THEN
    RAISE EXCEPTION 'a fixed target set is only ever superseded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER effect_target_set_guard BEFORE UPDATE ON machvon.effect_target_set FOR EACH ROW EXECUTE FUNCTION machvon.guard_effect_target_set();
CREATE FUNCTION machvon.effect_target_set_no_delete() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- A draft may be replaced by the person who wrote it; a set that was fixed (or replaced) is kept for good.
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'a fixed target set is never deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$fn$;
CREATE TRIGGER effect_target_set_no_delete BEFORE DELETE ON machvon.effect_target_set FOR EACH ROW EXECUTE FUNCTION machvon.effect_target_set_no_delete();

CREATE FUNCTION machvon.guard_effect_indicator() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  held text;
  set_id uuid;
BEGIN
  set_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.target_set_id ELSE NEW.target_set_id END;
  SELECT s.status INTO held FROM machvon.effect_target_set s WHERE s.tenant_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END AND s.id = set_id;
  IF held IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the indicators of a target set that is not a draft are never changed' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

CREATE TRIGGER effect_indicator_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.effect_indicator FOR EACH ROW EXECUTE FUNCTION machvon.guard_effect_indicator();

ALTER TABLE machvon.effect_target_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.effect_target_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.effect_target_set AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.effect_target_set AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.effect_indicator ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.effect_indicator FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.effect_indicator AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.effect_indicator AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE machvon.effect_target_set IS 'MR-1 (MR.03): the target indicators of a project as one set, drafted by one person and fixed by another.';
COMMENT ON TABLE machvon.effect_indicator IS 'MR-1 (MR.03): one target of a set, with its unit, direction, baseline, target, data source and formula.';

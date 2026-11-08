-- Authored by hand (not generated): the figures entered or loaded against the indicator dictionary (IND-1, DL.02, docs/ind-indicator-dictionary.md).
-- A figure is one number of one indicator of one project in one reporting period. It is a fact about what a person typed, or what a file said, on the day it was entered, so it is never edited:
--   * append-only for every role (a trigger, and no UPDATE, DELETE or TRUNCATE for the application role); a correction is the next `revision` of the same (project, period, indicator) with the reason in words,
--     and the figure in force is the greatest revision, so the history of every number can be read and none of it can be rewritten;
--   * the unit is the unit of the indicator in the register (whole dong for money), the definition version says which version of the dictionary entry the number was entered under, and a figure that came from
--     a file names the import (`file_import`) and the version of the mapping that read it, so a number can always be traced to the file, the line and the mapping version that was approved;
--   * rules at entry (DATA_ENTRY_RULE) are judged by the command before it writes, so a row here already passed them; the trail of the verdict is in the audit row of the command.

CREATE TABLE machvon.ind_figure (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  period_id uuid NOT NULL,
  indicator_code text NOT NULL,
  revision integer NOT NULL,
  value numeric(30, 6) NOT NULL,
  unit text NOT NULL,
  definition_version integer NOT NULL,
  source text NOT NULL,
  import_id uuid,
  import_line integer,
  mapping_code text,
  mapping_version integer,
  mapping_rule_id uuid,
  reason text,
  entered_by uuid NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES machvon.reporting_period (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id),
  FOREIGN KEY (tenant_id, mapping_rule_id) REFERENCES machvon.governance_rule (tenant_id, id),
  CONSTRAINT ind_figure_code_chk CHECK (indicator_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT ind_figure_revision_chk CHECK (revision >= 1),
  CONSTRAINT ind_figure_unit_chk CHECK (unit IN ('PERCENT', 'VND', 'COUNT', 'DAYS', 'RATIO')),
  CONSTRAINT ind_figure_definition_chk CHECK (definition_version >= 0),
  CONSTRAINT ind_figure_source_chk CHECK (source IN ('ENTRY', 'IMPORT')),
  CONSTRAINT ind_figure_import_chk CHECK ((source = 'IMPORT') = (import_id IS NOT NULL) AND (import_id IS NULL) = (import_line IS NULL) AND (import_id IS NULL) = (mapping_code IS NULL) AND (import_id IS NULL) = (mapping_version IS NULL) AND (import_id IS NULL) = (mapping_rule_id IS NULL)),
  CONSTRAINT ind_figure_line_chk CHECK (import_line IS NULL OR import_line >= 1),
  CONSTRAINT ind_figure_mapping_chk CHECK (mapping_code IS NULL OR (mapping_code ~ '^[A-Z][A-Z0-9_]{1,63}$' AND mapping_version >= 0)),
  CONSTRAINT ind_figure_reason_chk CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 1000)),
  -- The first revision needs no reason; a correction says why.
  CONSTRAINT ind_figure_correction_chk CHECK (revision = 1 OR reason IS NOT NULL),
  -- Money and counts are whole numbers.
  CONSTRAINT ind_figure_whole_chk CHECK (unit NOT IN ('VND', 'COUNT') OR value = trunc(value)),
  CONSTRAINT ind_figure_key_uq UNIQUE (tenant_id, project_id, period_id, indicator_code, revision)
);

CREATE INDEX ind_figure_period_idx ON machvon.ind_figure (tenant_id, period_id, project_id, indicator_code);
CREATE INDEX ind_figure_import_idx ON machvon.ind_figure (tenant_id, import_id, import_line) WHERE import_id IS NOT NULL;
CREATE INDEX ind_figure_mapping_idx ON machvon.ind_figure (tenant_id, mapping_rule_id) WHERE mapping_rule_id IS NOT NULL;
CREATE INDEX ind_figure_indicator_idx ON machvon.ind_figure (tenant_id, indicator_code, entered_at);

CREATE FUNCTION machvon.ind_figure_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a figure of the indicator dictionary is append-only: a correction is the next revision' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER ind_figure_append_only BEFORE UPDATE OR DELETE ON machvon.ind_figure FOR EACH ROW EXECUTE FUNCTION machvon.ind_figure_append_only();

ALTER TABLE machvon.ind_figure ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ind_figure FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ind_figure AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ind_figure AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.ind_figure FROM machvon_app;

COMMENT ON TABLE machvon.ind_figure IS 'IND-1: a number of an indicator of the dictionary for a project and a period, entered by hand or loaded from a file through an approved mapping; append-only, a correction is the next revision.';

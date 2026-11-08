-- Authored by hand (not generated): the report engine's layouts and files (RPT-1 part 2, docs/report-engine.md "Part 2: database, API, screens").
-- A report layout is the grid of a form (rows, columns, bindings to the KPI register) registered for a tenant from the catalogue of its edition; a layout version is a fact and never changes:
--   * `report_layout`: append-only, one row per (tenant, code, version); the status (DEMO, DRAFT, READY, PENDING_EXTERNAL) is part of the version, so a demo form is never promoted: the official form is a NEW version (R18);
--   * `report_template_file`: the Excel or Word template of a layout, kept once per sha256 (content-addressed), append-only; the hash is checked by the database itself;
--   * `report_output_file`: the bytes a generation produced (the workbook, the Word narrative), kept once per sha256, append-only; drafts and issued copies point at them, so an issued copy can always be checked against its hash.

CREATE TABLE machvon.report_template_file (
  tenant_id uuid NOT NULL,
  sha256 char(64) NOT NULL,
  format text NOT NULL,
  size_bytes integer NOT NULL,
  content bytea NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256),
  CONSTRAINT report_template_file_format_chk CHECK (format IN ('XLSX', 'DOCX')),
  CONSTRAINT report_template_file_hash_chk CHECK (sha256 ~ '^[0-9a-f]{64}$' AND encode(pg_catalog.sha256(content), 'hex') = sha256),
  CONSTRAINT report_template_file_size_chk CHECK (size_bytes = octet_length(content) AND size_bytes BETWEEN 1 AND 16777216)
);

CREATE TABLE machvon.report_output_file (
  tenant_id uuid NOT NULL,
  sha256 char(64) NOT NULL,
  format text NOT NULL,
  size_bytes integer NOT NULL,
  content bytea NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256),
  CONSTRAINT report_output_file_format_chk CHECK (format IN ('XLSX', 'DOCX')),
  CONSTRAINT report_output_file_hash_chk CHECK (sha256 ~ '^[0-9a-f]{64}$' AND encode(pg_catalog.sha256(content), 'hex') = sha256),
  CONSTRAINT report_output_file_size_chk CHECK (size_bytes = octet_length(content) AND size_bytes BETWEEN 1 AND 16777216)
);

CREATE TABLE machvon.report_layout (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  edition text NOT NULL,
  form_ref text,
  receiver text NOT NULL,
  period_kind text NOT NULL,
  data_source text NOT NULL,
  layout jsonb NOT NULL,
  narrative jsonb,
  template_sha256 char(64) NOT NULL,
  narrative_template_sha256 char(64),
  registered_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, template_sha256) REFERENCES machvon.report_template_file (tenant_id, sha256),
  FOREIGN KEY (tenant_id, narrative_template_sha256) REFERENCES machvon.report_template_file (tenant_id, sha256),
  CONSTRAINT report_layout_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_-]{1,39}$'),
  CONSTRAINT report_layout_version_chk CHECK (version = btrim(version) AND version <> '' AND char_length(version) <= 40),
  CONSTRAINT report_layout_name_chk CHECK (name = btrim(name) AND name <> '' AND char_length(name) <= 300),
  CONSTRAINT report_layout_status_chk CHECK (status IN ('PENDING_EXTERNAL', 'DEMO', 'DRAFT', 'READY')),
  CONSTRAINT report_layout_edition_chk CHECK (edition IN ('public', 'enterprise')),
  CONSTRAINT report_layout_period_chk CHECK (period_kind IN ('MONTH', 'QUARTER', 'HALF_YEAR', 'YEAR', 'AS_OF')),
  CONSTRAINT report_layout_source_chk CHECK (data_source IN ('LIVE', 'ILLUSTRATIVE')),
  CONSTRAINT report_layout_demo_chk CHECK ((status = 'DEMO') = (data_source = 'ILLUSTRATIVE') AND (status <> 'DEMO' OR form_ref IS NULL)),
  CONSTRAINT report_layout_shape_chk CHECK (jsonb_typeof(layout) = 'object' AND (narrative IS NULL OR jsonb_typeof(narrative) = 'array')),
  CONSTRAINT report_layout_narrative_file_chk CHECK ((narrative IS NULL) = (narrative_template_sha256 IS NULL)),
  CONSTRAINT report_layout_version_uq UNIQUE (tenant_id, code, version)
);
CREATE INDEX report_layout_template_idx ON machvon.report_layout (tenant_id, template_sha256);
CREATE INDEX report_layout_list_idx ON machvon.report_layout (tenant_id, code, created_at DESC);

CREATE FUNCTION machvon.report_file_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a report file and a report layout version never change: a new version is a new row' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER report_template_file_append_only BEFORE UPDATE OR DELETE ON machvon.report_template_file FOR EACH ROW EXECUTE FUNCTION machvon.report_file_append_only();
CREATE TRIGGER report_output_file_append_only BEFORE UPDATE OR DELETE ON machvon.report_output_file FOR EACH ROW EXECUTE FUNCTION machvon.report_file_append_only();
CREATE TRIGGER report_layout_append_only BEFORE UPDATE OR DELETE ON machvon.report_layout FOR EACH ROW EXECUTE FUNCTION machvon.report_file_append_only();

ALTER TABLE machvon.report_template_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_template_file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_template_file AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_template_file AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.report_output_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_output_file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_output_file AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_output_file AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.report_layout ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_layout FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_layout AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_layout AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_template_file FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_output_file FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_layout FROM machvon_app;

COMMENT ON TABLE machvon.report_template_file IS 'RPT-1: the Excel or Word template of a report layout, once per sha256; append-only, the hash is checked by a constraint.';
COMMENT ON TABLE machvon.report_output_file IS 'RPT-1: the bytes a report generation produced, once per sha256; drafts and issued copies point at them; append-only.';
COMMENT ON TABLE machvon.report_layout IS 'RPT-1: a report form registered for a tenant from the catalogue of its edition, one row per (code, version); append-only, a DEMO form is never promoted (R18).';

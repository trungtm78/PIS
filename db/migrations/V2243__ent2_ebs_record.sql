-- Authored by hand (not generated): what the files of Oracle EBS said (ENT-2, docs/ebs-connector.md). A row of a file that the framework accepted (`file_import`, `file_import_row`) is kept here as the typed record the layout reads, so that
-- the register has the statement of EBS next to ours: the dry run shows it and the reconciliation compares our figures against it. The record is a fact about what a file said on the day it was applied and never changes:
-- a later extract of the same period is another row (its key carries the extract day), and the reconciliation reads the newest.
--   * one row per (tenant, business key) = (project code, period, extract day), the key the framework claims;
--   * append-only for every role (a trigger and no UPDATE, DELETE or TRUNCATE for the application role);
--   * the layout version and the hash of the row travel with it (R18: what rests on a working assumption says so).

CREATE TABLE machvon.ebs_record (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  business_key text NOT NULL,
  project_code text NOT NULL,
  period text NOT NULL,
  extract_date date NOT NULL,
  disbursed_vnd numeric(24, 2),
  committed_vnd numeric(24, 2),
  layout_version text NOT NULL,
  import_id uuid NOT NULL,
  line integer NOT NULL,
  row_hash char(64) NOT NULL,
  applied_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id),
  CONSTRAINT ebs_record_key_chk CHECK (business_key = btrim(business_key) AND business_key <> '' AND char_length(business_key) <= 300),
  CONSTRAINT ebs_record_project_chk CHECK (project_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$'),
  CONSTRAINT ebs_record_period_chk CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ebs_record_layout_chk CHECK (layout_version = btrim(layout_version) AND layout_version <> '' AND char_length(layout_version) <= 60),
  CONSTRAINT ebs_record_line_chk CHECK (line >= 1),
  CONSTRAINT ebs_record_hash_chk CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ebs_record_amount_chk CHECK (disbursed_vnd IS NOT NULL OR committed_vnd IS NOT NULL),
  CONSTRAINT ebs_record_key_uq UNIQUE (tenant_id, business_key)
);

CREATE INDEX ebs_record_import_idx ON machvon.ebs_record (tenant_id, import_id, line);
CREATE INDEX ebs_record_project_idx ON machvon.ebs_record (tenant_id, project_code, period, extract_date DESC, id);
CREATE INDEX ebs_record_actor_idx ON machvon.ebs_record (tenant_id, applied_by, created_at DESC);

CREATE FUNCTION machvon.ebs_record_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'what a file of Oracle EBS said is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER ebs_record_append_only BEFORE UPDATE OR DELETE ON machvon.ebs_record FOR EACH ROW EXECUTE FUNCTION machvon.ebs_record_append_only();

ALTER TABLE machvon.ebs_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ebs_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ebs_record AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ebs_record AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.ebs_record FROM machvon_app;

COMMENT ON TABLE machvon.ebs_record IS 'ENT-2: the typed record of each accepted row of an Oracle EBS file, with its layout version and row hash; one per project, period and extract day; append-only; PENDING-EXTERNAL.';

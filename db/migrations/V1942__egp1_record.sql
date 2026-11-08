-- Authored by hand (not generated): what the files of the national procurement network said (EGP-1 part 2, BID-24, docs/egp-connector.md section 4).
-- A row of a file that the framework accepted (`file_import`, `file_import_row`) is kept here as the typed record the layout reads, so that the register has the network's own statement next to ours:
-- the dry run shows it, the screen of the mappings suggests from it, the reconciliation (EGP-2) compares ours against it, and the workflow of the procurement package reads the milestones of a notice and a result from it.
-- The record is a fact about what a file said on the day it was applied and never changes: a later file that says something else about the same key is a difference with an owner (the framework opens it), not an overwrite.
--   * one row per (tenant, kind, business key), the same key the framework claims, so a key is recorded once however many files carry it;
--   * append-only for every role (a trigger and no UPDATE, DELETE or TRUNCATE for the application role);
--   * the layout version and the hash of the row travel with it (R18: what rests on a working assumption says so).

CREATE TABLE machvon.egp_record (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  business_key text NOT NULL,
  layout_version text NOT NULL,
  import_id uuid NOT NULL,
  line integer NOT NULL,
  row_hash char(64) NOT NULL,
  record jsonb NOT NULL,
  applied_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id),
  CONSTRAINT egp_record_kind_chk CHECK (kind IN ('KHLCNT', 'TBMT', 'RESULT', 'CONTRACTOR', 'RESTRICTION')),
  CONSTRAINT egp_record_key_chk CHECK (business_key = btrim(business_key) AND business_key <> '' AND char_length(business_key) <= 300),
  CONSTRAINT egp_record_layout_chk CHECK (layout_version = btrim(layout_version) AND layout_version <> '' AND char_length(layout_version) <= 40),
  CONSTRAINT egp_record_line_chk CHECK (line >= 1),
  CONSTRAINT egp_record_hash_chk CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT egp_record_shape_chk CHECK (jsonb_typeof(record) = 'object'),
  CONSTRAINT egp_record_key_uq UNIQUE (tenant_id, kind, business_key)
);

CREATE INDEX egp_record_import_idx ON machvon.egp_record (tenant_id, import_id, line);
CREATE INDEX egp_record_package_idx ON machvon.egp_record (tenant_id, kind, (record ->> 'packageExternalCode')) WHERE kind IN ('KHLCNT', 'TBMT', 'RESULT');
CREATE INDEX egp_record_tax_idx ON machvon.egp_record (tenant_id, kind, (record ->> 'contractorTaxCode')) WHERE kind IN ('CONTRACTOR', 'RESTRICTION', 'RESULT');

CREATE FUNCTION machvon.egp_record_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'what a file of the national network said is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER egp_record_append_only BEFORE UPDATE OR DELETE ON machvon.egp_record FOR EACH ROW EXECUTE FUNCTION machvon.egp_record_append_only();

ALTER TABLE machvon.egp_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.egp_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.egp_record AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.egp_record AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.egp_record FROM machvon_app;

COMMENT ON TABLE machvon.egp_record IS 'EGP-1: the typed record of each accepted row of a file of the national network, with its layout version and row hash; one per business key; append-only.';

-- Authored by hand (not generated): the idempotent file-import framework (ST-KERNEL-070, NFR-OPERABILITY-06, kit K6).
-- A file from an outside system (a Treasury statement, a national investment export, a procurement file) is identified by its SHA-256 and
-- its rows by a business key and a row hash, so that the same file or the same row is never applied twice, a row that fails is kept in
-- quarantine with its reason, and a difference is a reconciliation item that has an owner and a due date. The module that owns the data
-- plugs a format and an apply step into the framework; these tables are the evidence that is common to all of them:
--   * file_import: one row per file taken, with its hash and its counts. One file per connector and hash unless the earlier try FAILED.
--   * file_import_row: one row per business key ever applied for a connector (the claim): this is what stops a row from being applied twice
--     by another file, and what the certified totals add up.
--   * file_import_quarantine: the rows that were refused, with the line, the field and a stable code; append-only.
--   * file_import_reconciliation_item: a difference that a person owns until it is resolved with a note.

CREATE TABLE machvon.file_import (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  format_version text NOT NULL,
  file_sha256 char(64) NOT NULL,
  file_object_key text NOT NULL,
  status text NOT NULL DEFAULT 'IMPORTING',
  error_code text,
  rows_total integer NOT NULL DEFAULT 0,
  rows_applied integer NOT NULL DEFAULT 0,
  rows_duplicate integer NOT NULL DEFAULT 0,
  rows_conflict integer NOT NULL DEFAULT 0,
  rows_quarantined integer NOT NULL DEFAULT 0,
  differences_opened integer NOT NULL DEFAULT 0,
  imported_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT file_import_connector_chk CHECK (connector_code ~ '^[A-Z][A-Z0-9_]*$' AND char_length(connector_code) <= 80),
  CONSTRAINT file_import_format_version_chk CHECK (format_version = btrim(format_version) AND format_version <> '' AND char_length(format_version) <= 40),
  CONSTRAINT file_import_sha256_chk CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT file_import_object_key_chk CHECK (file_object_key = btrim(file_object_key) AND file_object_key <> '' AND char_length(file_object_key) <= 500),
  CONSTRAINT file_import_status_chk CHECK (status IN ('IMPORTING', 'APPLIED', 'FAILED')),
  CONSTRAINT file_import_error_chk CHECK ((status = 'FAILED') = (error_code IS NOT NULL) AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]*$')),
  CONSTRAINT file_import_completed_chk CHECK ((status = 'IMPORTING') = (completed_at IS NULL)),
  CONSTRAINT file_import_counts_chk CHECK (
    rows_total >= 0 AND rows_applied >= 0 AND rows_duplicate >= 0 AND rows_conflict >= 0 AND rows_quarantined >= 0 AND differences_opened >= 0
  ),
  CONSTRAINT file_import_applied_counts_chk CHECK (status <> 'APPLIED' OR rows_applied + rows_duplicate + rows_conflict + rows_quarantined = rows_total)
);

-- One try per file: a second import of the same bytes for the connector finds this row, unless that try FAILED (then it may be tried again).
CREATE UNIQUE INDEX file_import_file_uq ON machvon.file_import (tenant_id, connector_code, file_sha256) WHERE status <> 'FAILED';
CREATE INDEX file_import_connector_idx ON machvon.file_import (tenant_id, connector_code, created_at, id);

CREATE TABLE machvon.file_import_row (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  business_key text NOT NULL,
  row_hash char(64) NOT NULL,
  measure numeric(30, 6),
  first_import_id uuid NOT NULL,
  first_line integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT file_import_row_connector_chk CHECK (connector_code ~ '^[A-Z][A-Z0-9_]*$' AND char_length(connector_code) <= 80),
  CONSTRAINT file_import_row_key_chk CHECK (business_key = btrim(business_key) AND business_key <> '' AND char_length(business_key) <= 300),
  CONSTRAINT file_import_row_hash_chk CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT file_import_row_line_chk CHECK (first_line >= 1),
  FOREIGN KEY (tenant_id, first_import_id) REFERENCES machvon.file_import (tenant_id, id)
);

-- A business key is applied once per connector, whichever file carries it: this index is the whole guarantee.
CREATE UNIQUE INDEX file_import_row_key_uq ON machvon.file_import_row (tenant_id, connector_code, business_key);
CREATE INDEX file_import_row_import_idx ON machvon.file_import_row (tenant_id, first_import_id);

CREATE TABLE machvon.file_import_quarantine (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL,
  line integer NOT NULL,
  business_key text,
  error_code text NOT NULL,
  field text NOT NULL,
  row_hash char(64) NOT NULL,
  masked_preview jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT file_import_quarantine_line_chk CHECK (line >= 1),
  CONSTRAINT file_import_quarantine_code_chk CHECK (error_code ~ '^[A-Z][A-Z0-9_]*$' AND char_length(error_code) <= 50),
  CONSTRAINT file_import_quarantine_field_chk CHECK (field ~ '^[A-Za-z][A-Za-z0-9_.]*$' AND char_length(field) <= 80),
  CONSTRAINT file_import_quarantine_key_chk CHECK (business_key IS NULL OR (business_key = btrim(business_key) AND business_key <> '' AND char_length(business_key) <= 300)),
  CONSTRAINT file_import_quarantine_hash_chk CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT file_import_quarantine_preview_chk CHECK (masked_preview IS NULL OR jsonb_typeof(masked_preview) = 'object'),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id)
);

CREATE UNIQUE INDEX file_import_quarantine_line_uq ON machvon.file_import_quarantine (tenant_id, import_id, line);
CREATE INDEX file_import_quarantine_code_idx ON machvon.file_import_quarantine (tenant_id, error_code);

CREATE TABLE machvon.file_import_reconciliation_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL,
  line integer NOT NULL,
  connector_code text NOT NULL,
  business_key text NOT NULL,
  code text NOT NULL,
  expected_value text,
  actual_value text,
  difference text,
  detail text,
  row_hash char(64),
  owner_membership_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'OPEN',
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT file_import_item_line_chk CHECK (line >= 1),
  CONSTRAINT file_import_item_connector_chk CHECK (connector_code ~ '^[A-Z][A-Z0-9_]*$' AND char_length(connector_code) <= 80),
  CONSTRAINT file_import_item_key_chk CHECK (business_key = btrim(business_key) AND business_key <> '' AND char_length(business_key) <= 300),
  CONSTRAINT file_import_item_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]*$' AND char_length(code) <= 50),
  CONSTRAINT file_import_item_text_chk CHECK (char_length(expected_value) <= 500 AND char_length(actual_value) <= 500 AND char_length(difference) <= 100 AND char_length(detail) <= 2000),
  CONSTRAINT file_import_item_hash_chk CHECK (row_hash IS NULL OR row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT file_import_item_status_chk CHECK (status IN ('OPEN', 'RESOLVED')),
  CONSTRAINT file_import_item_due_chk CHECK (due_at >= opened_at),
  CONSTRAINT file_import_item_version_chk CHECK (version >= 1),
  CONSTRAINT file_import_item_resolved_chk CHECK (
    (status = 'RESOLVED') = (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id),
  -- A difference is owned by a person of the tenant, not by a name in a text column.
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id)
);

-- One open item per connector, business key and kind of difference: the same difference met again in another file joins the open one.
CREATE UNIQUE INDEX file_import_item_open_uq ON machvon.file_import_reconciliation_item (tenant_id, connector_code, business_key, code) WHERE status = 'OPEN';
CREATE INDEX file_import_item_owner_idx ON machvon.file_import_reconciliation_item (tenant_id, owner_membership_id, due_at, id) WHERE status = 'OPEN';
CREATE INDEX file_import_item_due_idx ON machvon.file_import_reconciliation_item (tenant_id, due_at, id) WHERE status = 'OPEN';
CREATE INDEX file_import_item_import_idx ON machvon.file_import_reconciliation_item (tenant_id, import_id);

ALTER TABLE machvon.file_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.file_import FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.file_import AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.file_import AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.file_import_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.file_import_row FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.file_import_row AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.file_import_row AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.file_import_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.file_import_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.file_import_quarantine AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.file_import_quarantine AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.file_import_reconciliation_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.file_import_reconciliation_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.file_import_reconciliation_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.file_import_reconciliation_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- What an outside system told us, what was applied and what was refused is evidence: nothing is deleted, and a claimed row or a
-- quarantined row is never rewritten. A try and an item change only through their guards below.
REVOKE DELETE, TRUNCATE ON TABLE machvon.file_import FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.file_import_row FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.file_import_quarantine FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.file_import_reconciliation_item FROM machvon_app;

-- A try keeps its identity. It starts IMPORTING and ends once, APPLIED or FAILED, and is not changed after that.
CREATE FUNCTION machvon.file_import_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.connector_code IS DISTINCT FROM OLD.connector_code
     OR NEW.format_version IS DISTINCT FROM OLD.format_version OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
     OR NEW.file_object_key IS DISTINCT FROM OLD.file_object_key OR NEW.imported_by IS DISTINCT FROM OLD.imported_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a file import keeps its identity' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'IMPORTING' THEN
    RAISE EXCEPTION 'a finished file import is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER file_import_guard BEFORE UPDATE ON machvon.file_import
  FOR EACH ROW EXECUTE FUNCTION machvon.file_import_guard();

-- An item keeps what it says; its owner can change (a person leaves, a steward takes over), it ends once with a note, and every change
-- raises the version by one.
CREATE FUNCTION machvon.file_import_reconciliation_item_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.import_id IS DISTINCT FROM OLD.import_id
     OR NEW.line IS DISTINCT FROM OLD.line OR NEW.connector_code IS DISTINCT FROM OLD.connector_code
     OR NEW.business_key IS DISTINCT FROM OLD.business_key OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.expected_value IS DISTINCT FROM OLD.expected_value OR NEW.actual_value IS DISTINCT FROM OLD.actual_value
     OR NEW.difference IS DISTINCT FROM OLD.difference OR NEW.detail IS DISTINCT FROM OLD.detail OR NEW.row_hash IS DISTINCT FROM OLD.row_hash
     OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'a reconciliation item keeps what it says and when it is due' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved reconciliation item is not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'the version of a reconciliation item grows by one with every change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER file_import_reconciliation_item_guard BEFORE UPDATE ON machvon.file_import_reconciliation_item
  FOR EACH ROW EXECUTE FUNCTION machvon.file_import_reconciliation_item_guard();

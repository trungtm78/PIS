-- Authored by hand (not generated): stable BOQ items and the versioned BOQ lines of a contract revision (ST-CTR-002, CTR 3.1 step 2, BR-CTR-02).
-- The tables boq_item and boq_line come from the generated schema (V002, with the extension columns of CTR). This adds what the import and the
-- later stories rely on, so that the database holds what the application checked first:
--   * a line is the price of one stable item in one revision, and the amount is the exact product of the quantity and the unit price rounded by
--     the rule of the line (HALF_UP, DOWN or UP): no amount can differ from it, whoever writes the row;
--   * a line is written only while its revision is a draft: a revision that was decided is the paper trail of what was agreed (BR-CTR-03);
--   * an item keeps its key and its contract for good, and its unit and wording once a line prices it: a different unit is a different item;
--   * every import is kept (its file hash, its mode and what it gave), so the same file imported twice is recognised and answers the first result.

-- ---- boq_item: stable identity across the revisions ----------------------------------------------------------------------

ALTER TABLE machvon.boq_item
  ADD CONSTRAINT boq_item_text_chk CHECK (
    business_key = btrim(business_key) AND business_key <> ''
    AND description = btrim(description) AND description <> ''
    AND unit_code = btrim(unit_code) AND unit_code <> ''
  );

CREATE FUNCTION machvon.guard_boq_item_identity() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.business_key, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.business_key, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a BOQ item keeps its key and its contract' USING ERRCODE = '23514';
  END IF;
  -- The unit and the wording of an item are what its lines were priced in: once a line refers to the item they are fixed, and a different
  -- unit is a different item. An item that no line refers to yet (a draft that is being put right) may still be corrected.
  IF (NEW.unit_code, NEW.description) IS DISTINCT FROM (OLD.unit_code, OLD.description)
     AND EXISTS (SELECT 1 FROM machvon.boq_line WHERE tenant_id = OLD.tenant_id AND boq_item_id = OLD.id) THEN
    RAISE EXCEPTION 'a BOQ item keeps its unit and wording once a line prices it: a different unit is a different item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER boq_item_identity_guard BEFORE UPDATE ON machvon.boq_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_boq_item_identity();

-- An item is the identity that the ledger, the measurements and the acceptances refer to: it is cancelled when nothing uses it, never deleted.
REVOKE DELETE, TRUNCATE ON TABLE machvon.boq_item FROM machvon_app;

-- ---- boq_line: the price of an item in a revision --------------------------------------------------------------------------

ALTER TABLE machvon.boq_line
  ADD CONSTRAINT boq_line_item_chk CHECK (boq_item_id IS NOT NULL AND contract_id IS NOT NULL AND line_no IS NOT NULL AND line_no > 0),
  ADD CONSTRAINT boq_line_text_chk CHECK (
    business_key = btrim(business_key) AND business_key <> ''
    AND description = btrim(description) AND description <> ''
    AND unit_code = btrim(unit_code) AND unit_code <> ''
    AND (milestone_code IS NULL OR (milestone_code = btrim(milestone_code) AND milestone_code <> ''))
  ),
  ADD CONSTRAINT boq_line_amount_chk CHECK (
    amount_vnd = CASE rounding_rule
      WHEN 'HALF_UP' THEN round(quantity * unit_price)
      WHEN 'DOWN' THEN trunc(quantity * unit_price)
      ELSE ceil(quantity * unit_price)
    END
  );

-- One line per item in a revision, and a line number is used once in it.
CREATE UNIQUE INDEX boq_line_revision_item_uq ON machvon.boq_line (tenant_id, contract_revision_id, boq_item_id);
CREATE UNIQUE INDEX boq_line_revision_no_uq ON machvon.boq_line (tenant_id, contract_revision_id, line_no);

CREATE FUNCTION machvon.guard_boq_line_write() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target_tenant uuid;
  target_revision uuid;
  held record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_revision := OLD.contract_revision_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_revision := NEW.contract_revision_id;
  END IF;
  SELECT status, contract_id INTO held FROM machvon.contract_revision WHERE tenant_id = target_tenant AND id = target_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVISION_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  IF held.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'REVISION_NOT_DRAFT' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.contract_revision_id, NEW.boq_item_id, NEW.contract_id) IS DISTINCT FROM (OLD.tenant_id, OLD.contract_revision_id, OLD.boq_item_id, OLD.contract_id) THEN
    RAISE EXCEPTION 'a BOQ line keeps its revision and its item' USING ERRCODE = '23514';
  END IF;
  -- The line, its revision and its item are of one contract.
  IF NEW.contract_id IS DISTINCT FROM held.contract_id
     OR NOT EXISTS (SELECT 1 FROM machvon.boq_item WHERE tenant_id = NEW.tenant_id AND id = NEW.boq_item_id AND contract_id = NEW.contract_id AND business_key = NEW.business_key AND unit_code = NEW.unit_code) THEN
    RAISE EXCEPTION 'a BOQ line belongs to the contract, the key and the unit of its item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER boq_line_write_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.boq_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_boq_line_write();

-- ---- boq_import: what was imported, so the same file is not imported twice ---------------------------------------------------------

CREATE TABLE machvon.boq_import (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  contract_id uuid NOT NULL,
  contract_revision_id uuid NOT NULL,
  -- The order of the imports into one revision: a REPLACE starts a new generation that the earlier imports do not belong to.
  seq integer NOT NULL CHECK (seq > 0),
  mode text NOT NULL CHECK (mode IN ('REPLACE', 'APPEND')),
  -- The hash of the file, or of the lines when no file was given.
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('FILE', 'LINES')),
  -- Where the file is kept in the object store (the shared pipeline of the platform), when the lines came from a file.
  source_object_key text CHECK (source_object_key IS NULL OR (source_kind = 'FILE' AND source_object_key <> '')),
  lines_imported integer NOT NULL CHECK (lines_imported > 0),
  items_created integer NOT NULL CHECK (items_created >= 0 AND items_created <= lines_imported),
  lines_total_vnd numeric(24, 0) NOT NULL CHECK (lines_total_vnd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, contract_revision_id, seq),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_revision_id) REFERENCES machvon.contract_revision (tenant_id, id)
);

CREATE INDEX boq_import_contract_id_idx ON machvon.boq_import (tenant_id, contract_id);
CREATE INDEX boq_import_source_idx ON machvon.boq_import (tenant_id, contract_revision_id, source_sha256);

ALTER TABLE machvon.boq_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.boq_import FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.boq_import AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.boq_import AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The record of an import is evidence of what the BOQ was built from: it is appended and never edited or removed by the runtime role.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.boq_import FROM machvon_app;

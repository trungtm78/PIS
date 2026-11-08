-- Authored by hand (not generated): the text of a version, in units that can be cited exactly (DOC-2, PD.01, docs/doc-repository.md section 3).
-- The extraction (a PDF text layer, a Word file, a workbook, or an OCR engine behind the same port) is kept as UNITS: one row per paragraph, list item, heading, table cell or sheet cell, in reading order, with
-- where it sits (page and paragraph, table row and column, sheet and cell), the box it occupies on its page (fractions from the top left corner), and a STABLE CITATION id. The id is derived from the SHA-256 of the file
-- and the place of the unit, never from the text, so a citation made today still points at the same place after a re-extraction, and another feature (the assistant of AI-2) can cite a place of a version by
-- `docver:<version id>#<citation id>`.
--   * append-only for every role (a trigger, and no UPDATE, DELETE or TRUNCATE for the application role): what was read is a fact about the file; a correction is a comment, a new reading is a new version.
--   * a unit is kept only for a version of the same tenant (the foreign key) and only while the version has no text yet (the trigger), so a locked version never gains a unit.

CREATE TABLE machvon.document_text_unit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL,
  seq integer NOT NULL,
  citation_id text NOT NULL,
  kind text NOT NULL,
  locator_key text NOT NULL,
  label text NOT NULL,
  page_no integer,
  paragraph_no integer,
  sheet_name text,
  cell_ref text,
  box jsonb,
  text text NOT NULL,
  text_sha256 char(64) NOT NULL,
  confidence numeric(5, 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES machvon.project_document_version (tenant_id, id),
  CONSTRAINT document_text_unit_seq_uq UNIQUE (tenant_id, version_id, seq),
  CONSTRAINT document_text_unit_citation_uq UNIQUE (tenant_id, version_id, citation_id),
  CONSTRAINT document_text_unit_place_uq UNIQUE (tenant_id, version_id, locator_key),
  CONSTRAINT document_text_unit_seq_chk CHECK (seq >= 1),
  CONSTRAINT document_text_unit_citation_chk CHECK (citation_id ~ '^cit_[0-9a-f]{20}$'),
  CONSTRAINT document_text_unit_kind_chk CHECK (kind IN ('HEADING', 'PARAGRAPH', 'LIST_ITEM', 'TABLE_CELL', 'SHEET_CELL')),
  CONSTRAINT document_text_unit_locator_chk CHECK (char_length(locator_key) BETWEEN 1 AND 80 AND char_length(label) BETWEEN 1 AND 80),
  CONSTRAINT document_text_unit_page_chk CHECK ((page_no IS NULL OR page_no >= 1) AND (paragraph_no IS NULL OR paragraph_no >= 1)),
  CONSTRAINT document_text_unit_cell_chk CHECK ((sheet_name IS NULL) = (cell_ref IS NULL) AND (kind = 'SHEET_CELL') = (sheet_name IS NOT NULL)),
  CONSTRAINT document_text_unit_box_chk CHECK (box IS NULL OR (jsonb_typeof(box) = 'object' AND page_no IS NOT NULL)),
  CONSTRAINT document_text_unit_text_chk CHECK (char_length(text) BETWEEN 1 AND 20000),
  CONSTRAINT document_text_unit_hash_chk CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT document_text_unit_confidence_chk CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
);

CREATE INDEX document_text_unit_page_idx ON machvon.document_text_unit (tenant_id, version_id, page_no, seq) WHERE page_no IS NOT NULL;
CREATE INDEX document_text_unit_sheet_idx ON machvon.document_text_unit (tenant_id, version_id, sheet_name, seq) WHERE sheet_name IS NOT NULL;

CREATE FUNCTION machvon.document_text_unit_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'what was read from a file is append-only' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM machvon.project_document_version v
     WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.version_id AND v.status <> 'APPROVED' AND v.extraction_status <> 'EXTRACTED'
  ) THEN
    RAISE EXCEPTION 'the text of this version is read already, or the version is locked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_text_unit_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.document_text_unit FOR EACH ROW EXECUTE FUNCTION machvon.document_text_unit_guard();

ALTER TABLE machvon.document_text_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.document_text_unit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.document_text_unit AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.document_text_unit AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.document_text_unit FROM machvon_app;

COMMENT ON TABLE machvon.document_text_unit IS 'DOC-2: the text of a version in citable units (page and paragraph, table cell, sheet cell) with a stable citation id and the box on the page; append-only.';

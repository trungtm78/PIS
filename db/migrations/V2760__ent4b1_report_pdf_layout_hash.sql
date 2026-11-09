-- Authored by hand (not generated): the PDF of a report form and the hash of the layout that made it (ENT-4b, docs/report-engine.md "PDF", eng-review R23 and R26).
--   * `report_output_file` accepts the format PDF (the bytes are kept once per sha256, like the workbook and the Word file);
--   * `report_draft` and `report_issue` record `pdf_sha256` (and the issued copy `pdf_name`, from the file-name rule) next to the other files. The PDF is a rendition of the same document, so it is NOT part of the package
--     digest (`sha256` of a copy stays the digest of the workbook and the Word file): a report generated before this release is still recognised as a repeat. The hash of the PDF is recorded and checked on every read;
--   * both record `layout_sha256`, the hash of the layout (and narrative skeleton) that made the files, so an issued copy keeps which layout version produced it even when the layout is a configured one;
--   * the issue trigger now also requires the PDF and the layout hash of the copy to be those of the approved draft, and the draft keeps them like the other files.

ALTER TABLE machvon.report_output_file DROP CONSTRAINT report_output_file_format_chk;
ALTER TABLE machvon.report_output_file ADD CONSTRAINT report_output_file_format_chk CHECK (format IN ('XLSX', 'DOCX', 'PDF'));

ALTER TABLE machvon.report_draft ADD COLUMN pdf_sha256 char(64);
ALTER TABLE machvon.report_draft ADD COLUMN layout_sha256 char(64);
ALTER TABLE machvon.report_draft ADD CONSTRAINT report_draft_pdf_fk FOREIGN KEY (tenant_id, pdf_sha256) REFERENCES machvon.report_output_file (tenant_id, sha256);
ALTER TABLE machvon.report_draft ADD CONSTRAINT report_draft_layout_hash_chk CHECK (layout_sha256 IS NULL OR layout_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE machvon.report_issue ADD COLUMN pdf_sha256 char(64);
ALTER TABLE machvon.report_issue ADD COLUMN pdf_name text;
ALTER TABLE machvon.report_issue ADD COLUMN layout_sha256 char(64);
ALTER TABLE machvon.report_issue ADD CONSTRAINT report_issue_pdf_fk FOREIGN KEY (tenant_id, pdf_sha256) REFERENCES machvon.report_output_file (tenant_id, sha256);
ALTER TABLE machvon.report_issue ADD CONSTRAINT report_issue_pdf_names_chk CHECK ((pdf_sha256 IS NULL) = (pdf_name IS NULL));
ALTER TABLE machvon.report_issue ADD CONSTRAINT report_issue_layout_hash_chk CHECK (layout_sha256 IS NULL OR layout_sha256 ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION machvon.report_issue_lineage() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  previous machvon.report_issue%ROWTYPE;
  source machvon.report_draft%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previous FROM machvon.report_issue WHERE tenant_id = NEW.tenant_id AND id = NEW.supersedes_id;
    IF NOT FOUND OR previous.layout_code <> NEW.layout_code OR previous.period_code <> NEW.period_code OR previous.revision <> NEW.revision - 1 THEN
      RAISE EXCEPTION 'a revision replaces the one before it in the same series' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO source FROM machvon.report_draft WHERE tenant_id = NEW.tenant_id AND id = NEW.draft_id;
  IF NOT FOUND OR source.state <> 'APPROVED' OR source.package_sha256 <> NEW.sha256 OR source.xlsx_sha256 <> NEW.xlsx_sha256
     OR source.docx_sha256 IS DISTINCT FROM NEW.docx_sha256 OR source.pdf_sha256 IS DISTINCT FROM NEW.pdf_sha256 OR source.layout_sha256 IS DISTINCT FROM NEW.layout_sha256
     OR source.prepared_by <> NEW.prepared_by OR source.checked_by <> NEW.checked_by OR source.approved_by <> NEW.approved_by THEN
    RAISE EXCEPTION 'a copy is issued only from the approved draft, with its files and its three people' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION machvon.report_draft_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.state = 'ISSUED' THEN
    RAISE EXCEPTION 'an issued draft never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.layout_id <> OLD.layout_id OR NEW.layout_code <> OLD.layout_code OR NEW.layout_version <> OLD.layout_version OR NEW.period_code <> OLD.period_code OR NEW.period <> OLD.period
     OR NEW.xlsx_sha256 <> OLD.xlsx_sha256 OR NEW.docx_sha256 IS DISTINCT FROM OLD.docx_sha256 OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 OR NEW.layout_sha256 IS DISTINCT FROM OLD.layout_sha256
     OR NEW.package_sha256 <> OLD.package_sha256 OR NEW.prepared_by <> OLD.prepared_by
     OR NEW.base_revision <> OLD.base_revision OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.marks <> OLD.marks OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a draft keeps what it was made from' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state = 'DRAFT' AND NEW.state = 'CHECKED') OR (OLD.state = 'CHECKED' AND NEW.state = 'APPROVED') OR (OLD.state = 'APPROVED' AND NEW.state = 'ISSUED')) OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a draft is checked, then approved, then issued, one step at a time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON COLUMN machvon.report_draft.pdf_sha256 IS 'ENT-4b: the PDF rendition of the same document; not part of the package digest.';
COMMENT ON COLUMN machvon.report_draft.layout_sha256 IS 'ENT-4b: sha256 of the layout and narrative skeleton that made the files.';
COMMENT ON COLUMN machvon.report_issue.pdf_sha256 IS 'ENT-4b: the PDF of the issued copy, kept and checked by its hash.';
COMMENT ON COLUMN machvon.report_issue.layout_sha256 IS 'ENT-4b: the layout version (hash) the copy was made from.';

-- Authored by hand (not generated): the review of the OCR of the pages of a proposal (ST-BID-008, BID 3 F3, BR-BID-03/06). The table document_page_ocr comes from the generated schema (V002) with its
-- unique page and its index; this adds what the review relies on: whether a table of the page did not add up, the note and the corrected text of the reviewer, and the guard that makes the
-- reading of the engine a fact: what the engine said about a page never changes, and a page that waits for a person only moves to CONFIRMED or CORRECTED, once.

ALTER TABLE machvon.document_page_ocr
  ADD COLUMN table_mismatch boolean NOT NULL DEFAULT false,
  ADD COLUMN review_note text,
  ADD COLUMN corrected_text_object_key text,
  ADD COLUMN corrected_text_sha256 char(64);

ALTER TABLE machvon.document_page_ocr
  ADD CONSTRAINT document_page_ocr_mismatch_chk CHECK (NOT table_mismatch OR review_status <> 'AUTO_ACCEPTED'),
  ADD CONSTRAINT document_page_ocr_note_chk CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  ADD CONSTRAINT document_page_ocr_corrected_chk CHECK (
    (review_status = 'CORRECTED') = (corrected_text_object_key IS NOT NULL) AND (corrected_text_object_key IS NULL) = (corrected_text_sha256 IS NULL)
  ),
  ADD CONSTRAINT document_page_ocr_reviewed_chk CHECK ((review_status IN ('CONFIRMED', 'CORRECTED')) = (reviewed_at IS NOT NULL) AND (reviewed_by IS NULL) = (reviewed_at IS NULL)),
  ADD CONSTRAINT document_page_ocr_tables_chk CHECK (jsonb_typeof(tables_json) = 'array');

-- A text of a correction is the text of one page: the same stored file cannot stand for two pages.
CREATE UNIQUE INDEX document_page_ocr_corrected_uq ON machvon.document_page_ocr (tenant_id, corrected_text_object_key) WHERE corrected_text_object_key IS NOT NULL;

-- What the engine read is fixed when the page is written (as waiting or accepted, never as reviewed); the only change a page has is the review of a page that waits, once, by a person;
-- nothing deletes a page. The owner of the schema (the migrations and the maintenance of the platform) is not held by this guard.
CREATE FUNCTION machvon.guard_document_page_ocr() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.review_status NOT IN ('AUTO_ACCEPTED', 'NEEDS_REVIEW') OR NEW.reviewed_by IS NOT NULL OR NEW.review_note IS NOT NULL THEN
      RAISE EXCEPTION 'a page is read before it is reviewed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'the reading of a page is kept for good' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.page_index IS DISTINCT FROM OLD.page_index OR NEW.ocr_confidence IS DISTINCT FROM OLD.ocr_confidence OR NEW.text_sha256 IS DISTINCT FROM OLD.text_sha256
     OR NEW.text_object_key IS DISTINCT FROM OLD.text_object_key OR NEW.tables_json IS DISTINCT FROM OLD.tables_json OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
     OR NEW.table_mismatch IS DISTINCT FROM OLD.table_mismatch OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what the engine read of a page does not change' USING ERRCODE = '42501';
  END IF;
  IF OLD.review_status <> 'NEEDS_REVIEW' THEN
    RAISE EXCEPTION 'a page that was accepted or reviewed stays so' USING ERRCODE = '42501';
  END IF;
  IF NEW.review_status NOT IN ('CONFIRMED', 'CORRECTED') OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'a page that waits is confirmed or corrected by a person' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_page_ocr_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.document_page_ocr
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_page_ocr();
CREATE TRIGGER document_page_ocr_no_truncate BEFORE TRUNCATE ON machvon.document_page_ocr
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_document_page_ocr();
REVOKE DELETE, TRUNCATE ON TABLE machvon.document_page_ocr FROM machvon_app;

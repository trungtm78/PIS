-- Authored by hand (not generated): the governance of the layout profiles (ST-DOC-016, DOC.md F12, BR-DOC-13).
-- V002 gave `document_layout_profile` its columns, its states (DRAFT, PUBLISHED, SUPERSEDED), the four-eyes check (`approved_by <> created_by`) and the ban on overlapping periods of the same code (the exclusion
-- constraint of the registry of effective ranges). A layout is the formatting of Appendix I of Decree 30/2020 as data, so what makes it right is put into the database here, whatever the application checked first:
--   * the margins, the sizes of the letters, the place of the seal over the signature of the leader and the boxes of the signature and of the number fields (which have a size and lie on the A4 page) are inside
--     their legal ranges: a profile outside them cannot be written (422 LAYOUT_OUT_OF_LEGAL_RANGE in the application). The constraint is NOT VALID: it judges every row written from now on and does not refuse a database that holds a row of the earlier rules;
--   * the content of a revision (its values, its legal basis, its start date) never changes after it is written; it moves DRAFT to PUBLISHED once, with its approver; a published period is only ever shortened
--     (a successor takes over from a date); the confirmation of its legal basis is not written here (that step belongs to the confirmation of CXN-DOC-01);
--   * a profile is never deleted (a document that was rendered with it points at it).

CREATE FUNCTION machvon.layout_box_on_page(box jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT coalesce((box->>'widthMm')::numeric > 0 AND (box->>'heightMm')::numeric > 0 AND (box->>'xMm')::numeric >= 0 AND (box->>'yMm')::numeric >= 0
    AND (box->>'xMm')::numeric + (box->>'widthMm')::numeric <= 210 AND (box->>'yMm')::numeric + (box->>'heightMm')::numeric <= 297, false);
$fn$;

CREATE FUNCTION machvon.layout_within_legal_range(margins jsonb, styles jsonb, signature jsonb, numbers jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  leader_x numeric;
  leader_w numeric;
  leader_y numeric;
  leader_h numeric;
  seal_x numeric;
  seal_w numeric;
  seal_y numeric;
  seal_h numeric;
  covered numeric;
  high numeric;
BEGIN
  IF jsonb_typeof(margins) IS DISTINCT FROM 'object' OR jsonb_typeof(styles) IS DISTINCT FROM 'object' OR jsonb_typeof(signature) IS DISTINCT FROM 'object' OR jsonb_typeof(numbers) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF NOT (machvon.layout_box_on_page(signature->'leaderBox') AND machvon.layout_box_on_page(signature->'sealBox') AND machvon.layout_box_on_page(numbers->'number')
          AND machvon.layout_box_on_page(numbers->'symbol') AND machvon.layout_box_on_page(numbers->'date')) THEN
    RETURN false;
  END IF;
  -- A margin that is missing makes the comparison unknown, never right: the test is for "not true".
  IF (
        (margins->>'top')::numeric BETWEEN 20 AND 25
    AND (margins->>'bottom')::numeric BETWEEN 20 AND 25
    AND (margins->>'left')::numeric BETWEEN 30 AND 35
    AND (margins->>'right')::numeric BETWEEN 15 AND 20) IS NOT TRUE THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES ('nationalTitle', 12, 13), ('motto', 13, 14), ('agency', 12, 13), ('number', 13, 14), ('placeDate', 13, 14), ('docTypeName', 13, 14), ('summary', 13, 14), ('body', 13, 14),
                   ('signerTitle', 13, 14), ('signerName', 13, 14), ('recipientsLabel', 12, 12), ('recipientsList', 11, 11), ('pageNumber', 13, 14)) AS r(name, lo, hi)
     WHERE (styles->r.name->>'sizePt') IS NULL OR NOT ((styles->r.name->>'sizePt')::numeric BETWEEN r.lo AND r.hi)
  ) THEN
    RETURN false;
  END IF;
  leader_x := (signature->'leaderBox'->>'xMm')::numeric;
  leader_w := (signature->'leaderBox'->>'widthMm')::numeric;
  seal_x := (signature->'sealBox'->>'xMm')::numeric;
  seal_w := (signature->'sealBox'->>'widthMm')::numeric;
  leader_y := (signature->'leaderBox'->>'yMm')::numeric;
  leader_h := (signature->'leaderBox'->>'heightMm')::numeric;
  seal_y := (signature->'sealBox'->>'yMm')::numeric;
  seal_h := (signature->'sealBox'->>'heightMm')::numeric;
  IF leader_x IS NULL OR leader_w IS NULL OR seal_x IS NULL OR seal_w IS NULL OR leader_y IS NULL OR leader_h IS NULL OR seal_y IS NULL OR seal_h IS NULL
     OR leader_w <= 0 OR leader_h <= 0 OR seal_w <= 0 OR seal_h <= 0 OR seal_x >= leader_x THEN
    RETURN false;
  END IF;
  -- The seal is over the signature up and down as well: the boxes meet.
  high := LEAST(seal_y + seal_h, leader_y + leader_h) - GREATEST(seal_y, leader_y);
  IF high <= 0 THEN
    RETURN false;
  END IF;
  -- The seal covers a third of the width of the signature, give or take 0.03.
  covered := GREATEST(0, LEAST(seal_x + seal_w, leader_x + leader_w) - GREATEST(seal_x, leader_x));
  RETURN abs(covered / leader_w - 1.0 / 3.0) <= 0.03 + 0.000000001;
END;
$fn$;

ALTER TABLE machvon.document_layout_profile
  ADD CONSTRAINT document_layout_profile_legal_range_chk CHECK (machvon.layout_within_legal_range(margins_mm, element_styles, signature_layout, number_field_layout)) NOT VALID;

CREATE FUNCTION machvon.guard_document_layout_profile() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'layout profiles are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;

  -- The content of a revision is fixed when it is written.
  IF (to_jsonb(NEW) - ARRAY['status', 'effective_until', 'approved_by', 'updated_at', 'updated_by', 'version'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'effective_until', 'approved_by', 'updated_at', 'updated_by', 'version']) THEN
    RAISE EXCEPTION 'the content of a layout profile revision never changes (UPDATE on %.% by %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;

  IF NOT (OLD.status = NEW.status OR (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED') OR (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a layout profile cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;

  -- The approval is written once, by the move to PUBLISHED.
  IF OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED' THEN
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'publishing a layout profile names the approver' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'the approval of a layout profile is written once' USING ERRCODE = '42501';
  END IF;

  -- A published period is only ever shortened (a successor takes over from a date), never moved or widened.
  IF NEW.effective_until IS DISTINCT FROM OLD.effective_until THEN
    IF NOT (OLD.status = 'PUBLISHED' AND NEW.effective_until IS NOT NULL AND (OLD.effective_until IS NULL OR NEW.effective_until < OLD.effective_until)) THEN
      RAISE EXCEPTION 'the period of a layout profile can only be shortened while it is published' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_layout_profile_guard BEFORE UPDATE OR DELETE ON machvon.document_layout_profile
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_layout_profile();
CREATE TRIGGER document_layout_profile_no_truncate BEFORE TRUNCATE ON machvon.document_layout_profile
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_document_layout_profile();

REVOKE DELETE, TRUNCATE ON TABLE machvon.document_layout_profile FROM machvon_app;

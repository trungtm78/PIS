-- Authored by hand (not generated): recalling an issued document and voiding the number of a document that cannot be sealed (ST-DOC-012, DOC.md F9 and BR-DOC-03, BR-DOC-21).
-- V002 gave the states and the columns (`outgoing_document.recall_*`, `document_number_allocation.voided_*`, `document_relation` with the kind RECALLS) and V1221
-- and V1223 the guards of the rest of the life of a document. What recalling and voiding rest on is put into the database here, whatever the application checked first:
--   * a number is never given back: V016 already keeps the allocation log append-only (the only change is the approved void, ALLOCATED to VOIDED, with who voided
--     it, who approved and why; the check of V002 asks for all three), so voiding adds no guard of its own to the allocation;
--   * a recalled or a cancelled outgoing document is final, and so is the effect of a recalled document: it is never in force again (a new document replaces it);
--   * the recipients are told of a recall once: the instant the notice was issued for a distribution is written once and never rewritten;
--   * the relation of a document to the document that recalls it is kept for good (retention is permanent).

REVOKE DELETE, TRUNCATE ON TABLE machvon.document_relation FROM machvon_app;

CREATE FUNCTION machvon.guard_outgoing_document_final() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status IN ('RECALLED', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a recalled or cancelled outgoing document is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RECALLED' AND (NEW.recall_reason, NEW.recalled_at, NEW.recalled_by) IS DISTINCT FROM (OLD.recall_reason, OLD.recalled_at, OLD.recalled_by) THEN
    RAISE EXCEPTION 'the recall of an outgoing document is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'CANCELLED' AND NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
    RAISE EXCEPTION 'the reason a document was cancelled is not rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER outgoing_document_final_guard BEFORE UPDATE ON machvon.outgoing_document
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_outgoing_document_final();

CREATE FUNCTION machvon.guard_document_recalled() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.effect_status = 'RECALLED' AND NEW.effect_status IS DISTINCT FROM OLD.effect_status THEN
    RAISE EXCEPTION 'a recalled document is never in force again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_recalled_guard BEFORE UPDATE ON machvon.document
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_recalled();

ALTER TABLE machvon.document_distribution ADD COLUMN recall_notice_at timestamptz;

CREATE FUNCTION machvon.guard_distribution_recall_notice() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.recall_notice_at IS NOT NULL AND NEW.recall_notice_at IS DISTINCT FROM OLD.recall_notice_at THEN
    RAISE EXCEPTION 'the instant the recall notice was issued is written once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_distribution_recall_notice_guard BEFORE UPDATE ON machvon.document_distribution
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_distribution_recall_notice();

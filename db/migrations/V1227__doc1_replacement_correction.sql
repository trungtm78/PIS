-- Authored by hand (not generated): replacing and correcting an issued document (ST-DOC-015, DOC.md F9, BR-DOC-21).
-- V002 gave the states REPLACED and CORRECTED, the effects REPLACED and CORRECTED, and `document_relation` with the kinds REPLACES and CORRECTS, never related to itself and once for the same two
-- documents and the same kind; V1224 keeps the relations for good. What replacing and correcting rest on is put into the database here, whatever the application checked first:
--   * a relation is kept as it was written: the two documents and the kind never change;
--   * a replaced document is final: it is never in force again and does not move to another state (a new document takes its place), and so is the effect REPLACED.

CREATE FUNCTION machvon.guard_document_relation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.from_document_id, NEW.to_document_id, NEW.relation_kind, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.from_document_id, OLD.to_document_id, OLD.relation_kind, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a relation between documents is kept as it was written' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_relation_guard BEFORE UPDATE ON machvon.document_relation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_relation();

CREATE OR REPLACE FUNCTION machvon.guard_outgoing_document_final() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status IN ('RECALLED', 'CANCELLED', 'REPLACED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a recalled, cancelled or replaced outgoing document is final' USING ERRCODE = '23514';
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

CREATE OR REPLACE FUNCTION machvon.guard_document_recalled() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.effect_status IN ('RECALLED', 'REPLACED') AND NEW.effect_status IS DISTINCT FROM OLD.effect_status THEN
    RAISE EXCEPTION 'a recalled or replaced document is never in force again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- Authored by hand (not generated): a restriction of a contractor is a legal record (V1340). Its end may be brought forward by a decision, and
-- V1340 said so, but its guard only froze the other columns: the end could also be moved later or taken away, which lifts a debarment that has
-- ended or stretches one that has not by rewriting the record. The end can now be given to an open-ended restriction and moved earlier, nothing else.
CREATE OR REPLACE FUNCTION machvon.guard_contractor_restriction() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a restriction of a contractor is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contractor_id, NEW.kind, NEW.source, NEW.effective_from, NEW.decision_document_id, NEW.import_batch_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.contractor_id, OLD.kind, OLD.source, OLD.effective_from, OLD.decision_document_id, OLD.import_batch_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a restriction of a contractor is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF NEW.effective_until IS DISTINCT FROM OLD.effective_until
     AND (NEW.effective_until IS NULL OR (OLD.effective_until IS NOT NULL AND NEW.effective_until > OLD.effective_until)) THEN
    RAISE EXCEPTION 'the end of a restriction of a contractor can only be brought forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

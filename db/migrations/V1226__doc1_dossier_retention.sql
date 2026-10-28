-- ST-DOC-013 (DOC.md F11, BR-DOC-22, BR-DOC-23): dossiers with provisional retention. A dossier is closed once, and closing writes down the retention rule that applies, the class, the end of the retention and the day
-- by which the dossier is to be handed to the archive; those facts are not rewritten afterwards (a dossier that was closed while no rule was confirmed stays provisional until a command settles it).

ALTER TABLE machvon.dossier ADD COLUMN settlement_closed_on date;
ALTER TABLE machvon.dossier ADD COLUMN retention_ends_on date;
ALTER TABLE machvon.dossier ADD COLUMN closed_by uuid;
ALTER TABLE machvon.dossier ADD CONSTRAINT dossier_provisional_chk CHECK (NOT provisional_retention OR (retention_rule_id IS NULL AND retention_ends_on IS NULL));
ALTER TABLE machvon.dossier ADD CONSTRAINT dossier_closed_by_chk CHECK (status = 'OPEN' OR closed_by IS NOT NULL);

-- A dossier is never erased by the runtime role, and its documents are listed once and never taken out of it.
REVOKE DELETE, TRUNCATE ON TABLE machvon.dossier FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.dossier_item FROM machvon_app;

-- The retention rules of one rule set and category do not overlap in time while published (RETENTION_RANGE_OVERLAP): the end of a rule is the first day of the next.
ALTER TABLE machvon.doc_retention_rule ADD CONSTRAINT doc_retention_rule_overlap_ex
  EXCLUDE USING gist (tenant_id WITH =, rule_set WITH =, category_code WITH =, daterange(effective_from, effective_until, '[)') WITH &&) WHERE (status = 'PUBLISHED');

CREATE FUNCTION machvon.guard_dossier() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.dossier_code, NEW.year, NEW.organization_unit_id, NEW.category_code, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.dossier_code, OLD.year, OLD.organization_unit_id, OLD.category_code, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'the code, year, unit and category of a dossier are not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('OPEN', 'CLOSED'), ('CLOSED', 'HANDED_OVER'), ('CLOSED', 'DISPOSAL_PROPOSED'), ('HANDED_OVER', 'ARCHIVED'), ('HANDED_OVER', 'DISPOSAL_PROPOSED'),
                   ('ARCHIVED', 'DISPOSAL_PROPOSED'), ('DISPOSAL_PROPOSED', 'DISPOSED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'a dossier does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', DETAIL = 'DOSSIER_STATE_INVALID';
  END IF;
  -- What closing wrote down stays as it was; the one exception is a dossier that was provisional, which a later command may settle once.
  IF OLD.status <> 'OPEN' AND NOT OLD.provisional_retention
     AND (NEW.retention_rule_id, NEW.retention_class_code, NEW.provisional_retention, NEW.retention_ends_on, NEW.handover_due_on, NEW.closed_at, NEW.closed_by, NEW.settlement_closed_on)
         IS DISTINCT FROM (OLD.retention_rule_id, OLD.retention_class_code, OLD.provisional_retention, OLD.retention_ends_on, OLD.handover_due_on, OLD.closed_at, OLD.closed_by, OLD.settlement_closed_on) THEN
    RAISE EXCEPTION 'the retention written when a dossier was closed is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'OPEN' AND OLD.provisional_retention AND (NEW.closed_at, NEW.closed_by) IS DISTINCT FROM (OLD.closed_at, OLD.closed_by) THEN
    RAISE EXCEPTION 'the day a dossier was closed is not rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dossier_guard BEFORE UPDATE ON machvon.dossier
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_dossier();

-- Documents are added to an open dossier only.
CREATE FUNCTION machvon.guard_dossier_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status FROM machvon.dossier WHERE tenant_id = NEW.tenant_id AND id = NEW.dossier_id;
  IF current_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'documents are added to an open dossier only' USING ERRCODE = '23514', DETAIL = 'DOSSIER_NOT_OPEN';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dossier_item_guard BEFORE INSERT ON machvon.dossier_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_dossier_item();

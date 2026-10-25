-- Authored by hand (not generated): the handover of cleared land to a construction contract (ST-LND-009, LND 3.4, BR-LND-06).
-- The table land_handover_section comes from the generated schema (V002) and V1680; this adds the document the last handover rests on, ties the status of a section to what was
-- handed over, and keeps a handover as it was: the area handed over only grows, and the contract that received it does not change.

ALTER TABLE machvon.land_handover_section ADD COLUMN handover_document_version_id uuid;
ALTER TABLE machvon.land_handover_section ADD FOREIGN KEY (tenant_id, handover_document_version_id) REFERENCES machvon.document_version (tenant_id, id);
CREATE INDEX land_handover_section_handover_document_version_id_idx ON machvon.land_handover_section (tenant_id, handover_document_version_id);

-- Land is handed over on a day and on a document, or it is not handed over at all.
ALTER TABLE machvon.land_handover_section
  ADD CONSTRAINT land_section_handover_chk CHECK (
    (handed_area_m2 = 0) = (handed_over_on IS NULL) AND (handed_area_m2 = 0) = (handover_document_version_id IS NULL)
  );

-- Land is handed over to a contract: a section with no contract has nothing handed over.
ALTER TABLE machvon.land_handover_section ADD CONSTRAINT land_section_contract_chk CHECK (handed_area_m2 = 0 OR contract_id IS NOT NULL);

-- The status says what was handed over: nothing is NOT_READY, all of it is HANDED_OVER, anything between is PARTIAL.
ALTER TABLE machvon.land_handover_section
  ADD CONSTRAINT land_section_status_chk CHECK (
    status = CASE WHEN handed_area_m2 = 0 THEN 'NOT_READY' WHEN handed_area_m2 = required_area_m2 THEN 'HANDED_OVER' ELSE 'PARTIAL' END
  );

-- Once land is handed over the contract that took it stays, and the area handed over and the day of the last handover only grow (the command checks that the contract is active
-- and builds).
CREATE FUNCTION machvon.guard_land_section_handover() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.handed_area_m2 < OLD.handed_area_m2 THEN
    RAISE EXCEPTION 'the area handed over of a section never decreases' USING ERRCODE = '23514';
  END IF;
  IF OLD.handed_over_on IS NOT NULL AND NEW.handed_over_on < OLD.handed_over_on THEN
    RAISE EXCEPTION 'the day of the last handover of a section never moves back' USING ERRCODE = '23514';
  END IF;
  IF OLD.handed_area_m2 > 0 AND NEW.contract_id IS DISTINCT FROM OLD.contract_id THEN
    RAISE EXCEPTION 'the contract that received the land of a section does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER land_section_handover_guard BEFORE UPDATE ON machvon.land_handover_section
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_land_section_handover();

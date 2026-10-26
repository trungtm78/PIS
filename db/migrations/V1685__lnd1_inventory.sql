-- Authored by hand (not generated): the inventory of the assets of an affected household, counted at a price decision in force and confirmed by someone other than the person who counted (ST-LND-004, LND 3.2, BR-LND-04, UAT-AC382, UAT-PLAN-29).
-- The table land_inventory_record, the unit policy scope_units_guard and the check that a confirmed record carries the day the household confirmed are in V002. This adds the version of the price decision the
-- record was counted by, who confirmed it and when, the note of an objection, that the amount is the quantity times the price rounded half up to the dong, that the one who confirms is not the one
-- who counted, the words of the texts, the guard of the edges of the status (a record is judged once, and what it says does not change), and that the table is never deleted from.

ALTER TABLE machvon.land_inventory_record
  ADD COLUMN price_decision_version_id uuid,
  ADD COLUMN price_decision_revision integer,
  ADD COLUMN confirmed_by uuid,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN note text;

ALTER TABLE machvon.land_inventory_record
  -- BR-LND-04: the amount is the quantity times the unit price, rounded half up to the dong.
  ADD CONSTRAINT land_inventory_amount_chk CHECK (amount_vnd = round(quantity * unit_price_vnd)),
  ADD CONSTRAINT land_inventory_price_decision_chk CHECK ((price_decision_version_id IS NULL) = (price_decision_revision IS NULL) AND (price_decision_revision IS NULL OR price_decision_revision > 0)),
  -- A record that was judged says who judged it and when; one that was not has no judge. The household answered on a day that is not before the survey.
  ADD CONSTRAINT land_inventory_judged_chk CHECK (
    status = 'SUPERSEDED'
    OR (status = 'DRAFT' AND confirmed_by IS NULL AND confirmed_at IS NULL AND household_confirmed_on IS NULL)
    OR (status IN ('CONFIRMED', 'DISPUTED') AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND household_confirmed_on IS NOT NULL)
  ),
  ADD CONSTRAINT land_inventory_dispute_chk CHECK (status = 'SUPERSEDED' OR household_dispute = (status = 'DISPUTED')),
  ADD CONSTRAINT land_inventory_answer_chk CHECK (household_confirmed_on IS NULL OR household_confirmed_on >= surveyed_on),
  -- Whoever counted does not confirm.
  ADD CONSTRAINT land_inventory_independent_chk CHECK (confirmed_by IS NULL OR confirmed_by <> surveyed_by),
  ADD CONSTRAINT land_inventory_text_chk CHECK (
    description = btrim(description) AND description <> '' AND char_length(description) <= 2000
    AND unit_code = btrim(unit_code) AND unit_code <> '' AND char_length(unit_code) <= 50
    AND price_decision_ref = btrim(price_decision_ref) AND price_decision_ref <> '' AND char_length(price_decision_ref) <= 100
    AND (note IS NULL OR (note = btrim(note) AND note <> '' AND char_length(note) <= 2000))
  ),
  ADD CONSTRAINT land_inventory_surveyed_by_fk FOREIGN KEY (tenant_id, surveyed_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT land_inventory_confirmed_by_fk FOREIGN KEY (tenant_id, confirmed_by) REFERENCES machvon.membership (tenant_id, id);

COMMENT ON COLUMN machvon.land_inventory_record.description IS 'PERSONAL: what is counted at the household; it is not copied into the trail or the events.';

REVOKE DELETE, TRUNCATE ON TABLE machvon.land_inventory_record FROM machvon_app;

-- Every identifier column has an index that starts with the tenant: the version of the price decision of a record, and the unit of a request of the data subject that V1684 left out.
CREATE INDEX land_inventory_price_decision_idx ON machvon.land_inventory_record (tenant_id, price_decision_version_id);
CREATE INDEX household_data_request_unit_idx ON machvon.household_data_request (tenant_id, owner_unit_id);

CREATE FUNCTION machvon.guard_land_inventory_record() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  h_unit uuid;
  h_project uuid;
  p_unit uuid;
  p_project uuid;
  linked integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVENTORY_STATE_INVALID: a record is counted first' USING ERRCODE = '23514';
    END IF;
    -- The record belongs to the unit of its household and parcel, and the household holds a right on the parcel.
    SELECT h.owner_unit_id, h.project_id INTO h_unit, h_project FROM machvon.affected_household h WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.household_id;
    SELECT p.owner_unit_id, p.project_id INTO p_unit, p_project FROM machvon.land_parcel p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.parcel_id;
    IF h_unit IS NULL OR p_unit IS NULL OR h_unit <> NEW.owner_unit_id OR p_unit <> NEW.owner_unit_id OR h_project <> p_project THEN
      RAISE EXCEPTION 'a record is counted in the unit and the project of its household and its parcel' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO linked FROM machvon.household_parcel l WHERE l.tenant_id = NEW.tenant_id AND l.household_id = NEW.household_id AND l.parcel_id = NEW.parcel_id;
    IF linked = 0 THEN
      RAISE EXCEPTION 'HOUSEHOLD_PARCEL_NOT_LINKED: the household holds no right on the parcel' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.household_id, NEW.parcel_id, NEW.owner_unit_id, NEW.item_kind, NEW.description, NEW.quantity, NEW.unit_code, NEW.unit_price_vnd, NEW.amount_vnd,
      NEW.price_decision_ref, NEW.price_decision_version_id, NEW.price_decision_revision, NEW.surveyed_on, NEW.surveyed_by, NEW.evidence_photo_id, NEW.document_version_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.household_id, OLD.parcel_id, OLD.owner_unit_id, OLD.item_kind, OLD.description, OLD.quantity, OLD.unit_code, OLD.unit_price_vnd, OLD.amount_vnd,
      OLD.price_decision_ref, OLD.price_decision_version_id, OLD.price_decision_revision, OLD.surveyed_on, OLD.surveyed_by, OLD.evidence_photo_id, OLD.document_version_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an inventory record counts never changes' USING ERRCODE = '23514';
  END IF;
  -- A record is judged once: a confirmed one, an objected one and a replaced one say what they said.
  IF OLD.status <> 'DRAFT'
     AND (NEW.household_confirmed_on, NEW.household_dispute, NEW.confirmed_by, NEW.confirmed_at, NEW.note) IS DISTINCT FROM (OLD.household_confirmed_on, OLD.household_dispute, OLD.confirmed_by, OLD.confirmed_at, OLD.note) THEN
    RAISE EXCEPTION 'INVENTORY_STATE_INVALID: a record that was judged is not judged again' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('DRAFT', 'CONFIRMED'), ('DRAFT', 'DISPUTED'), ('DRAFT', 'SUPERSEDED'),
        ('DISPUTED', 'SUPERSEDED'), ('CONFIRMED', 'SUPERSEDED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'INVENTORY_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER land_inventory_record_guard BEFORE INSERT OR UPDATE ON machvon.land_inventory_record
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_land_inventory_record();

-- Authored by hand (not generated): the households affected by a land recovery, with their personal data sealed, masked and kept inside the unit that answers for them (ST-LND-002, LND 3.5, BR-LND-09, UAT-AC379, UAT-AC380).
-- The tables affected_household and household_parcel, the restrictive policy scope_units_guard (a row is seen only when app.scope_units is '*' or names its owner unit; no setting sees nothing), the consent check
-- and the unique indexes of the code and of the blind index of the identity number are in V002. This adds where the sealed name and address live (and the masked forms that are shown instead of them, so that
-- nothing readable of a person is left in a column that is not sealed), the checks that a sealed field is present when its masked form is, that the words are not empty, that the retention of the data does
-- not end before it begins, the guard of the edges of the status and of what a household is, that a link of a household to a parcel stays inside one unit and one project and never takes more than the whole
-- of the parcel, and that neither table is ever deleted from (erasing is anonymising, a command of its own).

ALTER TABLE machvon.affected_household
  ADD COLUMN head_name_enc bytea,
  ADD COLUMN address_enc bytea,
  ADD COLUMN national_id_masked text,
  ADD COLUMN phone_masked text;

COMMENT ON COLUMN machvon.affected_household.head_name IS 'PERSONAL: the masked form of the name of the head of the household (initials); the name itself is in head_name_enc.';
COMMENT ON COLUMN machvon.affected_household.address_text IS 'PERSONAL: the masked form of the address (only its last part); the address itself is in address_enc.';

ALTER TABLE machvon.affected_household
  ADD CONSTRAINT affected_household_sealed_chk CHECK (
    head_name_enc IS NOT NULL
    AND (national_id_enc IS NULL) = (national_id_hash IS NULL)
    AND (national_id_enc IS NULL) = (national_id_masked IS NULL)
    AND (phone_enc IS NULL) = (phone_masked IS NULL)
    AND (address_enc IS NULL) = (address_text IS NULL)
  ),
  ADD CONSTRAINT affected_household_text_chk CHECK (
    household_code = btrim(household_code) AND household_code <> '' AND char_length(household_code) <= 50
    AND head_name = btrim(head_name) AND head_name <> '' AND char_length(head_name) <= 2000
    AND legal_basis_ref = btrim(legal_basis_ref) AND legal_basis_ref <> '' AND char_length(legal_basis_ref) <= 2000
  ),
  -- The data is kept for a time that has not ended on the day it is registered.
  ADD CONSTRAINT affected_household_retention_chk CHECK (retention_until >= (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);

REVOKE DELETE, TRUNCATE ON TABLE machvon.affected_household FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.household_parcel FROM machvon_app;

CREATE FUNCTION machvon.guard_affected_household() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REGISTERED' OR NEW.dsr_open THEN
      RAISE EXCEPTION 'HOUSEHOLD_STATE_INVALID: a household is registered first' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.owner_unit_id, NEW.household_code, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.owner_unit_id, OLD.household_code, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a household is never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('REGISTERED', 'INVENTORIED'), ('INVENTORIED', 'PLAN_LISTED'), ('PLAN_LISTED', 'COMPENSATED'), ('COMPENSATED', 'RESETTLED'), ('COMPENSATED', 'CLOSED'), ('RESETTLED', 'CLOSED'),
        ('REGISTERED', 'DISPUTED'), ('INVENTORIED', 'DISPUTED'), ('PLAN_LISTED', 'DISPUTED'),
        ('DISPUTED', 'INVENTORIED'), ('DISPUTED', 'PLAN_LISTED'), ('DISPUTED', 'COMPENSATED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'HOUSEHOLD_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER affected_household_guard BEFORE INSERT OR UPDATE ON machvon.affected_household
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_affected_household();

-- A link stays in the unit and the project of the household and of the parcel, and the shares of a parcel never come to more than the whole of it. The households of a parcel are all of its own unit, so the
-- sum is read inside the same scope as the link.
CREATE FUNCTION machvon.guard_household_parcel() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  h_unit uuid;
  h_project uuid;
  p_unit uuid;
  p_project uuid;
  others numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.id, NEW.household_id, NEW.parcel_id, NEW.owner_unit_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.household_id, OLD.parcel_id, OLD.owner_unit_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a link of a household to a parcel is never changes' USING ERRCODE = '23514';
  END IF;
  SELECT h.owner_unit_id, h.project_id INTO h_unit, h_project FROM machvon.affected_household h WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.household_id;
  SELECT p.owner_unit_id, p.project_id INTO p_unit, p_project FROM machvon.land_parcel p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.parcel_id;
  IF h_unit IS NULL OR p_unit IS NULL OR h_unit <> NEW.owner_unit_id OR p_unit <> NEW.owner_unit_id OR h_project <> p_project THEN
    RAISE EXCEPTION 'a household is linked to a parcel of its own unit and its own project' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(l.share_pct), 0) INTO others FROM machvon.household_parcel l WHERE l.tenant_id = NEW.tenant_id AND l.parcel_id = NEW.parcel_id AND l.id <> NEW.id;
  IF others + NEW.share_pct > 100 THEN
    RAISE EXCEPTION 'SHARE_EXCEEDS_100: the shares of a parcel come to more than the whole of it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER household_parcel_guard BEFORE INSERT OR UPDATE ON machvon.household_parcel
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_household_parcel();

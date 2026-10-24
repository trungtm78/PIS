-- Authored by hand (not generated): the exemption of a permit (ST-PMT-003, PMT 4 and BR-PMT-04, CXN-EXE-02).
-- V002 gave `permit` the two columns of an exemption and the check `permit_exempt_chk` (a basis and a decision document), and V1181 holds the state machine
-- (PLANNED or SUBMITTED to EXEMPTED) and refuses to rewrite an exemption once it is written. What the application checks first and says why, and the database
-- holds last whatever the code does:
--   * The basis is a written text: trimmed and not empty (the check of V002 only asks for a value).
--   * Only a type that allows it can be exempted: the type version the permit was written under has `exemption_allowed`.
--   * The approver is not the proposer (maker and checker): whoever created the permit, and whoever last changed it, cannot be the one who declares the
--     exemption. The statement that moves a permit to EXEMPTED sets `updated_by` to the approver, so the trigger compares it with the creator and with the
--     person who last touched the row before.
-- The owner role (migrations, repairs) is not bound by the trigger, like the other guards of the module.

ALTER TABLE machvon.permit
  ADD CONSTRAINT permit_exempt_basis_chk CHECK (exemption_basis IS NULL OR (exemption_basis = btrim(exemption_basis) AND exemption_basis <> '' AND char_length(exemption_basis) <= 2000));

CREATE FUNCTION machvon.guard_permit_exemption() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'EXEMPTED' AND OLD.status IS DISTINCT FROM 'EXEMPTED' THEN
    IF NOT EXISTS (SELECT 1 FROM machvon.permit_type t WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.permit_type_id AND t.exemption_allowed) THEN
      RAISE EXCEPTION 'the permit type does not allow an exemption' USING ERRCODE = '23514';
    END IF;
    IF NEW.updated_by = OLD.created_by OR NEW.updated_by = OLD.updated_by THEN
      RAISE EXCEPTION 'the exemption of a permit is declared by someone other than the person who proposed it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_exemption_guard BEFORE UPDATE ON machvon.permit
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_permit_exemption();

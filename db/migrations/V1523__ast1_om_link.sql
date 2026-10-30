-- Authored by hand (not generated): the link of a transferred asset to the unit that operates and maintains it (ST-AST-005, AST 3.2, UAT-AC393).
-- The table om_link, its foreign keys to the asset, the unit, the plan document and the O&M contract, and its indexes are in V002. The unique index om_link_asset_uq (an asset has one link that is not suspended) is in V002. This adds the bounds of the cycle and the words of the reference to the other system, that a link says what it said (it only moves from linked to suspended), and that it is never deleted.

ALTER TABLE machvon.om_link
  ADD CONSTRAINT om_link_cycle_chk CHECK (maintenance_cycle_months IS NULL OR maintenance_cycle_months BETWEEN 1 AND 120),
  -- The code the asset has in the system of the operator is typed by hand, because no such system is connected: it is words, not a key.
  ADD CONSTRAINT om_link_reference_chk CHECK (external_system_ref IS NULL OR (external_system_ref = btrim(external_system_ref) AND external_system_ref <> '' AND char_length(external_system_ref) <= 2000));

CREATE FUNCTION machvon.guard_om_link() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.asset_id, NEW.operator_unit_id, NEW.om_plan_document_version_id, NEW.om_contract_id, NEW.maintenance_cycle_months, NEW.next_maintenance_due, NEW.external_system_ref, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.asset_id, OLD.operator_unit_id, OLD.om_plan_document_version_id, OLD.om_contract_id, OLD.maintenance_cycle_months, OLD.next_maintenance_due, OLD.external_system_ref, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an operation link says never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'LINKED' AND NEW.status = 'SUSPENDED') THEN
    RAISE EXCEPTION 'this move of the status of an operation link is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER om_link_guard BEFORE UPDATE ON machvon.om_link
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_om_link();

REVOKE DELETE, TRUNCATE ON machvon.om_link FROM machvon_app;

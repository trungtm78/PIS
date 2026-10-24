-- Authored by hand (not generated): the alias of a tenant on an entry of the platform (ST-MDM-002, MDM 3.1 F8, AC-MDM-08).
-- A tenant cannot change the code or the name of an entry of the PLATFORM namespace; the one thing it may set is how the entry is shown to it: a label and a
-- place in the order. That is a crosswalk row of the reserved system TENANT_ALIAS whose code type is LABEL or ORDER and whose code is the label or the order.
-- The crosswalk keeps one ACTIVE mapping per (system, code type, code); an alias is not a code of another system, so it must not share that rule (two entries
-- may carry the same label or the same order). It has its own: one ACTIVE alias of each kind per entry. The database also holds what the application checks:
-- the kind, the digits of an order, a hand-made row without a confidence, and an entry of the platform as the only target.

DROP INDEX machvon.master_crosswalk_active_uq;
CREATE UNIQUE INDEX master_crosswalk_active_uq ON machvon.master_crosswalk (tenant_id, source_system, external_type, external_code)
  WHERE status = 'ACTIVE' AND source_system <> 'TENANT_ALIAS';
CREATE UNIQUE INDEX master_crosswalk_alias_uq ON machvon.master_crosswalk (tenant_id, master_record_id, external_type)
  WHERE status = 'ACTIVE' AND source_system = 'TENANT_ALIAS';

ALTER TABLE machvon.master_crosswalk ADD CONSTRAINT master_crosswalk_alias_chk CHECK (
  source_system <> 'TENANT_ALIAS'
  OR (
    external_type IN ('LABEL', 'ORDER')
    AND match_method = 'MANUAL'
    AND confidence IS NULL
    AND (external_type <> 'ORDER' OR external_code ~ '^[0-9]{1,6}$')
  )
);

CREATE FUNCTION machvon.master_crosswalk_alias_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.source_system = 'TENANT_ALIAS' AND NOT EXISTS (
    SELECT 1 FROM machvon.master_record WHERE tenant_id = NEW.tenant_id AND id = NEW.master_record_id AND namespace = 'PLATFORM'
  ) THEN
    RAISE EXCEPTION 'an alias is set on an entry of the platform; an entry of the tenant is edited through its own change requests' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER master_crosswalk_alias_guard BEFORE INSERT ON machvon.master_crosswalk
  FOR EACH ROW EXECUTE FUNCTION machvon.master_crosswalk_alias_guard();

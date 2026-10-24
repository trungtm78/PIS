-- Authored by hand (not generated): usage events are the record a tenant is billed from, so they are insert-only (ST-SAS-010, SAS.md BR-SAS-15).
-- V002 gave the table, the unique key (tenant, meter, external_event_key) that makes a repeated event one event, and the check that a quantity is
-- never negative. What makes the record trustworthy is put into the database here, whatever the application did:
--   * an event is never changed and never deleted, also by the owner: a mistake is made good by a later event of the correction meter of
--     the meter it corrects (`<meter>_correction`), which takes away from the counter and is itself kept;
--   * the runtime role cannot rewrite or empty the table either (a delete that the trigger would refuse is refused before it starts).

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.usage_meter_event FROM machvon_app;

CREATE FUNCTION machvon.guard_usage_meter_event() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a usage event is insert-only: a mistake is made good by an event of the correction meter' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER usage_meter_event_insert_only BEFORE UPDATE OR DELETE ON machvon.usage_meter_event
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_usage_meter_event();

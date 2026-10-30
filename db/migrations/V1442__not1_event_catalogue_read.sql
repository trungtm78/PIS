-- Authored by hand (not generated), ST-NOT-004 (NOT 3.1, BR-NOT-15): the catalogue of the event types that may reach people (NOT-05).
-- notification_event_type is a table of the platform with no tenant: the application role has no right on it. A tenant administrator may see what is registered (the type, its module, the purposes it allows, how its
-- data is classified, whether it is still accepted) to write a workflow for it, so this function gives that and nothing else: the payload schema stays with the platform.
CREATE FUNCTION machvon.notification_event_catalogue()
RETURNS TABLE (event_type text, owning_module text, schema_version integer, allowed_purposes text[], data_classification text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT t.event_type, t.owning_module, t.schema_version, t.allowed_purposes, t.data_classification, t.status
    FROM machvon.notification_event_type t
   ORDER BY t.event_type, t.schema_version;
$fn$;
REVOKE ALL ON FUNCTION machvon.notification_event_catalogue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.notification_event_catalogue() TO machvon_app;

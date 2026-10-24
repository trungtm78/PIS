-- Authored by hand (not generated): what the control plane may read of a tenant's usage (ST-SAS-010, SAS.md section 2: the Billing Operator sees usage across tenants).
-- The counters and the events are tenant tables with row-level security: the control role reads them inside a transaction that names the tenant (app.tenant_id),
-- like the other tenant tables it reads (V008, V009); it writes none of them (the events are written by the tenant plane and are insert-only, V1481).
GRANT SELECT ON TABLE machvon.usage_counter, machvon.usage_meter_event TO machvon_control;

-- The seats a tenant uses, for the usage screen of both planes. The control role has no privilege on membership (a member is a person), and a count is
-- all the screen needs, so the count comes from this function, which reads membership with its owner's rights, returns two numbers and answers only for the tenant
-- the transaction is acting as (app.tenant_id): a caller cannot ask about another tenant. Service accounts take no seat and guests are counted apart (BR-SAS-09).
CREATE FUNCTION machvon.seats_in_use(p_tenant uuid)
RETURNS TABLE (staff bigint, guests bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT count(*) FILTER (WHERE m.membership_type = 'STAFF'),
           count(*) FILTER (WHERE m.membership_type = 'GUEST_CONTRACTOR')
    FROM machvon.membership m
    WHERE m.tenant_id = p_tenant AND m.status = 'Active';
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.seats_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.seats_in_use(uuid) TO machvon_control, machvon_app;

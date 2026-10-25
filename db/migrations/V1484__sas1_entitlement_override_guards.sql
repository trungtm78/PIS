-- Authored by hand (not generated): the entitlement overrides of a tenant (ST-SAS-009, SAS.md BR-SAS-10).
-- V002 gave `entitlement_override` with the window (valid_from < valid_until), the reason (10 characters at least) and the four-eyes rule that no one approves their
-- own request (approved_by <> requested_by). What an exception to a plan needs to stay controlled is put into the database here, whatever the application checked first:
--   * what was asked for never changes: the feature, whether it is on, the limit, the window, the reason and who asked are fixed when the request is made, and a
--     change of mind is a new request; a limit goes only with a feature that is on;
--   * a request moves only forward: waiting for approval it may be approved (ACTIVE), turned down, withdrawn or run out; in force it may be revoked or run out; every
--     other state is final. Approved and approver go together: an override is Active exactly when someone other than the requester approved it, and an override
--     that was approved keeps its approver whatever becomes of it afterwards;
--   * an override is never deleted: it is the record of who changed what a tenant may do, and why.

ALTER TABLE machvon.entitlement_override
  ADD CONSTRAINT entitlement_override_limit_ck CHECK (limit_value IS NULL OR (enabled AND limit_value >= 0)),
  ADD CONSTRAINT entitlement_override_approver_ck CHECK ((status = 'Active') <= (approved_by IS NOT NULL) AND (status NOT IN ('PendingApproval', 'Rejected') OR approved_by IS NULL));

REVOKE DELETE, TRUNCATE ON TABLE machvon.entitlement_override FROM machvon_app, machvon_control;

CREATE FUNCTION machvon.guard_entitlement_override() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an entitlement override is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.feature_code, NEW.enabled, NEW.limit_value, NEW.reason, NEW.valid_from, NEW.valid_until, NEW.requested_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.feature_code, OLD.enabled, OLD.limit_value, OLD.reason, OLD.valid_from, OLD.valid_until, OLD.requested_by) THEN
    RAISE EXCEPTION 'what an override asks for never changes: a change of mind is a new request' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PendingApproval' AND NEW.status IN ('Active', 'Rejected', 'Revoked', 'Expired'))
    OR (OLD.status = 'Active' AND NEW.status IN ('Revoked', 'Expired'))) THEN
    RAISE EXCEPTION 'an override moves forward only (% to %)', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'the approver of an override never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER entitlement_override_guard BEFORE UPDATE OR DELETE ON machvon.entitlement_override
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_entitlement_override();

-- The overrides that wait for a decision or are in force, found by the pass that lets them run out without reading every row.
CREATE INDEX entitlement_override_open_idx ON machvon.entitlement_override (tenant_id, valid_until) WHERE status IN ('PendingApproval', 'Active');

-- The control plane finds the tenant of an override by its id alone (the decision and the revocation name only the override), as it does for a license and a subscription.
CREATE FUNCTION machvon.override_tenant_of(p_override uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  one_tenant record;
  owner_id uuid;
BEGIN
  FOR one_tenant IN SELECT t.id FROM machvon.tenant t ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', one_tenant.id::text, true);
    IF EXISTS (SELECT 1 FROM machvon.entitlement_override o WHERE o.tenant_id = one_tenant.id AND o.id = p_override) THEN
      owner_id := one_tenant.id;
      EXIT;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  RETURN owner_id;
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.override_tenant_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.override_tenant_of(uuid) TO machvon_control;

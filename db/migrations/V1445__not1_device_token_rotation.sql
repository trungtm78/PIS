-- Authored by hand (not generated), ST-NOT-006 (NOT 3.7): a push token rotates (the provider hands the app a new one now and then), and registering the device again says so. IAM-1 (V1242) held the fingerprint of the
-- token as part of what a device is, so a live device could not take a new token; the fingerprint now changes with the token while the device is live. What a device is (who it belongs to, its public id, its platform)
-- is still never changed, and a revoked device still stays revoked with no reference to a token.
CREATE OR REPLACE FUNCTION machvon.guard_device_registration() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.membership_id, NEW.device_public_id, NEW.platform) IS DISTINCT FROM (OLD.membership_id, OLD.device_public_id, OLD.platform) THEN
    RAISE EXCEPTION 'what a device is is not changed' USING ERRCODE = '23514';
  END IF;
  -- A revoked device stays revoked: the row is the device, and it is revoked once; its token does not come back.
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.push_secret_ref IS NOT NULL OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason OR NEW.token_fingerprint IS DISTINCT FROM OLD.token_fingerprint) THEN
    RAISE EXCEPTION 'a revoked device stays revoked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

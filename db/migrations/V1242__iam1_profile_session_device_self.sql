-- ST-IAM-006 (IAM 3.4, BR-IAM-13): a person edits their own profile, signs out their other sessions and removes their devices.

-- ---- the profile ---------------------------------------------------------------------------------------------------------------------
-- user_account is a table of the control plane: the tenant plane has no privilege on it (V008). A person's profile is theirs in every tenant, so it is read and written through two narrow functions that name the
-- membership of the caller: the user is the one that membership belongs to, in the tenant of the caller's transaction, and nobody else's row can be reached through them.
CREATE FUNCTION machvon.my_profile(p_membership uuid)
RETURNS TABLE (user_id uuid, display_name text, email text, locale text, time_zone text, phone_e164 text, version bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
  SELECT u.id, u.display_name, u.email_normalized, u.locale, u.time_zone, u.phone_e164, u.version
    FROM machvon.membership m JOIN machvon.user_account u ON u.id = m.user_id
   WHERE m.id = p_membership AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
$fn$;

-- Changes the profile at the version read. A field that is NULL is left as it is (the phone only when p_set_phone). Returns whether it changed and the version the profile has now.
CREATE FUNCTION machvon.update_my_profile(p_membership uuid, p_expected bigint, p_display_name text, p_locale text, p_time_zone text, p_set_phone boolean, p_phone text)
RETURNS TABLE (was_updated boolean, new_version bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  v_user uuid;
  v_version bigint;
BEGIN
  SELECT m.user_id INTO v_user FROM machvon.membership m WHERE m.id = p_membership AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
  IF v_user IS NULL THEN
    RETURN;
  END IF;
  UPDATE machvon.user_account u
     SET display_name = coalesce(p_display_name, u.display_name),
         locale = coalesce(p_locale, u.locale),
         time_zone = coalesce(p_time_zone, u.time_zone),
         phone_e164 = CASE WHEN p_set_phone THEN p_phone ELSE u.phone_e164 END,
         version = u.version + 1,
         updated_at = now()
   WHERE u.id = v_user AND u.version = p_expected
   RETURNING u.version INTO v_version;
  IF FOUND THEN
    RETURN QUERY SELECT true, v_version;
  ELSE
    SELECT u.version INTO v_version FROM machvon.user_account u WHERE u.id = v_user;
    RETURN QUERY SELECT false, v_version;
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION machvon.my_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.update_my_profile(uuid, bigint, text, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.my_profile(uuid) TO machvon_app;
GRANT EXECUTE ON FUNCTION machvon.update_my_profile(uuid, bigint, text, text, text, boolean, text) TO machvon_app;

-- ---- the devices ---------------------------------------------------------------------------------------------------------------------
-- Removing a device revokes its row and takes the reference of its push token away (the row stays as history, never as a way to push; a device that signs in again is a new live row, one at most per device). The
-- reference is empty exactly when the device is revoked.
ALTER TABLE machvon.device_registration ALTER COLUMN push_secret_ref DROP NOT NULL;
CREATE INDEX device_registration_membership_idx ON machvon.device_registration (tenant_id, membership_id);
ALTER TABLE machvon.device_registration ADD CONSTRAINT device_registration_push_chk CHECK ((revoked_at IS NULL) = (push_secret_ref IS NOT NULL)) NOT VALID;

CREATE FUNCTION machvon.guard_device_registration() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.membership_id, NEW.device_public_id, NEW.platform, NEW.token_fingerprint) IS DISTINCT FROM (OLD.membership_id, OLD.device_public_id, OLD.platform, OLD.token_fingerprint) THEN
    RAISE EXCEPTION 'what a device is is not changed' USING ERRCODE = '23514';
  END IF;
  -- A revoked device stays revoked: the row is the device, and it is revoked once.
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.push_secret_ref IS NOT NULL OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'a revoked device stays revoked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER device_registration_guard BEFORE UPDATE ON machvon.device_registration
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_device_registration();

-- ---- the sessions --------------------------------------------------------------------------------------------------------------------
CREATE INDEX user_session_membership_idx ON machvon.user_session (tenant_id, membership_id, created_at DESC);
CREATE INDEX user_session_device_idx ON machvon.user_session (tenant_id, device_registration_id);

-- A session is revoked once: its time and its reason are never rewritten. (The retention job purges old technical rows, so the application role keeps the right to delete them.)
CREATE FUNCTION machvon.guard_user_session() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.user_account_id, NEW.membership_id, NEW.created_at) IS DISTINCT FROM (OLD.user_account_id, OLD.membership_id, OLD.created_at) THEN
    RAISE EXCEPTION 'whose a session is is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'a revoked session stays revoked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER user_session_guard BEFORE UPDATE ON machvon.user_session
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_user_session();

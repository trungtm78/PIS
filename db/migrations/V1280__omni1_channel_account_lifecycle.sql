-- Authored by hand (not generated), ST-OMNI-001 (OMNI 3.7, BR-OMNI-02, BR-OMNI-04): a channel account is connected, verified against the provider, changed and disabled. NOT-1 created the table for the delivery engine and
-- nothing wrote to it; this gives it the fields of the connection screens (the auto reply outside working hours, the calendar it follows, the last reason a verification failed, when verification was asked for) and
-- the rules of its life in the database as well as in the application: what an account is (tenant, channel, external id, the references of its secrets) is never changed, an account that is Disabled stays Disabled,
-- and the states are reached only along the ways of OMNI 4 (PendingVerification -> Active -> Disabled, Active -> CredentialExpired -> Active).
ALTER TABLE machvon.channel_account
  ADD COLUMN auto_reply_text text,
  ADD COLUMN calendar_code text,
  ADD COLUMN verify_requested_at timestamptz,
  ADD COLUMN verification_error text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid,
  ADD CONSTRAINT channel_account_auto_reply_chk CHECK (auto_reply_text IS NULL OR char_length(auto_reply_text) BETWEEN 1 AND 500),
  ADD CONSTRAINT channel_account_calendar_chk CHECK (calendar_code IS NULL OR calendar_code ~ '^[A-Za-z0-9._-]{1,60}$'),
  ADD CONSTRAINT channel_account_verification_error_chk CHECK (verification_error IS NULL OR verification_error ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  -- A verification is asked for an account that waits for one; the request is gone when the account is Active or Disabled.
  ADD CONSTRAINT channel_account_verify_request_chk CHECK (verify_requested_at IS NULL OR status IN ('PendingVerification', 'CredentialExpired'));

CREATE FUNCTION machvon.guard_channel_account() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.channel, NEW.external_account_id, NEW.credential_secret_ref, NEW.webhook_secret_ref, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.channel, OLD.external_account_id, OLD.credential_secret_ref, OLD.webhook_secret_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'what a channel account is is not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PendingVerification' AND NEW.status IN ('Active', 'Disabled'))
    OR (OLD.status = 'Active' AND NEW.status IN ('Disabled', 'CredentialExpired'))
    OR (OLD.status = 'CredentialExpired' AND NEW.status IN ('Active', 'Disabled'))) THEN
    RAISE EXCEPTION 'a channel account does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER channel_account_guard BEFORE UPDATE ON machvon.channel_account FOR EACH ROW EXECUTE FUNCTION machvon.guard_channel_account();


-- Authored by hand (not generated): the delivery engine of the notification module (ST-NOT-002, NOT 3.1 and 3.6, BR-NOT-03, BR-NOT-04, BR-NOT-06, BR-NOT-16).
-- V002 gave delivery_attempt its columns, attempt_no 1..5 and the unique (notification, channel, attempt_no) that stops a sixth send on a channel. This slice adds
-- what the engine needs to be provable from the database alone:
--   * delivery_attempt: the moments a send was taken up, failed and became uncertain; a status that only moves forward (BR-NOT-06) and a send that keeps its identity;
--   * notification_instance: the lineage of a replay that starts a new chain after a channel used its five sends, and the request to cancel a message in flight;
--   * channel_account_circuit: the circuit breaker of a channel account, shared by every process that sends (BR-NOT-16);
--   * the generic status history of KERNEL-1 learns the cause of a status that is the answer of the provider to a send (RESPONSE);
--   * a narrow function that finds the tenant of a channel account from its external id, so that a provider callback (which carries no session) reaches the right tenant.

ALTER TABLE machvon.delivery_attempt ADD COLUMN sending_at timestamptz;
ALTER TABLE machvon.delivery_attempt ADD COLUMN failed_at timestamptz;
ALTER TABLE machvon.delivery_attempt ADD COLUMN unknown_at timestamptz;

ALTER TABLE machvon.delivery_attempt
  ADD CONSTRAINT delivery_attempt_failed_chk CHECK (status <> 'Failed' OR (failure_class IN ('RETRYABLE', 'PERMANENT') AND failed_at IS NOT NULL)),
  ADD CONSTRAINT delivery_attempt_unknown_chk CHECK (status <> 'Unknown' OR (failure_class = 'UNKNOWN' AND unknown_at IS NOT NULL)),
  ADD CONSTRAINT delivery_attempt_error_code_chk CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,59}$');

CREATE INDEX delivery_attempt_claim_idx ON machvon.delivery_attempt (tenant_id, channel, next_retry_at, created_at, id) WHERE status = 'Queued';
CREATE INDEX delivery_attempt_page_idx ON machvon.delivery_attempt (tenant_id, created_at DESC, id DESC);
CREATE INDEX delivery_attempt_status_idx ON machvon.delivery_attempt (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX delivery_attempt_failures_idx ON machvon.delivery_attempt (tenant_id, channel_account_id, failed_at) WHERE failed_at IS NOT NULL;
CREATE INDEX delivery_attempt_stale_idx ON machvon.delivery_attempt (tenant_id, sending_at) WHERE status = 'Sending';
CREATE INDEX delivery_attempt_unknown_idx ON machvon.delivery_attempt (tenant_id, unknown_at) WHERE status = 'Unknown';

-- A send keeps its identity, and its status only moves forward: a send that was taken up is never queued again (a retry is a new attempt number),
-- and a failure reported late may only be overtaken by a delivery that is reported late (the message that reached the person wins).
CREATE FUNCTION machvon.guard_delivery_attempt_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
     OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.channel_account_id IS DISTINCT FROM OLD.channel_account_id
     OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a delivery attempt keeps its identity' USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'the provider message id of a delivery attempt is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'Queued' AND NEW.status IN ('Sending', 'Cancelled', 'Suppressed'))
    OR (OLD.status = 'Sending' AND NEW.status IN ('ProviderAccepted', 'Delivered', 'Read', 'Failed', 'Unknown'))
    OR (OLD.status = 'Unknown' AND NEW.status IN ('ProviderAccepted', 'Delivered', 'Read', 'Failed'))
    OR (OLD.status = 'ProviderAccepted' AND NEW.status IN ('Delivered', 'Read', 'Failed'))
    OR (OLD.status = 'Failed' AND NEW.status IN ('Delivered', 'Read'))
    OR (OLD.status = 'Delivered' AND NEW.status = 'Read')
  ) THEN
    RAISE EXCEPTION 'the status of a delivery attempt only moves forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER delivery_attempt_guard BEFORE UPDATE ON machvon.delivery_attempt
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_delivery_attempt_update();

-- The lineage of a replay. A channel is sent to at most five times per notification, so a replay after the fifth send starts a new notification
-- (dedupe key of "replay:<id>:<n>", NOT 3.6) that points back at the one it replays; the inbox of the person shows only the original.
ALTER TABLE machvon.notification_instance ADD COLUMN replay_of uuid;
ALTER TABLE machvon.notification_instance ADD COLUMN replay_seq integer;
ALTER TABLE machvon.notification_instance ADD COLUMN cancel_requested_at timestamptz;
ALTER TABLE machvon.notification_instance
  ADD CONSTRAINT notification_instance_replay_chk CHECK ((replay_of IS NULL) = (replay_seq IS NULL) AND (replay_seq IS NULL OR replay_seq >= 1)),
  ADD CONSTRAINT notification_instance_replay_fk FOREIGN KEY (tenant_id, replay_of) REFERENCES machvon.notification_instance (tenant_id, id);
CREATE UNIQUE INDEX notification_instance_replay_uq ON machvon.notification_instance (tenant_id, replay_of, replay_seq) WHERE replay_of IS NOT NULL;
CREATE INDEX notification_instance_status_idx ON machvon.notification_instance (tenant_id, status, created_at DESC, id DESC);

-- The circuit breaker of a channel account: closed, open after twenty failures in a minute, one probe after two minutes (half open).
CREATE TABLE machvon.channel_account_circuit (
  tenant_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'CLOSED',
  opened_at timestamptz,
  probe_started_at timestamptz,
  alerted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES machvon.channel_account (tenant_id, id),
  CONSTRAINT channel_account_circuit_state_chk CHECK (state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
  CONSTRAINT channel_account_circuit_open_chk CHECK ((state = 'CLOSED') = (opened_at IS NULL)),
  CONSTRAINT channel_account_circuit_probe_chk CHECK ((state = 'HALF_OPEN') = (probe_started_at IS NOT NULL))
);

ALTER TABLE machvon.channel_account_circuit ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.channel_account_circuit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.channel_account_circuit AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.channel_account_circuit AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.channel_account_circuit FROM machvon_app;

-- A status that is the answer of the provider to the request itself (accepted, refused) has no callback behind it: RESPONSE.
ALTER TABLE machvon.provider_status_history DROP CONSTRAINT provider_status_history_cause_chk;
ALTER TABLE machvon.provider_status_history
  ADD CONSTRAINT provider_status_history_cause_chk CHECK (cause IN ('CREATED', 'CALLBACK', 'UNCERTAIN', 'RECONCILED', 'RESPONSE'));

-- Cross-tenant lookup for receiveChannelWebhook: a provider callback carries no session and the tenant in its payload is never trusted, so the tenant is found
-- from the external account id of the receiving account. The table owner is subject to FORCE ROW LEVEL SECURITY too, so the function names each tenant in
-- app.tenant_id while it looks and then puts the caller's setting back. It returns ids only; the account is read again, with its status and secret
-- reference, inside the transaction of the tenant it names. Only the control role may run it. Only an account that is Active (verified) is an answer: the same
-- external id held by another tenant on an account that is still pending, disabled or expired must not make the receipt ambiguous and refuse it for the live one.
CREATE FUNCTION machvon.channel_accounts_by_external_id(p_external_account_id text)
RETURNS TABLE (tenant_id uuid, channel_account_id uuid, channel text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  one_tenant record;
BEGIN
  FOR one_tenant IN SELECT t.id FROM machvon.tenant t ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', one_tenant.id::text, true);
    RETURN QUERY
      SELECT a.tenant_id, a.id, a.channel
      FROM machvon.channel_account a
      WHERE a.tenant_id = one_tenant.id AND a.external_account_id = p_external_account_id AND a.status = 'Active'
      ORDER BY a.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.channel_accounts_by_external_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.channel_accounts_by_external_id(text) TO machvon_control;

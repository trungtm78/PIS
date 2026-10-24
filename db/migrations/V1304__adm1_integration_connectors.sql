-- Authored by hand (not generated): integration connectors with an honest adapter status, and the replay of the inbox (ST-ADM-018, ADM 3.13, BR-ADM-10).
-- V002 gave integration_connector its columns, the unique (tenant, connector_code) and the check that an Active connector has a VERIFIED or MOCK
-- adapter; it gave integration_event_inbox the unique (tenant, provider, event_key) that rejects a repeated delivery. This slice adds what the
-- management of both needs to be provable from the database alone:
--   * connectors: who made and last changed one, a configuration that is an object, a code and a mode that never change (another code or mode
--     is another connector), and no delete (a connector that existed is evidence of what was configured when an event came in);
--   * the inbox: a version that moves on every change by any writer (the replay is a versioned command), the number and the author of the last
--     replays, the fields that identify and prove an event kept for good, and indexes for the monitor.

ALTER TABLE machvon.integration_connector ADD COLUMN created_by uuid;
ALTER TABLE machvon.integration_connector ADD COLUMN updated_by uuid;
ALTER TABLE machvon.integration_connector ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE machvon.integration_connector ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE machvon.integration_connector
  ADD CONSTRAINT integration_connector_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$'),
  ADD CONSTRAINT integration_connector_config_chk CHECK (jsonb_typeof(config_json) = 'object'),
  ADD CONSTRAINT integration_connector_secret_ref_chk CHECK (credential_secret_ref IS NULL OR credential_secret_ref ~ '^secret://[a-z0-9][a-z0-9._/-]*$');

CREATE INDEX integration_connector_list_idx ON machvon.integration_connector (tenant_id, connector_code, id);

REVOKE DELETE, TRUNCATE ON TABLE machvon.integration_connector FROM machvon_app;

CREATE FUNCTION machvon.guard_integration_connector_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.connector_code IS DISTINCT FROM OLD.connector_code OR NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'a connector keeps its code and its mode' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER integration_connector_guard BEFORE UPDATE ON machvon.integration_connector
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_integration_connector_update();

ALTER TABLE machvon.integration_event_inbox ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE machvon.integration_event_inbox ADD COLUMN replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0);
ALTER TABLE machvon.integration_event_inbox ADD COLUMN last_replayed_at timestamptz;
ALTER TABLE machvon.integration_event_inbox ADD COLUMN last_replayed_by uuid;
ALTER TABLE machvon.integration_event_inbox ADD CONSTRAINT integration_event_inbox_replay_chk CHECK ((replay_count = 0) = (last_replayed_at IS NULL));

CREATE INDEX integration_event_inbox_list_idx ON machvon.integration_event_inbox (tenant_id, received_at DESC, id DESC);
CREATE INDEX integration_event_inbox_status_idx ON machvon.integration_event_inbox (tenant_id, status, received_at DESC, id DESC);

-- Every change of an event, by whichever writer (the callback store, the worker, the replay), moves its version: a person who saw an event as
-- FAILED and replays it after the worker has parked it as DEAD is told so (409 VERSION_CONFLICT) and not served with a stale view.
-- What identifies an event and what proves what arrived never changes; the reference of the payload may only be emptied, by the retention job.
CREATE FUNCTION machvon.guard_integration_inbox_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.event_key IS DISTINCT FROM OLD.event_key OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.signature_key_id IS DISTINCT FROM OLD.signature_key_id
     OR NEW.provider_event_type IS DISTINCT FROM OLD.provider_event_type OR NEW.channel_account_id IS DISTINCT FROM OLD.channel_account_id
     OR NEW.provider_timestamp IS DISTINCT FROM OLD.provider_timestamp THEN
    RAISE EXCEPTION 'an inbox event keeps what identifies it and what proves what arrived' USING ERRCODE = '23514';
  END IF;
  IF NEW.payload_reference IS DISTINCT FROM OLD.payload_reference AND NEW.payload_reference IS NOT NULL THEN
    RAISE EXCEPTION 'the payload of an inbox event is only ever emptied' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER integration_inbox_guard BEFORE UPDATE ON machvon.integration_event_inbox
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_integration_inbox_update();

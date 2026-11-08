-- Authored by hand (not generated): the connection `fin.sotaichinh` of a tenant, the feed of the Finance Department into this system (FEED-1, docs/finance-feed.md).
-- The entry of the connector registry (`integration_connector`, ADM) says what the connector is; this table says whether the tenant takes records now and what state its data generator is in:
--   * `finance_feed_connection`: one row per tenant. `enabled` says whether records are taken (a dry run is always allowed, it writes nothing); every change of it is a versioned command with a reason.
--     The generator (the deterministic producer of a province's records) has a state, an epoch that every reseed raises, and the parameters it runs with.
--   * `finance_feed_connection_event`: what was done to the connection and why, append-only (nothing is updated or deleted, for any role), so "who switched it off, who reseeded the generator and why" cannot be rewritten.

CREATE TABLE machvon.finance_feed_connection (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL DEFAULT 'fin.sotaichinh',
  enabled boolean NOT NULL DEFAULT true,
  layout_version text NOT NULL,
  state_reason text,
  state_changed_by uuid,
  state_changed_at timestamptz,
  generator_state text NOT NULL DEFAULT 'STOPPED',
  generator_epoch integer NOT NULL DEFAULT 0,
  generator_params jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT finance_feed_connection_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$'),
  CONSTRAINT finance_feed_connection_layout_chk CHECK (layout_version = btrim(layout_version) AND layout_version <> '' AND char_length(layout_version) <= 40),
  CONSTRAINT finance_feed_connection_reason_chk CHECK (state_reason IS NULL OR (state_reason = btrim(state_reason) AND char_length(state_reason) BETWEEN 10 AND 2000)),
  CONSTRAINT finance_feed_connection_changed_chk CHECK ((state_reason IS NULL) = (state_changed_by IS NULL) AND (state_changed_by IS NULL) = (state_changed_at IS NULL)),
  CONSTRAINT finance_feed_connection_generator_chk CHECK (generator_state IN ('STOPPED', 'RUNNING') AND generator_epoch >= 0 AND (generator_params IS NULL OR jsonb_typeof(generator_params) = 'object') AND (generator_state = 'STOPPED' OR generator_params IS NOT NULL)),
  CONSTRAINT finance_feed_connection_version_chk CHECK (version >= 1),
  CONSTRAINT finance_feed_connection_tenant_uq UNIQUE (tenant_id, connector_code)
);

CREATE TABLE machvon.finance_feed_connection_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  action text NOT NULL,
  reason text,
  detail jsonb,
  actor_id uuid NOT NULL,
  connection_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES machvon.finance_feed_connection (tenant_id, id),
  CONSTRAINT finance_feed_connection_event_action_chk CHECK (action IN ('CREATED', 'ENABLED', 'DISABLED', 'GENERATOR_STARTED', 'GENERATOR_STOPPED', 'GENERATOR_RESEEDED', 'GENERATOR_TICKED')),
  CONSTRAINT finance_feed_connection_event_reason_chk CHECK ((action = 'CREATED') = (reason IS NULL) AND (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000))),
  CONSTRAINT finance_feed_connection_event_version_chk CHECK (connection_version >= 1)
);
CREATE INDEX finance_feed_connection_event_idx ON machvon.finance_feed_connection_event (tenant_id, connection_id, occurred_at DESC, id DESC);
CREATE INDEX finance_feed_connection_event_actor_idx ON machvon.finance_feed_connection_event (tenant_id, actor_id, occurred_at DESC);

CREATE FUNCTION machvon.finance_feed_connection_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of the finance feed connection is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER finance_feed_connection_event_append_only BEFORE UPDATE OR DELETE ON machvon.finance_feed_connection_event FOR EACH ROW EXECUTE FUNCTION machvon.finance_feed_connection_event_append_only();

CREATE FUNCTION machvon.guard_finance_feed_connection() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.connector_code IS DISTINCT FROM OLD.connector_code OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a connection keeps its code and its origin' USING ERRCODE = '23514';
  END IF;
  IF NEW.enabled IS DISTINCT FROM OLD.enabled AND (NEW.state_reason IS NULL OR NEW.state_changed_by IS NULL OR NEW.state_changed_at IS NOT DISTINCT FROM OLD.state_changed_at OR NEW.version <> OLD.version + 1) THEN
    RAISE EXCEPTION 'a connection is switched on or off with a reason, a person, a new time of the decision and a new version' USING ERRCODE = '23514';
  END IF;
  IF NEW.generator_epoch < OLD.generator_epoch THEN
    RAISE EXCEPTION 'the epoch of the generator only goes up' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER finance_feed_connection_guard BEFORE UPDATE ON machvon.finance_feed_connection FOR EACH ROW EXECUTE FUNCTION machvon.guard_finance_feed_connection();

ALTER TABLE machvon.finance_feed_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.finance_feed_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.finance_feed_connection AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.finance_feed_connection AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.finance_feed_connection_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.finance_feed_connection_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.finance_feed_connection_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.finance_feed_connection_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.finance_feed_connection FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.finance_feed_connection_event FROM machvon_app;

COMMENT ON TABLE machvon.finance_feed_connection IS 'FEED-1: the connection fin.sotaichinh of a tenant: on or off with a reason, the layout version, and the state, epoch and parameters of the data generator.';
COMMENT ON TABLE machvon.finance_feed_connection_event IS 'FEED-1: what was done to the connection and the generator, and why; append-only.';

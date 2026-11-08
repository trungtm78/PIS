-- Authored by hand (not generated): the connection `egp.muasamcong` of a tenant (EGP-1 part 2, BID-22, docs/egp-connector.md sections 2 and 3).
-- The entry of the connector registry (`integration_connector`, ADM) says what the connector is (mode FILE_IMPORT, adapter PROPOSED, Draft); this table says whether the tenant uses it now and under which layout:
--   * `egp_connection`: one row per tenant. `enabled` says whether a file can be applied (a dry run is always allowed, it writes nothing); every change of it is a versioned command with a reason.
--     `layout_version` is the layout the tenant's files are read under; it can only be a version the module knows (the application checks, the CHECK keeps it a plain label).
--   * `egp_connection_event`: what was done to the connection and why, append-only (nothing is updated or deleted, for any role), so the history of "who switched it off and why" cannot be rewritten.

CREATE TABLE machvon.egp_connection (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL DEFAULT 'egp.muasamcong',
  enabled boolean NOT NULL DEFAULT true,
  layout_version text NOT NULL,
  state_reason text,
  state_changed_by uuid,
  state_changed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT egp_connection_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$'),
  CONSTRAINT egp_connection_layout_chk CHECK (layout_version = btrim(layout_version) AND layout_version <> '' AND char_length(layout_version) <= 40),
  CONSTRAINT egp_connection_reason_chk CHECK (state_reason IS NULL OR (state_reason = btrim(state_reason) AND char_length(state_reason) BETWEEN 10 AND 2000)),
  CONSTRAINT egp_connection_changed_chk CHECK ((state_reason IS NULL) = (state_changed_by IS NULL) AND (state_changed_by IS NULL) = (state_changed_at IS NULL)),
  CONSTRAINT egp_connection_version_chk CHECK (version >= 1),
  CONSTRAINT egp_connection_tenant_uq UNIQUE (tenant_id, connector_code)
);

CREATE TABLE machvon.egp_connection_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  action text NOT NULL,
  reason text,
  actor_id uuid NOT NULL,
  connection_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES machvon.egp_connection (tenant_id, id),
  CONSTRAINT egp_connection_event_action_chk CHECK (action IN ('CREATED', 'ENABLED', 'DISABLED')),
  CONSTRAINT egp_connection_event_reason_chk CHECK ((action = 'CREATED') = (reason IS NULL) AND (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000))),
  CONSTRAINT egp_connection_event_version_chk CHECK (connection_version >= 1)
);
CREATE INDEX egp_connection_event_idx ON machvon.egp_connection_event (tenant_id, connection_id, occurred_at DESC, id DESC);

CREATE FUNCTION machvon.egp_connection_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of the connection is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER egp_connection_event_append_only BEFORE UPDATE OR DELETE ON machvon.egp_connection_event FOR EACH ROW EXECUTE FUNCTION machvon.egp_connection_event_append_only();

CREATE FUNCTION machvon.guard_egp_connection() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.connector_code IS DISTINCT FROM OLD.connector_code OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a connection keeps its code and its origin' USING ERRCODE = '23514';
  END IF;
  IF NEW.enabled IS DISTINCT FROM OLD.enabled AND (NEW.state_reason IS NULL OR NEW.state_changed_by IS NULL OR NEW.state_changed_at IS NOT DISTINCT FROM OLD.state_changed_at OR NEW.version <> OLD.version + 1) THEN
    RAISE EXCEPTION 'a connection is switched on or off with a reason, a person, a new time of the decision and a new version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER egp_connection_guard BEFORE UPDATE ON machvon.egp_connection FOR EACH ROW EXECUTE FUNCTION machvon.guard_egp_connection();

ALTER TABLE machvon.egp_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.egp_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.egp_connection AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.egp_connection AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.egp_connection_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.egp_connection_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.egp_connection_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.egp_connection_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.egp_connection FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.egp_connection_event FROM machvon_app;

COMMENT ON TABLE machvon.egp_connection IS 'EGP-1: the connection egp.muasamcong of a tenant: on or off with a reason, and the layout version the files are read under.';
COMMENT ON TABLE machvon.egp_connection_event IS 'EGP-1: what was done to the connection and why; append-only.';

-- Authored by hand (not generated): the Integration Hub (HUB-1), part 2: incidents.
-- An incident is opened by the hub (a connector FAILING or STALE, the whole hub stale) or by a person (MANUAL), is acknowledged, and is resolved with a reason; a condition that cleared by itself closes it as AUTO_RESOLVED.
--   * `hub_incident`: the header with the state; one open incident per connector and kind (a partial unique index), so a failing connector is one incident, not one per sweep.
--   * `hub_incident_event`: every step, append-only, with the person (null for the hub itself) and the reason.

CREATE TABLE machvon.hub_incident (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text,
  kind text NOT NULL,
  severity text NOT NULL,
  state text NOT NULL DEFAULT 'OPEN',
  summary text,
  opened_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution text,
  source_run_id uuid,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_run_id) REFERENCES machvon.hub_run_log (tenant_id, id),
  CONSTRAINT hub_incident_code_chk CHECK (connector_code IS NULL OR connector_code ~ '^[a-z0-9_.-]{3,60}$'),
  CONSTRAINT hub_incident_kind_chk CHECK (kind IN ('FAILING', 'STALE', 'HUB_STALE', 'MANUAL')),
  CONSTRAINT hub_incident_scope_chk CHECK ((kind = 'HUB_STALE') = (connector_code IS NULL)),
  CONSTRAINT hub_incident_severity_chk CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  CONSTRAINT hub_incident_state_chk CHECK (state IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  CONSTRAINT hub_incident_summary_chk CHECK ((kind = 'MANUAL') = (summary IS NOT NULL) AND (summary IS NULL OR (summary = btrim(summary) AND char_length(summary) BETWEEN 10 AND 2000))),
  CONSTRAINT hub_incident_manual_opener_chk CHECK (kind <> 'MANUAL' OR opened_by IS NOT NULL),
  CONSTRAINT hub_incident_resolved_chk CHECK ((state = 'RESOLVED') = (resolved_at IS NOT NULL AND resolution IS NOT NULL) AND (resolution IS NULL OR (resolution = btrim(resolution) AND char_length(resolution) BETWEEN 4 AND 2000))),
  CONSTRAINT hub_incident_ack_chk CHECK (state <> 'ACKNOWLEDGED' OR acknowledged_at IS NOT NULL),
  CONSTRAINT hub_incident_version_chk CHECK (version >= 1)
);
CREATE UNIQUE INDEX hub_incident_open_uq ON machvon.hub_incident (tenant_id, coalesce(connector_code, '*'), kind) WHERE state <> 'RESOLVED' AND kind <> 'MANUAL';
CREATE INDEX hub_incident_list_idx ON machvon.hub_incident (tenant_id, state, opened_at DESC, id DESC);
CREATE INDEX hub_incident_connector_idx ON machvon.hub_incident (tenant_id, connector_code, opened_at DESC, id DESC);
CREATE INDEX hub_incident_run_idx ON machvon.hub_incident (tenant_id, source_run_id);

CREATE FUNCTION machvon.guard_hub_incident() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.connector_code IS DISTINCT FROM OLD.connector_code OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
     OR NEW.source_run_id IS DISTINCT FROM OLD.source_run_id OR NEW.summary IS DISTINCT FROM OLD.summary THEN
    RAISE EXCEPTION 'an incident keeps what identifies it' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved incident does not change' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state = 'OPEN' AND NEW.state IN ('ACKNOWLEDGED', 'RESOLVED')) OR (OLD.state = 'ACKNOWLEDGED' AND NEW.state = 'RESOLVED')) THEN
    RAISE EXCEPTION 'an incident moves from open to acknowledged to resolved' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every change of an incident moves its version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER hub_incident_guard BEFORE UPDATE ON machvon.hub_incident FOR EACH ROW EXECUTE FUNCTION machvon.guard_hub_incident();

CREATE TABLE machvon.hub_incident_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL,
  action text NOT NULL,
  actor_id uuid,
  reason text,
  incident_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES machvon.hub_incident (tenant_id, id),
  CONSTRAINT hub_incident_event_action_chk CHECK (action IN ('OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'AUTO_RESOLVED')),
  CONSTRAINT hub_incident_event_reason_chk CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000)),
  CONSTRAINT hub_incident_event_version_chk CHECK (incident_version >= 1)
);
CREATE INDEX hub_incident_event_idx ON machvon.hub_incident_event (tenant_id, incident_id, incident_version, occurred_at);
CREATE INDEX hub_incident_event_actor_idx ON machvon.hub_incident_event (tenant_id, actor_id, occurred_at DESC);

CREATE FUNCTION machvon.hub_incident_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of an incident is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER hub_incident_event_append_only BEFORE UPDATE OR DELETE ON machvon.hub_incident_event FOR EACH ROW EXECUTE FUNCTION machvon.hub_incident_event_append_only();
ALTER TABLE machvon.hub_incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_incident FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_incident AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_incident AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE machvon.hub_incident_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_incident_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_incident_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_incident_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.hub_incident FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.hub_incident_event FROM machvon_app;

COMMENT ON TABLE machvon.hub_incident IS 'HUB-1: an incident of a connector or of the whole hub; one open incident per connector and kind.';
COMMENT ON TABLE machvon.hub_incident_event IS 'HUB-1: every step of an incident; append-only.';

-- Authored by hand (not generated): the Integration Hub (HUB-1, docs/integration-hub.md), part 1: the switch of a connector that has none of its own, what was done to it, and the log of runs.
-- The hub never rewrites a connector table of another lane: an adapter reads them. These tables hold only what the hub itself owns:
--   * `hub_connector_state`: one row per tenant and connector for the connectors whose switch the hub owns (descriptor `ledger.stateOwner` HUB). On or off with a reason, a person, a time and a version.
--   * `hub_connector_event`: what was done to the switch and why, append-only (nothing is updated or deleted, for any role).
--   * `hub_run_log`: one row per run reported to the hub (a connector without a history of its own, a pipeline run, a run of a machine account): outcome, counts, the stable error code, the stage counts of a pipeline
--     run, the batch hash and the watermark before and after. Append-only. A run with a source reference is recorded once.

CREATE TABLE machvon.hub_connector_state (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  state_reason text,
  state_changed_by uuid,
  state_changed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hub_connector_state_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$'),
  CONSTRAINT hub_connector_state_reason_chk CHECK (state_reason IS NULL OR (state_reason = btrim(state_reason) AND char_length(state_reason) BETWEEN 10 AND 2000)),
  CONSTRAINT hub_connector_state_changed_chk CHECK ((state_reason IS NULL) = (state_changed_by IS NULL) AND (state_changed_by IS NULL) = (state_changed_at IS NULL)),
  CONSTRAINT hub_connector_state_version_chk CHECK (version >= 1),
  CONSTRAINT hub_connector_state_tenant_uq UNIQUE (tenant_id, connector_code)
);
CREATE INDEX hub_connector_state_actor_idx ON machvon.hub_connector_state (tenant_id, created_by);

CREATE FUNCTION machvon.guard_hub_connector_state() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.connector_code IS DISTINCT FROM OLD.connector_code OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a connector state keeps its code and its origin' USING ERRCODE = '23514';
  END IF;
  IF NEW.enabled IS DISTINCT FROM OLD.enabled AND (NEW.state_reason IS NULL OR NEW.state_changed_by IS NULL OR NEW.state_changed_at IS NOT DISTINCT FROM OLD.state_changed_at OR NEW.version <> OLD.version + 1) THEN
    RAISE EXCEPTION 'a connector is switched on or off with a reason, a person, a new time of the decision and a new version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER hub_connector_state_guard BEFORE UPDATE ON machvon.hub_connector_state FOR EACH ROW EXECUTE FUNCTION machvon.guard_hub_connector_state();

CREATE TABLE machvon.hub_connector_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  state_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hub_connector_event_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$'),
  CONSTRAINT hub_connector_event_action_chk CHECK (action IN ('ENABLED', 'DISABLED')),
  CONSTRAINT hub_connector_event_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000),
  CONSTRAINT hub_connector_event_version_chk CHECK (state_version >= 1)
);
CREATE INDEX hub_connector_event_idx ON machvon.hub_connector_event (tenant_id, connector_code, occurred_at DESC, id DESC);
CREATE INDEX hub_connector_event_actor_idx ON machvon.hub_connector_event (tenant_id, actor_id, occurred_at DESC);

CREATE FUNCTION machvon.hub_connector_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of a connector switch is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER hub_connector_event_append_only BEFORE UPDATE OR DELETE ON machvon.hub_connector_event FOR EACH ROW EXECUTE FUNCTION machvon.hub_connector_event_append_only();

CREATE TABLE machvon.hub_run_log (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  run_kind text NOT NULL,
  outcome text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  layout_code text,
  layout_version text,
  rows_total integer NOT NULL DEFAULT 0,
  rows_applied integer NOT NULL DEFAULT 0,
  rows_rejected integer NOT NULL DEFAULT 0,
  error_code text,
  source_ref text,
  pipeline_code text,
  dry_run boolean NOT NULL DEFAULT false,
  batch_sha256 char(64),
  watermark_before text,
  watermark_after text,
  stage_counts jsonb,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hub_run_log_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$'),
  CONSTRAINT hub_run_log_kind_chk CHECK (run_kind IN ('IMPORT', 'PULL', 'PUSH', 'GENERATE', 'READ', 'CHECK')),
  CONSTRAINT hub_run_log_outcome_chk CHECK (outcome IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'RUNNING', 'SKIPPED')),
  CONSTRAINT hub_run_log_finished_chk CHECK ((outcome = 'RUNNING') = (finished_at IS NULL) AND (finished_at IS NULL OR finished_at >= started_at)),
  CONSTRAINT hub_run_log_error_chk CHECK ((outcome = 'FAILED') = (error_code IS NOT NULL) AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,79}$')),
  CONSTRAINT hub_run_log_layout_chk CHECK ((layout_code IS NULL) = (layout_version IS NULL) AND (layout_version IS NULL OR (layout_version = btrim(layout_version) AND char_length(layout_version) BETWEEN 1 AND 40))),
  CONSTRAINT hub_run_log_counts_chk CHECK (rows_total >= 0 AND rows_applied >= 0 AND rows_rejected >= 0 AND rows_applied + rows_rejected <= rows_total),
  CONSTRAINT hub_run_log_ref_chk CHECK (source_ref IS NULL OR (outcome <> 'RUNNING' AND source_ref = btrim(source_ref) AND char_length(source_ref) BETWEEN 1 AND 120)),
  CONSTRAINT hub_run_log_pipeline_chk CHECK (pipeline_code IS NULL OR pipeline_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  CONSTRAINT hub_run_log_hash_chk CHECK (batch_sha256 IS NULL OR batch_sha256 ~ '^[0-9a-f]{64}$')
);
-- A run that names the thing it was about (a file hash, a batch id) is recorded once.
CREATE UNIQUE INDEX hub_run_log_ref_uq ON machvon.hub_run_log (tenant_id, connector_code, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX hub_run_log_connector_idx ON machvon.hub_run_log (tenant_id, connector_code, started_at DESC, id DESC);
CREATE INDEX hub_run_log_recent_idx ON machvon.hub_run_log (tenant_id, started_at DESC, id DESC);
CREATE INDEX hub_run_log_recorder_idx ON machvon.hub_run_log (tenant_id, recorded_by, recorded_at DESC);

CREATE FUNCTION machvon.hub_run_log_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the run log of the hub is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER hub_run_log_append_only BEFORE UPDATE OR DELETE ON machvon.hub_run_log FOR EACH ROW EXECUTE FUNCTION machvon.hub_run_log_append_only();

ALTER TABLE machvon.hub_connector_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_connector_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_connector_state AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_connector_state AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.hub_connector_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_connector_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_connector_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_connector_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.hub_run_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_run_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_run_log AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_run_log AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.hub_connector_state FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.hub_connector_event FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.hub_run_log FROM machvon_app;

COMMENT ON TABLE machvon.hub_connector_state IS 'HUB-1: the on/off switch of a connector whose switch the hub owns, with reason and version.';
COMMENT ON TABLE machvon.hub_connector_event IS 'HUB-1: what was done to a connector switch and why; append-only.';
COMMENT ON TABLE machvon.hub_run_log IS 'HUB-1: runs reported to the hub, with counts, stage counts, batch hash and watermark; append-only.';

-- Authored by hand (not generated): the Integration Hub (HUB-1), part 3: health snapshots for trends.
-- A sweep writes one row for each connector and one for the whole hub (connector_code is null) per hour; a repeated sweep inside the hour finds the one taken. Append-only: a trend is never rewritten.

CREATE TABLE machvon.hub_health_snapshot (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text,
  bucket timestamptz NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  status text,
  age_hours numeric(12, 1),
  failed_runs_7d integer NOT NULL DEFAULT 0,
  discrepancy_backlog integer NOT NULL DEFAULT 0,
  pending_mappings integer NOT NULL DEFAULT 0,
  summary jsonb,
  taken_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hub_health_snapshot_code_chk CHECK (connector_code IS NULL OR connector_code ~ '^[a-z0-9_.-]{3,60}$'),
  CONSTRAINT hub_health_snapshot_status_chk CHECK (status IS NULL OR status IN ('HEALTHY', 'STALE', 'FAILING', 'DISABLED', 'PENDING_EXTERNAL', 'NEVER_RUN')),
  CONSTRAINT hub_health_snapshot_scope_chk CHECK ((connector_code IS NULL) = (status IS NULL) AND (connector_code IS NULL) = (summary IS NOT NULL)),
  CONSTRAINT hub_health_snapshot_counts_chk CHECK (failed_runs_7d >= 0 AND discrepancy_backlog >= 0 AND pending_mappings >= 0 AND (age_hours IS NULL OR age_hours >= 0))
);
CREATE UNIQUE INDEX hub_health_snapshot_bucket_uq ON machvon.hub_health_snapshot (tenant_id, coalesce(connector_code, '*'), bucket);
CREATE INDEX hub_health_snapshot_trend_idx ON machvon.hub_health_snapshot (tenant_id, connector_code, bucket DESC);
CREATE INDEX hub_health_snapshot_taker_idx ON machvon.hub_health_snapshot (tenant_id, taken_by, taken_at DESC);

CREATE FUNCTION machvon.hub_health_snapshot_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a health snapshot is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER hub_health_snapshot_append_only BEFORE UPDATE OR DELETE ON machvon.hub_health_snapshot FOR EACH ROW EXECUTE FUNCTION machvon.hub_health_snapshot_append_only();
ALTER TABLE machvon.hub_health_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_health_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_health_snapshot AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_health_snapshot AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.hub_health_snapshot FROM machvon_app;

COMMENT ON TABLE machvon.hub_health_snapshot IS 'HUB-1: health of each connector and of the whole hub, one per hour; append-only, for trends.';

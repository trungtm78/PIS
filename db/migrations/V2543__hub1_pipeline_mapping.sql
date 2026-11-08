-- Authored by hand (not generated): the Integration Hub (HUB-1), part 4: the mapping versions and the watermarks of the ETL pipelines (docs/integration-hub.md, "ETL").
--   * `hub_pipeline_mapping`: the declarative field mapping of a pipeline, one row per version. PROPOSED by one person, APPROVED or REJECTED by ANOTHER (maker is not checker, by CHECK), then RETIRED when a later
--     version is approved. The fields are kept as they were approved: a run names the version it used, so the lineage can say how a value was made. One APPROVED version per pipeline.
--   * `hub_pipeline_watermark`: where the last successful load of a pipeline stopped. It moves only after a load (the application's rule); a version column makes a concurrent move a conflict.

CREATE TABLE machvon.hub_pipeline_mapping (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  pipeline_code text NOT NULL,
  mapping_version text NOT NULL,
  fields jsonb NOT NULL,
  state text NOT NULL DEFAULT 'PROPOSED',
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  retired_by uuid,
  retired_at timestamptz,
  retire_reason text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hub_pipeline_mapping_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$' AND pipeline_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  CONSTRAINT hub_pipeline_mapping_version_text_chk CHECK (mapping_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  CONSTRAINT hub_pipeline_mapping_fields_chk CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) BETWEEN 1 AND 200),
  CONSTRAINT hub_pipeline_mapping_state_chk CHECK (state IN ('PROPOSED', 'APPROVED', 'REJECTED', 'RETIRED')),
  CONSTRAINT hub_pipeline_mapping_decision_chk CHECK ((state = 'PROPOSED') = (decided_by IS NULL AND decided_at IS NULL) AND (state = 'PROPOSED' OR decision_reason IS NOT NULL)),
  CONSTRAINT hub_pipeline_mapping_checker_chk CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT hub_pipeline_mapping_retired_chk CHECK ((state = 'RETIRED') = (retired_by IS NOT NULL AND retired_at IS NOT NULL AND retire_reason IS NOT NULL) AND (retire_reason IS NULL OR (retire_reason = btrim(retire_reason) AND char_length(retire_reason) BETWEEN 4 AND 2000))),
  CONSTRAINT hub_pipeline_mapping_reason_chk CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 4 AND 2000)),
  CONSTRAINT hub_pipeline_mapping_row_version_chk CHECK (version >= 1),
  CONSTRAINT hub_pipeline_mapping_version_uq UNIQUE (tenant_id, connector_code, pipeline_code, mapping_version)
);
CREATE UNIQUE INDEX hub_pipeline_mapping_approved_uq ON machvon.hub_pipeline_mapping (tenant_id, connector_code, pipeline_code) WHERE state = 'APPROVED';
CREATE INDEX hub_pipeline_mapping_list_idx ON machvon.hub_pipeline_mapping (tenant_id, connector_code, pipeline_code, proposed_at DESC);
CREATE INDEX hub_pipeline_mapping_proposer_idx ON machvon.hub_pipeline_mapping (tenant_id, proposed_by);

CREATE FUNCTION machvon.guard_hub_pipeline_mapping() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.connector_code IS DISTINCT FROM OLD.connector_code OR NEW.pipeline_code IS DISTINCT FROM OLD.pipeline_code OR NEW.mapping_version IS DISTINCT FROM OLD.mapping_version
     OR NEW.fields IS DISTINCT FROM OLD.fields OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at THEN
    RAISE EXCEPTION 'a mapping version keeps its fields and its proposer' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'PROPOSED' AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
    RAISE EXCEPTION 'the decision on a mapping version is kept as it was made' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state = 'PROPOSED' AND NEW.state IN ('APPROVED', 'REJECTED')) OR (OLD.state = 'APPROVED' AND NEW.state = 'RETIRED')) THEN
    RAISE EXCEPTION 'a mapping moves from proposed to approved or rejected, and from approved to retired' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every change of a mapping moves its version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER hub_pipeline_mapping_guard BEFORE UPDATE ON machvon.hub_pipeline_mapping FOR EACH ROW EXECUTE FUNCTION machvon.guard_hub_pipeline_mapping();

CREATE TABLE machvon.hub_pipeline_watermark (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  pipeline_code text NOT NULL,
  watermark text,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hub_pipeline_watermark_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$' AND pipeline_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  CONSTRAINT hub_pipeline_watermark_value_chk CHECK (watermark IS NULL OR (watermark = btrim(watermark) AND char_length(watermark) BETWEEN 1 AND 300)),
  CONSTRAINT hub_pipeline_watermark_version_chk CHECK (version >= 1),
  CONSTRAINT hub_pipeline_watermark_uq UNIQUE (tenant_id, connector_code, pipeline_code)
);
CREATE INDEX hub_pipeline_watermark_actor_idx ON machvon.hub_pipeline_watermark (tenant_id, updated_by);

ALTER TABLE machvon.hub_pipeline_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_pipeline_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_pipeline_mapping AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_pipeline_mapping AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE machvon.hub_pipeline_watermark ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_pipeline_watermark FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_pipeline_watermark AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_pipeline_watermark AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.hub_pipeline_mapping FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.hub_pipeline_watermark FROM machvon_app;

COMMENT ON TABLE machvon.hub_pipeline_mapping IS 'HUB-1: versioned field mapping of an ETL pipeline; proposed by one person, decided by another.';
COMMENT ON TABLE machvon.hub_pipeline_watermark IS 'HUB-1: where the last successful load of a pipeline stopped.';

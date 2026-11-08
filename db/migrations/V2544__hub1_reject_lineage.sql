-- Authored by hand (not generated): the Integration Hub (HUB-1), part 5: the dead-letter list and the lineage of the ETL pipelines.
--   * `hub_pipeline_reject`: a record that failed VALIDATE, TRANSFORM or its own LOAD, kept with its stage, a stable code and the record as it arrived, so that a person can correct it and reprocess it. OPEN until it is
--     REPROCESSED (it passed) or DISCARDED (with a reason); a record is kept once per run.
--   * `hub_lineage`: source record -> target record, with the versions of the mapping and the layout and the hash of the batch; append-only, read by the lineage explorer.

CREATE TABLE machvon.hub_pipeline_reject (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  pipeline_code text NOT NULL,
  run_id uuid NOT NULL,
  stage text NOT NULL,
  reject_code text NOT NULL,
  field text,
  source_ref text NOT NULL,
  record_key text NOT NULL,
  line integer,
  record jsonb NOT NULL,
  state text NOT NULL DEFAULT 'OPEN',
  resolved_by uuid,
  resolved_at timestamptz,
  resolution text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES machvon.hub_run_log (tenant_id, id),
  CONSTRAINT hub_pipeline_reject_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$' AND pipeline_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  CONSTRAINT hub_pipeline_reject_stage_chk CHECK (stage IN ('VALIDATE', 'TRANSFORM', 'LOAD')),
  CONSTRAINT hub_pipeline_reject_reason_chk CHECK (reject_code ~ '^[A-Z][A-Z0-9_]{1,79}$' AND (field IS NULL OR char_length(field) BETWEEN 1 AND 80)),
  CONSTRAINT hub_pipeline_reject_ref_chk CHECK (char_length(source_ref) BETWEEN 1 AND 300 AND char_length(record_key) BETWEEN 1 AND 300 AND (line IS NULL OR line >= 1)),
  CONSTRAINT hub_pipeline_reject_record_chk CHECK (jsonb_typeof(record) = 'object'),
  CONSTRAINT hub_pipeline_reject_state_chk CHECK (state IN ('OPEN', 'REPROCESSED', 'DISCARDED')),
  CONSTRAINT hub_pipeline_reject_resolved_chk CHECK ((state = 'OPEN') = (resolved_by IS NULL AND resolved_at IS NULL AND resolution IS NULL) AND (resolution IS NULL OR char_length(resolution) BETWEEN 4 AND 2000)),
  CONSTRAINT hub_pipeline_reject_version_chk CHECK (version >= 1),
  CONSTRAINT hub_pipeline_reject_once_uq UNIQUE (tenant_id, run_id, source_ref)
);
CREATE INDEX hub_pipeline_reject_open_idx ON machvon.hub_pipeline_reject (tenant_id, connector_code, state, created_at DESC, id DESC);
CREATE INDEX hub_pipeline_reject_run_idx ON machvon.hub_pipeline_reject (tenant_id, run_id);
CREATE INDEX hub_pipeline_reject_resolver_idx ON machvon.hub_pipeline_reject (tenant_id, resolved_by);

CREATE FUNCTION machvon.guard_hub_pipeline_reject() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.connector_code IS DISTINCT FROM OLD.connector_code OR NEW.pipeline_code IS DISTINCT FROM OLD.pipeline_code OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.stage IS DISTINCT FROM OLD.stage OR NEW.reject_code IS DISTINCT FROM OLD.reject_code OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a reject keeps what identifies it' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'OPEN' THEN
    RAISE EXCEPTION 'a reject that was reprocessed or discarded does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every change of a reject moves its version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER hub_pipeline_reject_guard BEFORE UPDATE ON machvon.hub_pipeline_reject FOR EACH ROW EXECUTE FUNCTION machvon.guard_hub_pipeline_reject();

CREATE TABLE machvon.hub_lineage (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_code text NOT NULL,
  pipeline_code text NOT NULL,
  run_id uuid NOT NULL,
  source_ref text NOT NULL,
  record_key text NOT NULL,
  target_ref text,
  status text NOT NULL,
  mapping_version text NOT NULL,
  layout_version text NOT NULL,
  batch_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES machvon.hub_run_log (tenant_id, id),
  CONSTRAINT hub_lineage_code_chk CHECK (connector_code ~ '^[a-z0-9_.-]{3,60}$' AND pipeline_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  CONSTRAINT hub_lineage_status_chk CHECK (status IN ('APPLIED', 'DUPLICATE')),
  CONSTRAINT hub_lineage_text_chk CHECK (char_length(source_ref) BETWEEN 1 AND 300 AND char_length(record_key) BETWEEN 1 AND 300 AND (target_ref IS NULL OR char_length(target_ref) BETWEEN 1 AND 300)),
  CONSTRAINT hub_lineage_hash_chk CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hub_lineage_once_uq UNIQUE (tenant_id, run_id, source_ref)
);
CREATE INDEX hub_lineage_source_idx ON machvon.hub_lineage (tenant_id, connector_code, source_ref);
CREATE INDEX hub_lineage_target_idx ON machvon.hub_lineage (tenant_id, target_ref) WHERE target_ref IS NOT NULL;
CREATE INDEX hub_lineage_run_idx ON machvon.hub_lineage (tenant_id, run_id);

CREATE FUNCTION machvon.hub_lineage_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the lineage of the hub is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER hub_lineage_append_only BEFORE UPDATE OR DELETE ON machvon.hub_lineage FOR EACH ROW EXECUTE FUNCTION machvon.hub_lineage_append_only();
ALTER TABLE machvon.hub_pipeline_reject ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_pipeline_reject FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_pipeline_reject AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_pipeline_reject AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE machvon.hub_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_lineage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_lineage AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_lineage AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.hub_pipeline_reject FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.hub_lineage FROM machvon_app;

COMMENT ON TABLE machvon.hub_pipeline_reject IS 'HUB-1: the dead-letter list of the ETL pipelines: a record, its stage and reason, until it is reprocessed or discarded.';
COMMENT ON TABLE machvon.hub_lineage IS 'HUB-1: source record to target record with the mapping and layout versions; append-only.';

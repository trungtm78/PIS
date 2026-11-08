-- Authored by hand (not generated): the runs of the feed and the records they bring (FEED-1, docs/finance-feed.md).
-- A record is one statement of the Finance Department about a project, a plan of a year, a month of disbursement or a milestone, true on a day (`as_of`). The record store is the one thing every consumer reads (through the
-- reader), whatever the channel it came in by: FILE (a file a person handed over, through the file import framework), API_PUSH (the Finance application, with a machine account) or GENERATOR (the deterministic producer
-- of a province's records). The channel and the run are internal provenance for audit and replay; they carry no warning of any kind.
--   * `finance_feed_run`: one row per applied run of any channel (a file, a push, a generator start, reseed or tick), append-only, with counts, the digest of its records and who ran it. A file is applied once per
--     (tenant, kind, SHA-256): the same file again is refused by the unique index.
--   * `finance_feed_record`: one row per (tenant, channel, epoch, kind, business key), the business key being the key of the thing and the day it was true, so a later statement of the same thing is a new row and the
--     earlier stays. Append-only for every role. The generator's records carry the epoch of the connection when they were written; a reseed raises it and the reader takes only the current epoch of the generator.

CREATE TABLE machvon.finance_feed_run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  kind text,
  layout_version text NOT NULL,
  file_sha256 char(64),
  file_import_id uuid,
  seed bigint,
  epoch integer NOT NULL DEFAULT 0,
  parameters jsonb,
  action text NOT NULL DEFAULT 'APPLY',
  records_total integer NOT NULL,
  records_written integer NOT NULL,
  records_skipped integer NOT NULL DEFAULT 0,
  rows_rejected integer NOT NULL DEFAULT 0,
  as_of_latest date,
  digest char(64),
  imported_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, file_import_id) REFERENCES machvon.file_import (tenant_id, id),
  CONSTRAINT finance_feed_run_channel_chk CHECK (channel IN ('FILE', 'API_PUSH', 'GENERATOR')),
  CONSTRAINT finance_feed_run_kind_chk CHECK (kind IS NULL OR kind IN ('PROJECT', 'PLAN', 'DISBURSEMENT', 'MILESTONE')),
  CONSTRAINT finance_feed_run_action_chk CHECK (action IN ('APPLY', 'GENERATOR_START', 'GENERATOR_RESEED', 'GENERATOR_TICK')),
  CONSTRAINT finance_feed_run_layout_chk CHECK (layout_version = btrim(layout_version) AND layout_version <> '' AND char_length(layout_version) <= 40),
  CONSTRAINT finance_feed_run_counts_chk CHECK (records_total >= 0 AND records_written >= 0 AND records_skipped >= 0 AND rows_rejected >= 0 AND records_written + records_skipped <= records_total),
  CONSTRAINT finance_feed_run_hash_chk CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT finance_feed_run_digest_chk CHECK (digest IS NULL OR digest ~ '^[0-9a-f]{64}$'),
  -- A file run names its file and kind; a generator run names its seed; a push names its kind.
  CONSTRAINT finance_feed_run_shape_chk CHECK (
    (channel = 'FILE' AND kind IS NOT NULL AND file_sha256 IS NOT NULL AND file_import_id IS NOT NULL AND seed IS NULL AND action = 'APPLY')
    OR (channel = 'API_PUSH' AND kind IS NOT NULL AND file_sha256 IS NULL AND seed IS NULL AND action = 'APPLY')
    OR (channel = 'GENERATOR' AND seed IS NOT NULL AND file_sha256 IS NULL AND action <> 'APPLY')
  )
);
CREATE UNIQUE INDEX finance_feed_run_file_uq ON machvon.finance_feed_run (tenant_id, kind, file_sha256) WHERE channel = 'FILE';
CREATE INDEX finance_feed_run_list_idx ON machvon.finance_feed_run (tenant_id, created_at DESC, id DESC);
CREATE INDEX finance_feed_run_import_idx ON machvon.finance_feed_run (tenant_id, file_import_id) WHERE file_import_id IS NOT NULL;
CREATE INDEX finance_feed_run_actor_idx ON machvon.finance_feed_run (tenant_id, imported_by, created_at DESC);

CREATE TABLE machvon.finance_feed_record (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  epoch integer NOT NULL DEFAULT 0,
  run_id uuid,
  import_id uuid,
  kind text NOT NULL,
  entity_key text NOT NULL,
  business_key text NOT NULL,
  as_of date NOT NULL,
  feed_project_code text NOT NULL,
  fiscal_year integer,
  month integer,
  fund_code text,
  layout_version text NOT NULL,
  row_hash char(64) NOT NULL,
  record jsonb NOT NULL,
  applied_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES machvon.finance_feed_run (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id),
  CONSTRAINT finance_feed_record_channel_chk CHECK (channel IN ('FILE', 'API_PUSH', 'GENERATOR') AND (channel = 'GENERATOR' OR epoch = 0) AND epoch >= 0),
  CONSTRAINT finance_feed_record_origin_chk CHECK ((run_id IS NULL) <> (import_id IS NULL) AND (import_id IS NULL OR channel = 'FILE')),
  CONSTRAINT finance_feed_record_kind_chk CHECK (kind IN ('PROJECT', 'PLAN', 'DISBURSEMENT', 'MILESTONE')),
  CONSTRAINT finance_feed_record_key_chk CHECK (entity_key = btrim(entity_key) AND entity_key <> '' AND char_length(entity_key) <= 300 AND business_key = btrim(business_key) AND business_key <> '' AND char_length(business_key) <= 320),
  CONSTRAINT finance_feed_record_code_chk CHECK (feed_project_code = btrim(feed_project_code) AND feed_project_code <> '' AND char_length(feed_project_code) <= 50),
  CONSTRAINT finance_feed_record_period_chk CHECK ((fiscal_year IS NULL OR fiscal_year BETWEEN 2000 AND 2100) AND (month IS NULL OR month BETWEEN 1 AND 12) AND (kind <> 'DISBURSEMENT' OR (fiscal_year IS NOT NULL AND month IS NOT NULL AND fund_code IS NOT NULL)) AND (kind <> 'PLAN' OR (fiscal_year IS NOT NULL AND fund_code IS NOT NULL))),
  CONSTRAINT finance_feed_record_layout_chk CHECK (layout_version = btrim(layout_version) AND layout_version <> '' AND char_length(layout_version) <= 40),
  CONSTRAINT finance_feed_record_hash_chk CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT finance_feed_record_shape_chk CHECK (jsonb_typeof(record) = 'object'),
  CONSTRAINT finance_feed_record_key_uq UNIQUE (tenant_id, channel, epoch, kind, business_key)
);
CREATE INDEX finance_feed_record_entity_idx ON machvon.finance_feed_record (tenant_id, channel, epoch, kind, entity_key, as_of DESC);
CREATE INDEX finance_feed_record_project_idx ON machvon.finance_feed_record (tenant_id, feed_project_code, kind);
CREATE INDEX finance_feed_record_year_idx ON machvon.finance_feed_record (tenant_id, fiscal_year, kind, month);
CREATE INDEX finance_feed_record_run_idx ON machvon.finance_feed_record (tenant_id, run_id) WHERE run_id IS NOT NULL;
CREATE INDEX finance_feed_record_import_idx ON machvon.finance_feed_record (tenant_id, import_id, as_of) WHERE import_id IS NOT NULL;

CREATE FUNCTION machvon.finance_feed_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'what the finance feed said is append-only: a later statement is a new row' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER finance_feed_run_append_only BEFORE UPDATE OR DELETE ON machvon.finance_feed_run FOR EACH ROW EXECUTE FUNCTION machvon.finance_feed_append_only();
CREATE TRIGGER finance_feed_record_append_only BEFORE UPDATE OR DELETE ON machvon.finance_feed_record FOR EACH ROW EXECUTE FUNCTION machvon.finance_feed_append_only();

ALTER TABLE machvon.finance_feed_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.finance_feed_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.finance_feed_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.finance_feed_run AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.finance_feed_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.finance_feed_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.finance_feed_record AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.finance_feed_record AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.finance_feed_run FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.finance_feed_record FROM machvon_app;

COMMENT ON TABLE machvon.finance_feed_run IS 'FEED-1: one applied run of the feed (a file, a push, a generator start, reseed or tick); append-only.';
COMMENT ON TABLE machvon.finance_feed_record IS 'FEED-1: one statement of the Finance Department true on a day, with its channel (internal provenance), epoch and run; append-only.';

-- Authored by hand (not generated): caps on the number and the size of the log classes of a tenant (HT.06, ENT-4e). Four tables:
--   * `log_capacity_policy`: per record class, at most `max_rows` rows and at most `max_bytes` bytes (either may be absent, not both), whether the cap is in force, `active` (a cap is lifted by switching it off, never deleted), the share `warn_pct` at which
--     the alert LOG_CAPACITY_NEAR is raised; a versioned command with a reason (history in `log_capacity_policy_event`, append-only).
--     The classes are the TECHNICAL classes of retention (they can be archived then purged, never a row younger than the platform minimum period) and the MONITOR-ONLY
--     classes `audit_event` and `audit_event_detail` (measured and alerted, never removed: the business audit evidence is not deleted by a job).
--   * `log_capacity_reading`: the last measure of each class (rows, bytes, the rows a cap may remove, the rows the platform period protects), one row per class.
--   * `log_archive_batch`: the file that holds the rows archived before they were purged (hash, counts, time span); a batch is ARCHIVED first and PURGED only once
--     the rows are gone, so a crash between the two steps leaves the rows and the file, never a purge without a file.

CREATE TABLE machvon.log_capacity_policy (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  record_class text NOT NULL,
  max_rows bigint,
  max_bytes bigint,
  warn_pct integer NOT NULL DEFAULT 80,
  active boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT log_capacity_policy_class_chk CHECK (record_class IN ('idempotency_record', 'outbox_event', 'integration_event_inbox', 'user_session', 'delivery_attempt', 'audit_event', 'audit_event_detail')),
  CONSTRAINT log_capacity_policy_limit_chk CHECK (max_rows IS NOT NULL OR max_bytes IS NOT NULL),
  CONSTRAINT log_capacity_policy_rows_chk CHECK (max_rows IS NULL OR max_rows BETWEEN 1 AND 1000000000),
  CONSTRAINT log_capacity_policy_bytes_chk CHECK (max_bytes IS NULL OR max_bytes BETWEEN 1048576 AND 1000000000000),
  CONSTRAINT log_capacity_policy_warn_chk CHECK (warn_pct BETWEEN 50 AND 99),
  CONSTRAINT log_capacity_policy_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 2000),
  CONSTRAINT log_capacity_policy_version_chk CHECK (version >= 1),
  CONSTRAINT log_capacity_policy_class_uq UNIQUE (tenant_id, record_class)
);

CREATE TABLE machvon.log_capacity_policy_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  policy_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES machvon.log_capacity_policy (tenant_id, id),
  CONSTRAINT log_capacity_policy_event_action_chk CHECK (action IN ('CREATED', 'CHANGED', 'REMOVED')),
  CONSTRAINT log_capacity_policy_event_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 2000)
);
CREATE INDEX log_capacity_policy_event_idx ON machvon.log_capacity_policy_event (tenant_id, policy_id, occurred_at DESC, id DESC);
CREATE INDEX log_capacity_policy_event_actor_idx ON machvon.log_capacity_policy_event (tenant_id, actor_id, occurred_at DESC);

CREATE TABLE machvon.log_capacity_reading (
  tenant_id uuid NOT NULL,
  record_class text NOT NULL,
  row_count bigint NOT NULL,
  byte_count bigint NOT NULL,
  bytes_estimated boolean NOT NULL DEFAULT false,
  eligible_rows bigint NOT NULL,
  protected_rows bigint NOT NULL,
  state text NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_class),
  CONSTRAINT log_capacity_reading_class_chk CHECK (record_class IN ('idempotency_record', 'outbox_event', 'integration_event_inbox', 'user_session', 'delivery_attempt', 'audit_event', 'audit_event_detail')),
  CONSTRAINT log_capacity_reading_state_chk CHECK (state IN ('UNCAPPED', 'OK', 'NEAR', 'OVER')),
  CONSTRAINT log_capacity_reading_counts_chk CHECK (row_count >= 0 AND byte_count >= 0 AND eligible_rows >= 0 AND protected_rows >= 0)
);

CREATE TABLE machvon.log_archive_batch (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  record_class text NOT NULL,
  status text NOT NULL DEFAULT 'ARCHIVED',
  row_count bigint NOT NULL,
  byte_count bigint NOT NULL,
  oldest_at timestamptz,
  newest_at timestamptz,
  file_key text NOT NULL,
  file_sha256 text NOT NULL,
  cap_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz,
  purged_rows bigint,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT log_archive_batch_class_chk CHECK (record_class IN ('idempotency_record', 'outbox_event', 'integration_event_inbox', 'user_session', 'delivery_attempt')),
  CONSTRAINT log_archive_batch_status_chk CHECK (status IN ('ARCHIVED', 'PURGED')),
  CONSTRAINT log_archive_batch_hash_chk CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT log_archive_batch_counts_chk CHECK (row_count > 0 AND byte_count >= 0),
  CONSTRAINT log_archive_batch_purged_chk CHECK ((status = 'PURGED') = (purged_at IS NOT NULL AND purged_rows IS NOT NULL))
);
CREATE INDEX log_archive_batch_class_idx ON machvon.log_archive_batch (tenant_id, record_class, created_at DESC, id DESC);

CREATE FUNCTION machvon.log_capacity_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of the log caps is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER log_capacity_policy_event_append_only BEFORE UPDATE OR DELETE ON machvon.log_capacity_policy_event FOR EACH ROW EXECUTE FUNCTION machvon.log_capacity_append_only();

CREATE FUNCTION machvon.guard_log_archive_batch() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an archive batch is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'PURGED' OR NEW.status <> 'PURGED' OR NEW.file_key IS DISTINCT FROM OLD.file_key OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
     OR NEW.row_count IS DISTINCT FROM OLD.row_count OR NEW.record_class IS DISTINCT FROM OLD.record_class THEN
    RAISE EXCEPTION 'an archive batch moves from ARCHIVED to PURGED once and keeps its file and its counts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER log_archive_batch_guard BEFORE UPDATE OR DELETE ON machvon.log_archive_batch FOR EACH ROW EXECUTE FUNCTION machvon.guard_log_archive_batch();

CREATE FUNCTION machvon.guard_log_capacity_policy() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.record_class IS DISTINCT FROM OLD.record_class OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a cap keeps its class and its origin' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a change of a cap moves its version by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER log_capacity_policy_guard BEFORE UPDATE ON machvon.log_capacity_policy FOR EACH ROW EXECUTE FUNCTION machvon.guard_log_capacity_policy();

ALTER TABLE machvon.log_capacity_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.log_capacity_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.log_capacity_policy AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.log_capacity_policy AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.log_capacity_policy_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.log_capacity_policy_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.log_capacity_policy_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.log_capacity_policy_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.log_capacity_reading ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.log_capacity_reading FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.log_capacity_reading AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.log_capacity_reading AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.log_archive_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.log_archive_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.log_archive_batch AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.log_archive_batch AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.log_capacity_policy FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.log_capacity_policy_event FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.log_capacity_reading FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.log_archive_batch FROM machvon_app;

COMMENT ON TABLE machvon.log_capacity_policy IS 'ENT-4e: the cap on rows and bytes of a log class of a tenant; technical classes are archived then purged beyond it, audit classes are only monitored.';
COMMENT ON TABLE machvon.log_capacity_policy_event IS 'ENT-4e: what was done to a log cap and why; append-only.';
COMMENT ON TABLE machvon.log_capacity_reading IS 'ENT-4e: the last measure of each log class of a tenant.';
COMMENT ON TABLE machvon.log_archive_batch IS 'ENT-4e: the file that holds rows archived before the nightly run purged them; ARCHIVED first, PURGED once the rows are gone.';

-- Authored by hand (not generated): the export jobs and the schedules that make them (ST-BI-008, BI.md F7).
-- V002 gave the tables; what an export stands on is put into the database here, whatever the application checked first:
--   * a job is made for one person (the subject) under the scope that person had when it ran: who asked, for whom, what was asked, the period, the version of the dataset, the scope and the format never change;
--   * it moves forward only: QUEUED, RUNNING, then READY (the file, its digest and when it expires, written together and once), DENIED (a recipient who lost the right: the reason, and no file) or FAILED; READY goes to EXPIRED;
--   * a job never holds more rows than its cap, and a job that was refused or failed has no file;
--   * a schedule fixes its owner, what it asks and its recipients (one to five hundred), and RETIRED is final; nothing is deleted.

ALTER TABLE machvon.bi_export_job ADD COLUMN denied_reason text;
ALTER TABLE machvon.bi_export_schedule ADD COLUMN last_run_at timestamptz;

ALTER TABLE machvon.bi_export_job
  ADD CONSTRAINT bi_export_job_expiry_chk CHECK (status NOT IN ('READY', 'EXPIRED') OR expires_at IS NOT NULL) NOT VALID,
  ADD CONSTRAINT bi_export_job_refused_chk CHECK (status NOT IN ('DENIED', 'FAILED') OR file_object_key IS NULL) NOT VALID,
  ADD CONSTRAINT bi_export_job_denied_chk CHECK (status <> 'DENIED' OR nullif(btrim(coalesce(denied_reason, '')), '') IS NOT NULL) NOT VALID,
  ADD CONSTRAINT bi_export_job_rows_chk CHECK (row_cap > 0 AND (row_count IS NULL OR (row_count >= 0 AND row_count <= row_cap))) NOT VALID;

ALTER TABLE machvon.bi_export_schedule
  ADD CONSTRAINT bi_export_schedule_recipients_chk CHECK (jsonb_typeof(recipients) = 'array' AND jsonb_array_length(recipients) BETWEEN 1 AND 500) NOT VALID,
  ADD CONSTRAINT bi_export_schedule_cron_chk CHECK (cron = btrim(cron) AND char_length(cron) BETWEEN 9 AND 120) NOT VALID;

CREATE INDEX bi_export_job_subject_idx ON machvon.bi_export_job (tenant_id, subject_user_id, created_at DESC, id);
CREATE INDEX bi_export_job_schedule_idx ON machvon.bi_export_job (tenant_id, schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;
CREATE INDEX bi_export_schedule_owner_idx ON machvon.bi_export_schedule (tenant_id, owner_user_id, created_at DESC, id);

CREATE FUNCTION machvon.guard_bi_export_job() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'export jobs are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.requested_by, NEW.subject_user_id, NEW.schedule_id, NEW.query_spec, NEW.as_of_period, NEW.dataset_version_id, NEW.scope_hash, NEW.scope_description, NEW.format, NEW.row_cap, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.requested_by, OLD.subject_user_id, OLD.schedule_id, OLD.query_spec, OLD.as_of_period, OLD.dataset_version_id, OLD.scope_hash, OLD.scope_description, OLD.format, OLD.row_cap, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what an export job asks, for whom and under which scope never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'DENIED', 'FAILED'))
          OR (OLD.status = 'RUNNING' AND NEW.status IN ('READY', 'DENIED', 'FAILED'))
          OR (OLD.status = 'READY' AND NEW.status = 'EXPIRED')) THEN
    RAISE EXCEPTION 'an export job cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('READY', 'EXPIRED', 'DENIED', 'FAILED')
     AND (NEW.file_object_key, NEW.file_sha256, NEW.expires_at, NEW.row_count, NEW.truncated, NEW.denied_reason) IS DISTINCT FROM (OLD.file_object_key, OLD.file_sha256, OLD.expires_at, OLD.row_count, OLD.truncated, OLD.denied_reason) THEN
    RAISE EXCEPTION 'the file of an export job and how it ended are written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER bi_export_job_guard BEFORE UPDATE OR DELETE ON machvon.bi_export_job
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_bi_export_job();
CREATE TRIGGER bi_export_job_no_truncate BEFORE TRUNCATE ON machvon.bi_export_job
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_bi_export_job();

CREATE FUNCTION machvon.guard_bi_export_schedule() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'export schedules are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.dashboard_id, NEW.query_spec, NEW.cron, NEW.timezone, NEW.format, NEW.recipients, NEW.owner_user_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.dashboard_id, OLD.query_spec, OLD.cron, OLD.timezone, OLD.format, OLD.recipients, OLD.owner_user_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what an export schedule asks, its recipients and its owner never change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED' THEN
    RAISE EXCEPTION 'a retired export schedule is final' USING ERRCODE = '42501';
  END IF;
  IF NEW.last_run_at IS NOT NULL AND OLD.last_run_at IS NOT NULL AND NEW.last_run_at < OLD.last_run_at THEN
    RAISE EXCEPTION 'the last run of an export schedule only moves forward' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER bi_export_schedule_guard BEFORE UPDATE OR DELETE ON machvon.bi_export_schedule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_bi_export_schedule();
CREATE TRIGGER bi_export_schedule_no_truncate BEFORE TRUNCATE ON machvon.bi_export_schedule
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_bi_export_schedule();

REVOKE DELETE, TRUNCATE ON TABLE machvon.bi_export_job FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.bi_export_schedule FROM machvon_app;

-- Authored by hand (not generated): the log of the queries of BI and the jobs that heavy queries become (ST-BI-009, BI.md F3 and BI-13).
-- V002 gave the table; what the log stands on is put into the database here, whatever the application checked first:
--   * a run says who asked, what was asked, under which scope and over which version of the dataset, and never changes; a run that is a job keeps what was asked (the spec) so that it can be run later;
--   * a job moves forward only: QUEUED, RUNNING, then COMPLETED (its answer, written once, kept for a while and then taken away), DENIED (the reader lost the right), FAILED or TIMEOUT; CANCELLED is final too;
--   * there is one job at a time for the same question of the same reader under the same scope (the key of the cache), whatever the number of requests that came together;
--   * a run that was refused or failed says why; nothing is deleted.

ALTER TABLE machvon.bi_query_run
  ADD COLUMN query_spec jsonb,
  ADD COLUMN cache_key char(64),
  ADD COLUMN estimated_cost numeric(16,0),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN result jsonb,
  ADD COLUMN result_expires_at timestamptz;

ALTER TABLE machvon.bi_query_run
  ADD CONSTRAINT bi_query_run_job_chk CHECK (mode <> 'ASYNC_JOB' OR (query_spec IS NOT NULL AND cache_key IS NOT NULL AND estimated_cost IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT bi_query_run_open_chk CHECK (status NOT IN ('QUEUED', 'RUNNING') OR mode = 'ASYNC_JOB') NOT VALID,
  ADD CONSTRAINT bi_query_run_refused_chk CHECK (status NOT IN ('DENIED', 'FAILED', 'TIMEOUT') OR nullif(btrim(coalesce(error_code, '')), '') IS NOT NULL) NOT VALID,
  ADD CONSTRAINT bi_query_run_result_chk CHECK (result IS NULL OR (status = 'COMPLETED' AND mode = 'ASYNC_JOB' AND result_expires_at IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT bi_query_run_numbers_chk CHECK ((duration_ms IS NULL OR duration_ms >= 0) AND (row_count IS NULL OR row_count >= 0) AND (estimated_cost IS NULL OR estimated_cost >= 0)) NOT VALID;

CREATE INDEX bi_query_run_log_idx ON machvon.bi_query_run (tenant_id, created_at DESC, id DESC);
CREATE INDEX bi_query_run_open_idx ON machvon.bi_query_run (tenant_id, created_at, id) WHERE status = 'QUEUED';
CREATE INDEX bi_query_run_key_idx ON machvon.bi_query_run (tenant_id, cache_key, created_at DESC) WHERE cache_key IS NOT NULL;
CREATE UNIQUE INDEX bi_query_run_one_open_uq ON machvon.bi_query_run (tenant_id, cache_key) WHERE mode = 'ASYNC_JOB' AND status IN ('QUEUED', 'RUNNING');

CREATE FUNCTION machvon.guard_bi_query_run() RETURNS trigger
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
    RAISE EXCEPTION 'the log of the queries is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.requested_by, NEW.dashboard_version_id, NEW.metric_version_ids, NEW.as_of_period, NEW.dataset_version_id, NEW.scope_hash, NEW.drill_context_id, NEW.mode, NEW.query_spec, NEW.cache_key, NEW.estimated_cost, NEW.created_at)
     IS DISTINCT FROM (OLD.requested_by, OLD.dashboard_version_id, OLD.metric_version_ids, OLD.as_of_period, OLD.dataset_version_id, OLD.scope_hash, OLD.drill_context_id, OLD.mode, OLD.query_spec, OLD.cache_key, OLD.estimated_cost, OLD.created_at) THEN
    RAISE EXCEPTION 'what a query run asks, for whom and under which scope never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'DENIED', 'FAILED', 'CANCELLED'))
          OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'DENIED', 'FAILED', 'TIMEOUT'))) THEN
    RAISE EXCEPTION 'a query run cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('COMPLETED', 'DENIED', 'FAILED', 'TIMEOUT', 'CANCELLED')
     AND (NEW.duration_ms, NEW.row_count, NEW.cost_units, NEW.error_code, NEW.served_from_cache, NEW.started_at, NEW.finished_at) IS DISTINCT FROM (OLD.duration_ms, OLD.row_count, OLD.cost_units, OLD.error_code, OLD.served_from_cache, OLD.started_at, OLD.finished_at) THEN
    RAISE EXCEPTION 'how a query run ended is written once' USING ERRCODE = '42501';
  END IF;
  -- The answer is written once with the end of the job; afterwards it can only be taken away (and its time with it).
  IF OLD.result IS NOT NULL AND NEW.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'the answer of a query job is written once' USING ERRCODE = '42501';
  END IF;
  IF OLD.result IS NULL AND NEW.result IS NOT NULL AND OLD.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'the answer of a query job is written with its end' USING ERRCODE = '42501';
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS NOT NULL AND NEW.result_expires_at IS DISTINCT FROM OLD.result_expires_at THEN
    RAISE EXCEPTION 'the time an answer is kept until never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER bi_query_run_guard BEFORE UPDATE OR DELETE ON machvon.bi_query_run
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_bi_query_run();
CREATE TRIGGER bi_query_run_no_truncate BEFORE TRUNCATE ON machvon.bi_query_run
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_bi_query_run();

REVOKE DELETE, TRUNCATE ON TABLE machvon.bi_query_run FROM machvon_app;

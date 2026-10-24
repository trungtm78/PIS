-- Authored by hand (not generated): quality rule versions, runs on frozen snapshots and the result of every rule (ST-DGV-002, DGV 3.3 F3, BR-DGV-01 to BR-DGV-04).
-- The tables, their row-level security and the columns of the design come from V002; this adds what the rules, the runs and the scorecards rely on
-- to tell the truth: a rule version that never changes once it is written, a run that reads one frozen snapshot and says which rule versions it
-- applied, a verdict that is consistent with its parts, and the loss of the right to delete (the history of what was measured is kept).
-- The NOT NULL columns of the design that V002 added as nullable are enforced here as CHECK constraints (NOT VALID: no row of the older scaffold
-- is read or rewritten; every row written from now on must satisfy them).

-- ---- quality_rule_version ----------------------------------------------------------------------------------------------------------------

-- The dataset a rule measures, taken from its contract when the version is written, so that who may see the rule is who may see the dataset.
ALTER TABLE machvon.quality_rule_version ADD COLUMN dataset_id uuid;
ALTER TABLE machvon.quality_rule_version ADD COLUMN approved_at timestamptz;
ALTER TABLE machvon.quality_rule_version ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_dataset_fk FOREIGN KEY (tenant_id, dataset_id) REFERENCES machvon.dataset (tenant_id, id);

ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_shape_chk CHECK (dataset_id IS NOT NULL AND dimension IS NOT NULL AND action_on_fail IS NOT NULL AND criticality_weight IS NOT NULL AND created_by IS NOT NULL) NOT VALID;
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_status_chk CHECK (status IN ('DRAFT', 'APPROVED', 'SUPERSEDED'));
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_severity_chk CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_code_chk CHECK (code = btrim(code) AND length(code) BETWEEN 2 AND 80);
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_revision_chk CHECK (revision >= 1);
-- The expression is an object and the threshold is an object; what they may contain is judged by the rule engine before the row is written.
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_json_chk CHECK (jsonb_typeof(expression_ast) = 'object' AND jsonb_typeof(threshold_json) = 'object');
-- An approved version says who approved it and when; a draft says neither (a superseded draft was never approved). The approver is never the
-- author (quality_rule_version_sod_chk).
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_approval_chk CHECK (
    (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
    AND (status <> 'DRAFT' OR (approved_by IS NULL AND approved_at IS NULL))
  );
-- An integrity failure is a hard failure (BR-DGV-03): the rule cannot be set to merely warn.
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_integrity_chk CHECK (dimension IS DISTINCT FROM 'INTEGRITY' OR action_on_fail <> 'WARN');
-- No rule is written for the accuracy dimension until it can be measured from a confirmed source or an expert sample.
ALTER TABLE machvon.quality_rule_version
  ADD CONSTRAINT quality_rule_version_measurable_chk CHECK (dimension IS DISTINCT FROM 'ACCURACY');

-- One approved version of a rule code in a contract at a time.
CREATE UNIQUE INDEX quality_rule_version_approved_uq ON machvon.quality_rule_version (tenant_id, contract_id, code) WHERE status = 'APPROVED';
CREATE INDEX quality_rule_version_dataset_idx ON machvon.quality_rule_version (tenant_id, dataset_id, code, revision);

-- What a rule is never changes (the runs that applied it keep their meaning); only its status moves, DRAFT -> APPROVED -> SUPERSEDED or
-- DRAFT -> SUPERSEDED (a newer version was approved), and the approval is written once.
CREATE FUNCTION machvon.guard_quality_rule_version_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.dataset_id IS DISTINCT FROM OLD.dataset_id OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.dimension IS DISTINCT FROM OLD.dimension OR NEW.field_path IS DISTINCT FROM OLD.field_path
     OR NEW.expression_ast IS DISTINCT FROM OLD.expression_ast OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.threshold_json IS DISTINCT FROM OLD.threshold_json OR NEW.action_on_fail IS DISTINCT FROM OLD.action_on_fail
     OR NEW.criticality_weight IS DISTINCT FROM OLD.criticality_weight OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the definition of a quality rule version never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'a superseded quality rule version is never changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'APPROVED' AND (NEW.status NOT IN ('APPROVED', 'SUPERSEDED') OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'an approved quality rule version keeps its approval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER quality_rule_version_update_guard BEFORE UPDATE ON machvon.quality_rule_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_quality_rule_version_update();

-- ---- quality_run ------------------------------------------------------------------------------------------------------------------------

-- A run that is still running has not finished: the design made finished_at mandatory because it only knew finished runs.
ALTER TABLE machvon.quality_run ALTER COLUMN finished_at DROP NOT NULL;
-- The run reads one frozen snapshot of the module that owns the dataset. The digest of that snapshot's payload, taken when the run is requested,
-- is checked again when the run reads it: a snapshot that is no longer the one that was asked for is not measured (SNAPSHOT_CHANGED).
ALTER TABLE machvon.quality_run ADD COLUMN snapshot_sha256 char(64);
-- The snapshot must not feed certified figures (a hard fail, or a failed rule whose action is HARD_BLOCK); BI reads this, not the score.
ALTER TABLE machvon.quality_run ADD COLUMN certified_blocked boolean NOT NULL DEFAULT false;
-- Why a run that could not be measured has no verdict.
ALTER TABLE machvon.quality_run ADD COLUMN failure_code text;
-- How often the executor has taken the run up; a run that keeps failing to execute is finished as FAILED, not retried for ever.
ALTER TABLE machvon.quality_run ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE machvon.quality_run
  ADD CONSTRAINT quality_run_shape_chk CHECK (dataset_id IS NOT NULL AND trigger IS NOT NULL AND started_at IS NOT NULL AND status IS NOT NULL) NOT VALID;
ALTER TABLE machvon.quality_run
  ADD CONSTRAINT quality_run_failure_code_chk CHECK (failure_code IS NULL OR failure_code IN ('SNAPSHOT_CHANGED', 'SNAPSHOT_INCOMPLETE', 'SOURCE_NOT_SUPPORTED', 'NO_RULE_MEASURED', 'EXECUTION_FAILED'));
-- A run is RUNNING (no verdict yet), COMPLETED (a verdict and a score) or FAILED (it could not be measured: no verdict, no score, and a reason).
-- The verdict of a COMPLETED run is PASSED, WARNING or FAILED; a hard fail is always FAILED and always blocks certified figures.
ALTER TABLE machvon.quality_run
  ADD CONSTRAINT quality_run_state_chk CHECK (
    (status = 'RUNNING' AND finished_at IS NULL AND overall_result IS NULL AND score IS NULL AND failure_code IS NULL AND NOT hard_fail AND NOT certified_blocked)
    OR (status = 'COMPLETED' AND finished_at IS NOT NULL AND overall_result IS NOT NULL AND score IS NOT NULL AND failure_code IS NULL)
    OR (status = 'FAILED' AND finished_at IS NOT NULL AND overall_result IS NULL AND score IS NULL AND failure_code IS NOT NULL AND NOT hard_fail AND NOT certified_blocked)
  ) NOT VALID;
ALTER TABLE machvon.quality_run
  ADD CONSTRAINT quality_run_hard_fail_chk CHECK (NOT hard_fail OR (overall_result = 'FAILED' AND certified_blocked));
ALTER TABLE machvon.quality_run
  ADD CONSTRAINT quality_run_rules_chk CHECK (jsonb_typeof(rule_version_ids) = 'array' AND jsonb_array_length(rule_version_ids) >= 1) NOT VALID;
ALTER TABLE machvon.quality_run
  ADD CONSTRAINT quality_run_attempts_chk CHECK (attempts >= 0);

ALTER TABLE machvon.quality_run
  ADD CONSTRAINT quality_run_dataset_fk FOREIGN KEY (tenant_id, dataset_id) REFERENCES machvon.dataset (tenant_id, id) NOT VALID;

-- Two runs of one snapshot are never running at the same time (RUN_ALREADY_RUNNING), and the delivery of the event that a snapshot was frozen,
-- however often it is repeated, starts one run for the snapshot and the dataset.
CREATE UNIQUE INDEX quality_run_running_uq ON machvon.quality_run (tenant_id, dataset_id, snapshot_id) WHERE status = 'RUNNING';
CREATE UNIQUE INDEX quality_run_snapshot_event_uq ON machvon.quality_run (tenant_id, dataset_id, snapshot_id) WHERE trigger = 'SNAPSHOT_FROZEN';
-- The latest finished run of a dataset (the badge, the scorecard) and the runs waiting to be executed.
CREATE INDEX quality_run_latest_idx ON machvon.quality_run (tenant_id, dataset_id, finished_at DESC, id DESC) WHERE status = 'COMPLETED';
CREATE INDEX quality_run_waiting_idx ON machvon.quality_run (tenant_id, started_at, id) WHERE status = 'RUNNING';

-- A run that has finished never changes again; what names a run (dataset, contract, snapshot, trigger, rule versions, who asked) never changes at all.
CREATE FUNCTION machvon.guard_quality_run_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'a finished quality run is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.dataset_id IS DISTINCT FROM OLD.dataset_id OR NEW.dataset_contract_id IS DISTINCT FROM OLD.dataset_contract_id
     OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.trigger IS DISTINCT FROM OLD.trigger OR NEW.rule_version_ids IS DISTINCT FROM OLD.rule_version_ids
     OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.triggered_by IS DISTINCT FROM OLD.triggered_by THEN
    RAISE EXCEPTION 'a quality run keeps its dataset, contract, snapshot, trigger, rule versions and start' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER quality_run_update_guard BEFORE UPDATE ON machvon.quality_run
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_quality_run_update();

-- ---- quality_rule_result ----------------------------------------------------------------------------------------------------------------

-- A rule that could not be measured says why, and has no measured value: it is never read as a pass.
ALTER TABLE machvon.quality_rule_result ADD COLUMN error_code text;
ALTER TABLE machvon.quality_rule_result
  ADD CONSTRAINT quality_rule_result_error_chk CHECK ((result = 'ERROR') = (error_code IS NOT NULL) AND (result = 'ERROR') = (measured_value IS NULL));
ALTER TABLE machvon.quality_rule_result
  ADD CONSTRAINT quality_rule_result_error_code_chk CHECK (error_code IS NULL OR error_code IN ('NO_ROWS_EVALUATED', 'EVALUATION_FAILED'));
ALTER TABLE machvon.quality_rule_result
  ADD CONSTRAINT quality_rule_result_quarantine_chk CHECK (quarantined_count >= 0 AND quarantined_count <= failed_count AND passed_count >= 0 AND failed_count >= 0);
ALTER TABLE machvon.quality_rule_result
  ADD CONSTRAINT quality_rule_result_measure_chk CHECK (measured_value IS NULL OR measured_value BETWEEN 0 AND 100);

-- A result is the record of a measurement: it is written once, with the run that finishes, and never changed or removed.
CREATE FUNCTION machvon.guard_quality_rule_result() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the result of a quality rule is never changed or removed' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER quality_rule_result_immutable BEFORE UPDATE OR DELETE ON machvon.quality_rule_result
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_quality_rule_result();

-- ---- retention --------------------------------------------------------------------------------------------------------------------------

-- The rules, the runs and their results are the evidence for the scorecard and for the incidents that refer to them: kept, never deleted.
REVOKE DELETE, TRUNCATE ON TABLE machvon.quality_rule_version FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.quality_run FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.quality_rule_result FROM machvon_app;

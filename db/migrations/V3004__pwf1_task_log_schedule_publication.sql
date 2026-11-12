-- Authored by hand (not generated): the log of a task, the published versions of the schedule, the proposals to move it and the days of the baselines (PWF-1 and the publication of the schedule of PWF-2, docs PWF 6,
-- BR-PWF-07, 08, 28, R32). Every row is only added to, except the proposal, which is decided once. A schedule is PUBLISHED as one transaction under the lock of the project: the version, its input and result hashes, the
-- calendar version of each year it relies on, the critical path and what changed are written with the new days of the tasks; a second publication that was based on an older version is refused (409).

CREATE TABLE machvon.project_task_log (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  task_id uuid,
  kind text NOT NULL CHECK (kind IN (
    'WORKFLOW_STARTED', 'ADOPTED', 'ASSIGNED', 'START', 'EVIDENCE_ATTACHED', 'CHECKLIST_DONE', 'COMPLETE_REQUESTED', 'COMPLETED', 'APPROVED', 'RETURNED', 'EXCEPTION_REQUESTED', 'EXCEPTION_DECIDED',
    'PAUSE_APPROVED', 'RESUMED', 'CANCELLED', 'RESCHEDULE_PROPOSED', 'RESCHEDULE_DECIDED', 'RESCHEDULED', 'GATE_CHECKED', 'GATE_REFUSED', 'OVERRIDDEN'
  )),
  at timestamptz NOT NULL DEFAULT now(),
  actor uuid NOT NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000),
  -- Facts of the entry: ids, codes and days, never words of people.
  subject jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(subject) = 'object'),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.project_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.project_task (tenant_id, id),
  FOREIGN KEY (tenant_id, actor) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX project_task_log_workflow_idx ON machvon.project_task_log (tenant_id, workflow_id, at, id);
CREATE INDEX project_task_log_task_idx ON machvon.project_task_log (tenant_id, task_id, at, id) WHERE task_id IS NOT NULL;

CREATE TABLE machvon.project_schedule_version (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  kind text NOT NULL CHECK (kind IN ('INITIAL', 'ADOPTION', 'RESCHEDULE', 'PROGRESS')),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  calendar_versions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(calendar_versions) = 'array'),
  critical_path jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(critical_path) = 'array'),
  changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes) = 'array'),
  project_start date,
  project_finish date,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000),
  proposed_by uuid NOT NULL,
  approved_by uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_schedule_version_uq UNIQUE (tenant_id, workflow_id, version),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.project_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  -- A moved schedule was approved by someone other than the one who proposed it; the first schedule and the one that follows progress are the system's own.
  CONSTRAINT project_schedule_version_checker_chk CHECK (kind IN ('INITIAL', 'ADOPTION', 'PROGRESS') OR (approved_by IS NOT NULL AND approved_by <> proposed_by))
);

CREATE TABLE machvon.project_reschedule_proposal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  -- The version of the workflow (If-Match) the preview was computed on, and the version of the schedule it started from.
  base_version integer NOT NULL CHECK (base_version >= 1),
  base_schedule_version integer NOT NULL CHECK (base_schedule_version >= 1),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 20 AND 1000),
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 5 AND 500),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.project_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_reschedule_proposal_checker_chk CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT project_reschedule_proposal_decision_chk CHECK ((status = 'PROPOSED') = (decided_at IS NULL) AND (status IN ('APPROVED', 'REJECTED')) = (decided_by IS NOT NULL))
);

-- At most one proposal is waiting for a decision for a workflow (PWF_RESCHEDULE_PENDING_EXISTS).
CREATE UNIQUE INDEX project_reschedule_proposal_pending_uq ON machvon.project_reschedule_proposal (tenant_id, workflow_id) WHERE status = 'PROPOSED';
CREATE INDEX project_reschedule_proposal_workflow_idx ON machvon.project_reschedule_proposal (tenant_id, workflow_id, proposed_at);

CREATE TABLE machvon.project_task_baseline (
  tenant_id uuid NOT NULL,
  baseline_id uuid NOT NULL,
  task_id uuid NOT NULL,
  start_day date,
  finish_day date,
  PRIMARY KEY (tenant_id, baseline_id, task_id),
  FOREIGN KEY (tenant_id, baseline_id) REFERENCES machvon.project_workflow_baseline (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.project_task (tenant_id, id),
  CONSTRAINT project_task_baseline_days_chk CHECK ((start_day IS NULL) = (finish_day IS NULL) AND (start_day IS NULL OR finish_day >= start_day))
);

CREATE INDEX project_task_baseline_task_idx ON machvon.project_task_baseline (tenant_id, task_id);

ALTER TABLE machvon.project_task_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task_log AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task_log AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_task_log FROM machvon_app;

ALTER TABLE machvon.project_schedule_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_schedule_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_schedule_version AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_schedule_version AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_schedule_version FROM machvon_app;

ALTER TABLE machvon.project_reschedule_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_reschedule_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_reschedule_proposal AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_reschedule_proposal AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_reschedule_proposal FROM machvon_app;

ALTER TABLE machvon.project_task_baseline ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task_baseline FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task_baseline AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task_baseline AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_task_baseline FROM machvon_app;

CREATE TRIGGER project_task_log_immutable BEFORE UPDATE OR DELETE ON machvon.project_task_log
  FOR EACH ROW EXECUTE FUNCTION machvon.pwf_forbid_change();
CREATE TRIGGER project_schedule_version_immutable BEFORE UPDATE OR DELETE ON machvon.project_schedule_version
  FOR EACH ROW EXECUTE FUNCTION machvon.pwf_forbid_change();
CREATE TRIGGER project_task_baseline_immutable BEFORE UPDATE OR DELETE ON machvon.project_task_baseline
  FOR EACH ROW EXECUTE FUNCTION machvon.pwf_forbid_change();

-- A proposal is decided once and what it says never changes.
CREATE FUNCTION machvon.guard_project_reschedule_proposal() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reschedule proposal is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.workflow_id, NEW.base_version, NEW.base_schedule_version, NEW.input, NEW.preview, NEW.input_hash, NEW.result_hash, NEW.reason, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.workflow_id, OLD.base_version, OLD.base_schedule_version, OLD.input, OLD.preview, OLD.input_hash, OLD.result_hash, OLD.reason, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'a reschedule proposal keeps what it says for good' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'PROPOSED' THEN
    RAISE EXCEPTION 'a decided reschedule proposal never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_reschedule_proposal_guard BEFORE UPDATE OR DELETE ON machvon.project_reschedule_proposal
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_reschedule_proposal();

COMMENT ON TABLE machvon.project_task_log IS 'The log of a workflow and its tasks (PWF-1): what happened, by whom, with the reason; append-only.';
COMMENT ON TABLE machvon.project_schedule_version IS 'The published versions of the schedule of a workflow (PWF-2, R32): hashes, calendar versions, critical path and changes; append-only.';
COMMENT ON TABLE machvon.project_reschedule_proposal IS 'A proposal to move the schedule, previewed and decided by another person (PWF-2, BR-PWF-08, 28); one is open per workflow.';
COMMENT ON TABLE machvon.project_task_baseline IS 'The days of a task in a version of the baseline (BR-PWF-07); append-only.';

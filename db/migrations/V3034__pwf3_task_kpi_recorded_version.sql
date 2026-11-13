-- Authored by hand (not generated): the version of a task at which its KPI results were last evaluated (PWF-3, docs PWF 9, R35).
-- Expand step of an expand-contract change: the column is nullable and nothing reads it as required. The job that writes the results of the tasks that were done or cancelled looks only at the tasks whose
-- `version` is not the one recorded here, so a pass costs what changed and not the number of tasks of the tenant. Setting it never bumps `version`, so it moves no one's If-Match.

-- `kpi_recorded_calendars` is the fingerprint of the published working calendars the results were counted on: a calendar published or corrected later makes the task pending again, so that a result that said "no calendar" is read again.
ALTER TABLE machvon.project_task ADD COLUMN kpi_recorded_version integer, ADD COLUMN kpi_recorded_calendars text;

CREATE INDEX project_task_kpi_pending_idx ON machvon.project_task (tenant_id, updated_at, id)
  WHERE tracked AND NOT excluded AND kind = 'TASK' AND status IN ('DONE', 'CANCELLED');

COMMENT ON COLUMN machvon.project_task.kpi_recorded_calendars IS 'The fingerprint of the published working calendars the KPI results of the task were counted on (PWF-3).';
COMMENT ON COLUMN machvon.project_task.kpi_recorded_version IS 'The version of the task when its KPI results were last evaluated (PWF-3); the job reads again only a done or cancelled task whose version moved.';

-- Authored by hand (not generated): the deadline of the whole file of a project workflow (PWF-5, docs PWF section 22.2 "Hạn chung của hồ sơ", 22.6).
-- Expand step of an expand-contract change: one column the database fills by itself and one index. The code before this migration neither writes nor reads the column, so its statements and its rows stay valid as they are.
-- No contract step is planned.

-- The code of the task whose committed finish is the deadline of the whole file, as the FROZEN template of the workflow says it (`template.overall_deadline_task`). It is a generated column: the template of a workflow never
-- changes after the row is written (guard of V3001), so the column is written once, by the insert that starts or adopts the workflow, whatever version of the code makes the insert, and it can never disagree with the template.
-- NULL: the template marks no task (every template before PWF-5). The alert `PWF_OVERALL_DEADLINE_AT_RISK` reads the running workflows that have one through this column and its index, never the frozen JSON of every
-- workflow of the tenant (R35, bounded reads).
ALTER TABLE machvon.project_workflow
  ADD COLUMN overall_deadline_task text GENERATED ALWAYS AS (template ->> 'overall_deadline_task') STORED;

CREATE INDEX project_workflow_overall_deadline_idx ON machvon.project_workflow (tenant_id, id) WHERE status = 'ACTIVE' AND overall_deadline_task IS NOT NULL;

COMMENT ON COLUMN machvon.project_workflow.overall_deadline_task IS 'The code of the task whose committed finish is the deadline of the whole file, from the frozen template (PWF-5); NULL when the template marks none.';
COMMENT ON INDEX machvon.project_workflow_overall_deadline_idx IS 'The running workflows that have a deadline of the whole file (PWF-5), for the alert PWF_OVERALL_DEADLINE_AT_RISK.';

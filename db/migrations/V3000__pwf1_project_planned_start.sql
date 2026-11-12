-- Authored by hand (not generated): the planned start day of a project (PWF-1, R28, BR-PWF-11, docs PWF 6).
-- Expand step of an expand-contract change: the column is nullable and nothing reads it as required, so a release that does not know it keeps working. A project that has an effective baseline answers its planned start
-- from that baseline (`project_baseline.planned_start`); a project that starts a workflow records the day it was started from here, and the schedule of the workflow is laid from it. No contract step follows: a project
-- without a workflow has no planned start day of its own, and that stays true.

ALTER TABLE machvon.project ADD COLUMN planned_start_date date;

ALTER TABLE machvon.project
  ADD CONSTRAINT project_planned_start_chk CHECK (planned_start_date IS NULL OR planned_start_date BETWEEN DATE '1990-01-01' AND DATE '2100-12-31');

COMMENT ON COLUMN machvon.project.planned_start_date IS 'The day the project is planned to start (PWF-1): set when a workflow is started or adopted; the schedule of the workflow is laid from it.';

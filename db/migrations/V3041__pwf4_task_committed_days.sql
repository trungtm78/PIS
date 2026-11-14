-- Authored by hand (not generated): the committed days of a task, the official deadline of the project workflow (PWF, decision R49 of docs PWF).
-- Expand step of an expand-contract change: the two columns are nullable, the code before this migration neither reads nor writes them, and the rows written before it are filled below. No contract step is planned: a task that
-- cannot be dated (a year without a published calendar) keeps both columns NULL.

-- R49: `planned_start` and `planned_finish` are the CURRENT computation of the schedule (the forecast): they move every time the schedule is computed again from the progress, by itself, when a task is completed or cancelled.
-- The deadline a task is judged by (the colour of the deadline, the reminders, the alerts, the boards) is the day of the schedule that was RELEASED by a decision: the first schedule of the workflow, the adoption of a running project,
-- or a reschedule that a second person approved. Computing the forecast again never moves it, so a task that is late stays late until a move of its date is approved (the practice of P6 and MS Project: a baseline or a
-- committed date is not the forecast). The first baseline (`baseline_start`, `baseline_finish`) is unchanged: it never moves at all, and the scores are measured against it (BR-PWF-07).
ALTER TABLE machvon.project_task
  ADD COLUMN committed_start date,
  ADD COLUMN committed_finish date,
  ADD CONSTRAINT project_task_committed_chk CHECK ((committed_start IS NULL) = (committed_finish IS NULL) AND (committed_start IS NULL OR committed_finish >= committed_start));

-- The rows written before this migration. The days of an older released schedule were never kept task by task (only the hashes and the shifts of each version are), so:
--  * a workflow whose schedule was never moved by an approved reschedule takes its first baseline, which IS its released schedule;
--  * a workflow that has an approved reschedule takes the days it has now: they are the nearest record of what was approved (what moved by itself since cannot be told apart, and is not guessed);
--  * a task with no baseline day (dated for the first time after the first schedule) takes the days it has now.
-- The statement runs as the owner of the schema, whom the guards of the table let through.
UPDATE machvon.project_task t
   SET committed_start = CASE WHEN r.moved OR t.baseline_finish IS NULL THEN t.planned_start ELSE t.baseline_start END,
       committed_finish = CASE WHEN r.moved OR t.baseline_finish IS NULL THEN t.planned_finish ELSE t.baseline_finish END
  FROM (SELECT w.tenant_id, w.id,
               EXISTS (SELECT 1 FROM machvon.project_schedule_version v WHERE v.tenant_id = w.tenant_id AND v.workflow_id = w.id AND v.kind = 'RESCHEDULE') AS moved
          FROM machvon.project_workflow w) r
 WHERE r.tenant_id = t.tenant_id AND r.id = t.workflow_id
   AND t.committed_finish IS NULL
   AND (t.planned_finish IS NOT NULL OR t.baseline_finish IS NOT NULL);

-- The boards, the lists of a person, the reminders and the alerts read the open tasks by their official deadline.
CREATE INDEX project_task_committed_idx ON machvon.project_task (tenant_id, status, committed_finish) WHERE tracked AND NOT excluded;

-- The committed days of a task are written when a schedule is released (the publication says so for its own transaction, `pwf.release`, as an override of the links says `pwf.override`), or when a task that had no day gets its
-- first ones: a task that is given days while it has no committed day takes them as its committed days, whoever writes the row (there is nothing to keep, and a dated task without an official deadline would be on no board).
-- Nothing else moves them: a statement that computes the forecast again cannot loosen a deadline by accident.
CREATE FUNCTION machvon.guard_project_task_committed() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.committed_finish IS NULL AND NEW.planned_finish IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.committed_finish IS NULL) THEN
    NEW.committed_start := NEW.planned_start;
    NEW.committed_finish := NEW.planned_finish;
  END IF;
  IF TG_OP = 'INSERT' OR current_user = 'machvon_owner' OR current_setting('pwf.release', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.committed_finish IS NOT NULL AND (NEW.committed_start IS DISTINCT FROM OLD.committed_start OR NEW.committed_finish IS DISTINCT FROM OLD.committed_finish) THEN
    RAISE EXCEPTION 'the committed days of a task move only when a schedule is released' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_task_committed_guard BEFORE INSERT OR UPDATE ON machvon.project_task
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_task_committed();

COMMENT ON COLUMN machvon.project_task.committed_start IS 'The start of the task in the schedule last RELEASED by a decision (first schedule, adoption, approved reschedule); never moved by a recomputation from progress (PWF, R49).';
COMMENT ON COLUMN machvon.project_task.committed_finish IS 'The official deadline of the task: its finish in the schedule last released by a decision. The colour of the deadline, the reminders, the alerts and the boards read it; planned_finish is the forecast (PWF, R49).';

-- Authored by hand (not generated): extending the time limit of a task through an approved reschedule proposal (PWF-5, docs PWF section 22.4: R72).
-- Expand step of an expand-contract change: the log gains one kind of entry (every kind it had stays valid) and the two counters of V3060 gain a guard. The code before this migration writes neither the kind nor the counters
-- (they stay at their default 0), so its rows and its writes stay valid as they are. No contract step is planned.
-- The lines of a proposal need no column: they are part of what the proposal says (`project_reschedule_proposal.input`, with the preview beside it), which the guard of V3004 already keeps for good.

-- R72: `TASK_EXTENDED` is the entry of a task whose limit an approved proposal raised (the proposal, the lines, the value added, the limit before and after, what is used of the caps). The list of kinds is the one of V3061
-- with that one added.
ALTER TABLE machvon.project_task_log DROP CONSTRAINT project_task_log_kind_check;
ALTER TABLE machvon.project_task_log
  ADD CONSTRAINT project_task_log_kind_check CHECK (kind IN (
    'WORKFLOW_STARTED', 'ADOPTED', 'ASSIGNED', 'START', 'EVIDENCE_ATTACHED', 'CHECKLIST_DONE', 'COMPLETE_REQUESTED', 'COMPLETED', 'APPROVED', 'RETURNED', 'EXCEPTION_REQUESTED', 'EXCEPTION_DECIDED',
    'PAUSE_APPROVED', 'RESUMED', 'CANCELLED', 'RESCHEDULE_PROPOSED', 'RESCHEDULE_DECIDED', 'RESCHEDULED', 'GATE_CHECKED', 'GATE_REFUSED', 'OVERRIDDEN', 'TASK_CLAIMED', 'TASK_EXTENDED'
  ));

-- R72: what a task has used of its extension caps is written only by the approval of a proposal that extends it, which says so for its own transaction (`pwf.extension`, as a release says `pwf.release`), and it only grows:
-- a cap that was spent is never given back, and no other write of the task (its progress, its days, an override) can move the count. The owner of the schema may still correct a row.
CREATE FUNCTION machvon.guard_project_task_extension() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    RETURN NEW;
  END IF;
  IF (NEW.extension_times_used, NEW.extension_value_used) IS DISTINCT FROM (OLD.extension_times_used, OLD.extension_value_used) THEN
    IF current_setting('pwf.extension', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'the extension counters of a project task are written by an approved extension only' USING ERRCODE = '42501';
    END IF;
    IF NEW.extension_times_used < OLD.extension_times_used OR NEW.extension_value_used < OLD.extension_value_used THEN
      RAISE EXCEPTION 'the extension counters of a project task never go down' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_task_extension_guard BEFORE UPDATE ON machvon.project_task
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_task_extension();

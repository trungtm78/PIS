-- Authored by hand (not generated): taking a task of a project for the unit that receives it (PWF-5, docs PWF section 22.3: R61, R71).
-- Expand step of an expand-contract change: the log gains one kind of entry (every kind it had stays valid), the columns of V3060 that say which unit receives a task gain an index and a guard. The code before this migration
-- writes neither the kind nor the columns, so its rows stay valid as they are. No contract step is planned.

-- R71: `TASK_CLAIMED` is the entry of a person who took a task for a unit that receives it ("Nhận việc"). The list of kinds is the one of V3004 with that one added.
ALTER TABLE machvon.project_task_log DROP CONSTRAINT project_task_log_kind_check;
ALTER TABLE machvon.project_task_log
  ADD CONSTRAINT project_task_log_kind_check CHECK (kind IN (
    'WORKFLOW_STARTED', 'ADOPTED', 'ASSIGNED', 'START', 'EVIDENCE_ATTACHED', 'CHECKLIST_DONE', 'COMPLETE_REQUESTED', 'COMPLETED', 'APPROVED', 'RETURNED', 'EXCEPTION_REQUESTED', 'EXCEPTION_DECIDED',
    'PAUSE_APPROVED', 'RESUMED', 'CANCELLED', 'RESCHEDULE_PROPOSED', 'RESCHEDULE_DECIDED', 'RESCHEDULED', 'GATE_CHECKED', 'GATE_REFUSED', 'OVERRIDDEN', 'TASK_CLAIMED'
  ));

-- R71: the tasks a unit receives (the alert `PWF_TASK_UNCLAIMED` reads the open ones nobody is responsible for, unit by unit, in the order of the day they are planned to start); also the index of the foreign key of V3060.
CREATE INDEX project_task_receiving_unit_idx ON machvon.project_task (tenant_id, receiving_unit_id, planned_start) WHERE receiving_unit_id IS NOT NULL;

-- R61: the units of a task are resolved when its workflow is made and never afterwards (a project whose owner or investor changes keeps the units its running workflow was started with; who does the task is the ledger of
-- assignments). The owner of the schema may still correct a row.
CREATE FUNCTION machvon.guard_project_task_receiving_units() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    RETURN NEW;
  END IF;
  IF (NEW.receiving_unit_id, NEW.receiving_units) IS DISTINCT FROM (OLD.receiving_unit_id, OLD.receiving_units) THEN
    RAISE EXCEPTION 'the units that receive a project task are resolved when its workflow is made' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_task_receiving_units_guard BEFORE UPDATE ON machvon.project_task
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_task_receiving_units();

COMMENT ON INDEX machvon.project_task_receiving_unit_idx IS 'The tasks a unit receives, by the day they are planned to start (PWF-5, R71).';

-- Authored by hand (not generated): what the table-first workflow model freezes on a task of a project (PWF-5, docs PWF section 22: R58, R59, R61, R72, R73).
-- Expand step of an expand-contract change: every column is nullable or has a default, the code before this migration neither reads nor writes them, and the rows written before it stay valid as they are (a task without a ladder
-- of its own follows the policy, a task without a limit in its own unit keeps `duration_working_days`). No contract step is planned: the columns stay empty for the tasks of templates that do not use the new fields.

-- R59, R73: the ladder of the three colours the FROZEN template of the project gives this very task. `band_tier` says where the ladder came from; only 'STEP' is ever stored (the other tiers are resolved from the policy in force when
-- the task is read, so a change of the policy moves the tasks that have no ladder of their own and no others). The unit is the one the source PROJECT_TASK declares (working days). A green line may be absent with a tier: everything
-- above yellow is green. The order is the strict one of DEADLINE_BAND_POLICY: green > yellow > red >= -1.
-- R58: the time limit of the task in its own unit, as the frozen template wrote it (`duration_working_days` keeps the nominal working days for the readers that came before), and the working days the task covers on the line of
-- the schedule as it was last placed (`effective_working_days`: NULL while it is unknown, for a task that has no dates and for the rows written before this migration until their schedule is published again).
-- R61 (written by a later piece of the same slice): the unit that receives the task (`LEAD`) and every unit the frozen template names for it, resolved when the workflow starts.
-- R72 (written by a later piece of the same slice): how many approved extensions the task has had and how much they added, in the unit of its limit.
ALTER TABLE machvon.project_task
  ADD COLUMN band_green_days integer,
  ADD COLUMN band_yellow_days integer,
  ADD COLUMN band_red_days integer,
  ADD COLUMN band_tier text,
  ADD COLUMN duration_value integer,
  ADD COLUMN duration_unit text,
  ADD COLUMN duration_roll boolean,
  ADD COLUMN effective_working_days integer,
  ADD COLUMN receiving_unit_id uuid,
  ADD COLUMN receiving_units jsonb,
  ADD COLUMN extension_times_used integer NOT NULL DEFAULT 0,
  ADD COLUMN extension_value_used integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT project_task_band_tier_chk CHECK (band_tier IS NULL OR band_tier IN ('STEP')),
  ADD CONSTRAINT project_task_band_ladder_chk CHECK (
    (band_tier IS NULL AND band_green_days IS NULL AND band_yellow_days IS NULL AND band_red_days IS NULL)
    OR (band_tier IS NOT NULL AND band_yellow_days IS NOT NULL AND band_red_days IS NOT NULL AND band_red_days >= -1 AND band_yellow_days > band_red_days AND (band_green_days IS NULL OR band_green_days > band_yellow_days))
  ),
  ADD CONSTRAINT project_task_duration_unit_chk CHECK (duration_unit IS NULL OR duration_unit IN ('WORKING_DAY', 'CALENDAR_DAY', 'MONTH')),
  ADD CONSTRAINT project_task_duration_chk CHECK (
    (duration_value IS NULL AND duration_unit IS NULL AND duration_roll IS NULL)
    OR (duration_value IS NOT NULL AND duration_unit IS NOT NULL AND duration_roll IS NOT NULL AND duration_value >= 1)
  ),
  ADD CONSTRAINT project_task_effective_days_chk CHECK (effective_working_days IS NULL OR effective_working_days >= 0),
  ADD CONSTRAINT project_task_receiving_units_chk CHECK (receiving_units IS NULL OR jsonb_typeof(receiving_units) = 'array'),
  ADD CONSTRAINT project_task_extension_used_chk CHECK (extension_times_used >= 0 AND extension_value_used >= 0),
  ADD CONSTRAINT project_task_receiving_unit_fk FOREIGN KEY (tenant_id, receiving_unit_id) REFERENCES machvon.organization_unit (tenant_id, id);

-- R73: the ladder of a task is written when its workflow is made and never afterwards: a newer version of the template, a reschedule or an edit of the task cannot change the colour a running project was promised. The limit of the
-- task (`duration_value`) is NOT frozen here: an approved extension raises it (R72); `effective_working_days` is written again by every publication of the schedule.
CREATE FUNCTION machvon.guard_project_task_band() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    RETURN NEW;
  END IF;
  IF (NEW.band_tier, NEW.band_green_days, NEW.band_yellow_days, NEW.band_red_days) IS DISTINCT FROM (OLD.band_tier, OLD.band_green_days, OLD.band_yellow_days, OLD.band_red_days) THEN
    RAISE EXCEPTION 'the deadline ladder of a project task is frozen when its workflow is made' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_task_band_guard BEFORE UPDATE ON machvon.project_task
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_task_band();

COMMENT ON COLUMN machvon.project_task.band_green_days IS 'Working days left at which the task turns green, from the frozen template (PWF-5, R59); NULL with a tier: everything above yellow is green.';
COMMENT ON COLUMN machvon.project_task.band_yellow_days IS 'Working days left at which the task turns yellow, from the frozen template (PWF-5, R59); NULL: the task follows the policy in force.';
COMMENT ON COLUMN machvon.project_task.band_red_days IS 'Working days left at which the task turns red, from the frozen template (PWF-5, R59); NULL: the task follows the policy in force.';
COMMENT ON COLUMN machvon.project_task.band_tier IS 'Where the stored ladder came from: STEP (the task of the frozen template); NULL: no ladder is stored, the tier is resolved from the policy when the task is read (PWF-5, R73).';
COMMENT ON COLUMN machvon.project_task.duration_value IS 'The time limit of the task in duration_unit, as the frozen template wrote it and approved extensions raised it (PWF-5, R58, R72); NULL: duration_working_days is the limit.';
COMMENT ON COLUMN machvon.project_task.duration_unit IS 'The unit of the time limit: WORKING_DAY, CALENDAR_DAY or MONTH (PWF-5, R58).';
COMMENT ON COLUMN machvon.project_task.duration_roll IS 'Whether a deadline that falls on a day nobody works rolls to the next working day (PWF-5, R58).';
COMMENT ON COLUMN machvon.project_task.effective_working_days IS 'The working days the task covers on the line of the schedule as last published (PWF-5, R58); NULL when the task has no dates or was not published since this column exists.';
COMMENT ON COLUMN machvon.project_task.receiving_unit_id IS 'The unit that receives the task (the LEAD line of responsible_units of the frozen template, resolved when the workflow starts; PWF-5, R61).';
COMMENT ON COLUMN machvon.project_task.receiving_units IS 'Every unit the frozen template names for the task, resolved when the workflow starts: [{unit_ref, unit_id, role, part}] (PWF-5, R61).';
COMMENT ON COLUMN machvon.project_task.extension_times_used IS 'How many approved extensions the task has had over the life of the workflow (PWF-5, R72).';
COMMENT ON COLUMN machvon.project_task.extension_value_used IS 'How much the approved extensions added to the limit of the task, in duration_unit (PWF-5, R72).';

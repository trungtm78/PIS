-- Authored by hand (not generated): the personal tier of the three-colour deadlines, the multi-point reminders of the tasks of a workflow and the source `PROJECT_TASK` of the alert centre (PWF-2, docs PWF 6, BR-PWF-20..24, 27, R30, R40).
-- Expand only: columns that may be NULL, one new table and one value more in the check of `work_action.source`; nothing that is read today changes.
--  - `alert_notification_profile` (V2003) keeps the choices of a person about alerts; the days at which THEY want the three colours to start and their own extra reminder days live in the same row. NULL is "the official one". The
--    official rule (DEADLINE_BAND_POLICY, source PROJECT_TASK) is read when the preference is saved and when it is read: a personal level may start earlier than the official one, never later (R40).
--  - `project_task_reminder` is the key that makes a reminder point fire once: the official points of the rule (`audience = 'OFFICIAL'`, `membership_id` NULL) once for each task and version of its schedule, the points a person
--    added (`audience = 'PERSONAL'`) once for each person. A point crossed together with a nearer one is recorded and not sent (`notified = false`). Appended only; the reminder itself is a row of `work_reminder`.
--  - `work_action.source` names the module an item comes from; a decision about an item of the new source (claim, assign, snooze) would be refused by the database if it were not in the check. The pass reads the check as it stands.

ALTER TABLE machvon.alert_notification_profile
  ADD COLUMN deadline_green_days integer CHECK (deadline_green_days IS NULL OR deadline_green_days BETWEEN 1 AND 3650),
  ADD COLUMN deadline_yellow_days integer CHECK (deadline_yellow_days IS NULL OR deadline_yellow_days BETWEEN 0 AND 3650),
  ADD COLUMN deadline_red_days integer CHECK (deadline_red_days IS NULL OR deadline_red_days BETWEEN -1 AND 3650),
  ADD COLUMN personal_reminder_days integer[] CHECK (personal_reminder_days IS NULL OR (cardinality(personal_reminder_days) BETWEEN 0 AND 6 AND array_ndims(personal_reminder_days) = 1 AND array_position(personal_reminder_days, NULL) IS NULL)),
  ADD CONSTRAINT alert_notification_profile_deadline_order_chk CHECK (
    (deadline_green_days IS NULL OR deadline_yellow_days IS NULL OR deadline_green_days > deadline_yellow_days)
    AND (deadline_yellow_days IS NULL OR deadline_red_days IS NULL OR deadline_yellow_days > deadline_red_days)
    AND (deadline_green_days IS NULL OR deadline_red_days IS NULL OR deadline_green_days > deadline_red_days)
  );

COMMENT ON COLUMN machvon.alert_notification_profile.deadline_green_days IS 'Days left at which a task turns green FOR THIS PERSON (their own list only, never the official colour, the escalation or a KPI); NULL: the official line. Never later than the official one.';
COMMENT ON COLUMN machvon.alert_notification_profile.personal_reminder_days IS 'Extra days-left at which this person wants a reminder of a task (decreasing, at most 6, none below the official red line); NULL or empty: only the reminders of the official rule.';

CREATE TABLE machvon.project_task_reminder (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  -- The version of the schedule the task had when the point fired: a task that is rescheduled has its points again.
  schedule_version integer NOT NULL CHECK (schedule_version >= 0),
  reminder_day integer NOT NULL CHECK (reminder_day BETWEEN -30 AND 365),
  audience text NOT NULL CHECK (audience IN ('OFFICIAL', 'PERSONAL')),
  membership_id uuid,
  -- The days left when the point was seen crossed, and the day of the person (Vietnam) it was seen on.
  remaining_days integer NOT NULL,
  fired_on date NOT NULL,
  -- False when a nearer point was crossed in the same pass: the earlier one is recorded, only the nearest is sent.
  notified boolean NOT NULL DEFAULT true,
  work_reminder_id uuid,
  fired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.project_task (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_task_reminder_audience_chk CHECK ((audience = 'OFFICIAL') = (membership_id IS NULL))
);

CREATE UNIQUE INDEX project_task_reminder_official_uq ON machvon.project_task_reminder (tenant_id, task_id, schedule_version, reminder_day) WHERE audience = 'OFFICIAL';
CREATE UNIQUE INDEX project_task_reminder_personal_uq ON machvon.project_task_reminder (tenant_id, task_id, schedule_version, reminder_day, membership_id) WHERE audience = 'PERSONAL';
CREATE INDEX project_task_reminder_task_idx ON machvon.project_task_reminder (tenant_id, task_id, fired_at);

ALTER TABLE machvon.project_task_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_task_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_task_reminder AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_task_reminder AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_task_reminder FROM machvon_app;

CREATE TRIGGER project_task_reminder_immutable BEFORE UPDATE OR DELETE ON machvon.project_task_reminder
  FOR EACH ROW EXECUTE FUNCTION machvon.pwf_forbid_change();

COMMENT ON TABLE machvon.project_task_reminder IS 'One row for each reminder point of a task that has fired (the key that stops a point firing twice, for each version of the schedule); appended only.';

DO $pwf2$
DECLARE
  definition text;
  constraint_name text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO constraint_name, definition
    FROM pg_constraint c
   WHERE c.conrelid = 'machvon.work_action'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%''ADVANCE''%' AND pg_get_constraintdef(c.oid) LIKE '%source%'
   LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'the check on work_action.source was not found';
  END IF;
  IF position('''PROJECT_TASK''' IN definition) = 0 THEN
    -- The definition reads CHECK ((source = ANY (ARRAY['A'::text, ...]))): the new source goes after the last value.
    definition := regexp_replace(definition, '\]\)\)\)\s*$', ', ''PROJECT_TASK''::text])))');
    EXECUTE format('ALTER TABLE machvon.work_action DROP CONSTRAINT %I', constraint_name);
    EXECUTE format('ALTER TABLE machvon.work_action ADD CONSTRAINT %I %s', constraint_name, definition);
  END IF;
END
$pwf2$;

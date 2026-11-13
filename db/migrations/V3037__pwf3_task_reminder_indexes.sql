-- Authored by hand (not generated): the indexes of the two foreign keys of the reminders of the tasks that the catalogue of the database asks for (PWF-3, expand step).
-- Every *_id column of a tenant table has an index that starts with the tenant; V3005 left membership_id and work_reminder_id without one, so the delete of a membership or a work reminder had to scan the reminders.

CREATE INDEX project_task_reminder_membership_idx ON machvon.project_task_reminder (tenant_id, membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX project_task_reminder_work_reminder_idx ON machvon.project_task_reminder (tenant_id, work_reminder_id) WHERE work_reminder_id IS NOT NULL;

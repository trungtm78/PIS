-- ST-ADM-013: the SLA of an approval task and the operations on a running approval (reassign, cancel). Additions only.

-- ---- the SLA clock of a task ------------------------------------------------------------------------------------------------------------
-- The point at 80 percent of the working time to the deadline (the reminder), when it was sent, the end of an overdue reminder (the next one is due a working day later) and when the task was escalated.
ALTER TABLE machvon.approval_task ADD COLUMN remind_at timestamptz;
ALTER TABLE machvon.approval_task ADD COLUMN reminded_at timestamptz;
ALTER TABLE machvon.approval_task ADD COLUMN next_reminder_at timestamptz;
ALTER TABLE machvon.approval_task ADD COLUMN overdue_reminders integer NOT NULL DEFAULT 0;
ALTER TABLE machvon.approval_task ADD COLUMN escalated_at timestamptz;
-- The task an escalation or a reassignment came from.
ALTER TABLE machvon.approval_task ADD COLUMN escalated_from_task_id uuid;
ALTER TABLE machvon.approval_task ADD COLUMN reassigned_from_task_id uuid;
ALTER TABLE machvon.approval_task
  ADD CONSTRAINT approval_task_escalated_from_fk FOREIGN KEY (tenant_id, escalated_from_task_id) REFERENCES machvon.approval_task (tenant_id, id),
  ADD CONSTRAINT approval_task_reassigned_from_fk FOREIGN KEY (tenant_id, reassigned_from_task_id) REFERENCES machvon.approval_task (tenant_id, id),
  ADD CONSTRAINT approval_task_sla_chk CHECK (overdue_reminders >= 0 AND (remind_at IS NULL OR remind_at <= due_at)) NOT VALID;
-- The tasks that are open when this runs get their reminder point too (80 percent of the time from their creation to their deadline), or they would never be reminded before the deadline.
UPDATE machvon.approval_task SET remind_at = created_at + (due_at - created_at) * 0.8 WHERE status = 'Pending' AND remind_at IS NULL;
-- The pass of the SLA job reads the open tasks by their deadline.
CREATE INDEX approval_task_pending_due_idx ON machvon.approval_task (tenant_id, due_at) WHERE status = 'Pending';
CREATE INDEX approval_task_escalated_from_idx ON machvon.approval_task (tenant_id, escalated_from_task_id);
CREATE INDEX approval_task_reassigned_from_idx ON machvon.approval_task (tenant_id, reassigned_from_task_id);

-- ---- an instance whose step ran out of time ----------------------------------------------------------------------------------------------
-- A step with on_timeout EXPIRE that can no longer reach the approvals it needs ends the instance as EXPIRED; the owning module is told by the completed event and the record stays as it was.
ALTER TABLE machvon.workflow_instance DROP CONSTRAINT IF EXISTS workflow_instance_outcome_check;
ALTER TABLE machvon.workflow_instance ADD CONSTRAINT workflow_instance_outcome_chk CHECK (outcome IS NULL OR outcome IN ('APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'GUARD_REJECTED', 'EXPIRED'));

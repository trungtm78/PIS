-- WF-1: the reminder of an approval task is an event type of the notification catalogue, so that a tenant can send it on the channels it chooses (the inbox, e-mail, Microsoft Teams) with a notification workflow of its own.
-- The engine raises it at 80 percent of the working time to the deadline of a task, and again every working day once the deadline is passed; the payload names the task, the step and the deadline, never the record or its figures.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'adm.approval_task.reminded.v1',
  'ADM',
  1,
  '{"type":"object","required":["task_id","instance_id","business_type","step_id","assignee_id","due_at","kind"],"properties":{"task_id":{"type":"string","format":"uuid"},"instance_id":{"type":"string","format":"uuid"},"business_type":{"type":"string"},"step_id":{"type":"string"},"assignee_id":{"type":"string","format":"uuid"},"due_at":{"type":"string"},"kind":{"type":"string","enum":["BEFORE_DUE","OVERDUE"]}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;

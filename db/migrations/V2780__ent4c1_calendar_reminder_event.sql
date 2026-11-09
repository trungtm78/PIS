-- Authored by hand (not generated): ENT-4c (customer requirement QT.02: reminders and overdue alerts). The reminder of a step of the reporting schedule is an event type of the notification catalogue, so that a tenant can send
-- it on the channels it chooses (the inbox, e-mail, Microsoft Teams) with a notification workflow of its own. The job `calendar-reminder` raises it before the deadline of a step, again once it is past, and once more to the leader of
-- the unit when the step is days overdue; the payload names the item (period, meeting or plan adjustment), the step and the deadline, never a figure.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'dis.calendar_step.reminded.v1',
  'DIS',
  1,
  '{"type":"object","required":["reminder_id","item_kind","item_key","step","kind","ordinal","due_at","alert_type"],"properties":{"reminder_id":{"type":"string","format":"uuid"},"item_kind":{"type":"string","enum":["REPORT_PERIOD","PLAN_ADJUSTMENT","MEETING"]},"item_key":{"type":"string"},"period_code":{"type":"string"},"unit_id":{"type":"string","format":"uuid"},"step":{"type":"string","enum":["ENTRY","UNIT_APPROVAL","PLANNING_REVIEW","PERIOD_CLOSE","PUSH"]},"kind":{"type":"string","enum":["BEFORE_DUE","OVERDUE"]},"ordinal":{"type":"integer"},"due_at":{"type":"string"},"days_overdue":{"type":"integer"},"alert_type":{"type":"string"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;

-- The escalation is its own event type: it goes to the leader of the unit, so a tenant routes it to other roles than the reminders with a workflow of its own.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'dis.calendar_step.escalated.v1',
  'DIS',
  1,
  '{"type":"object","required":["reminder_id","item_kind","item_key","step","kind","ordinal","due_at","alert_type"],"properties":{"reminder_id":{"type":"string","format":"uuid"},"item_kind":{"type":"string","enum":["REPORT_PERIOD","PLAN_ADJUSTMENT","MEETING"]},"item_key":{"type":"string"},"period_code":{"type":"string"},"unit_id":{"type":"string","format":"uuid"},"step":{"type":"string","enum":["ENTRY","UNIT_APPROVAL","PLANNING_REVIEW","PERIOD_CLOSE","PUSH"]},"kind":{"type":"string","enum":["ESCALATED"]},"ordinal":{"type":"integer"},"due_at":{"type":"string"},"days_overdue":{"type":"integer"},"alert_type":{"type":"string"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;

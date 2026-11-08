-- Authored by hand (not generated): the event types that carry a rung of the channel ladder into the notification workflows of the tenants (governance deepening, lane GOV-10, roadmap G2-6). One type per channel so that a
-- tenant publishes the workflow of each rung with the template and the channel plan it wants (the inbox, push, e-mail, Zalo, SMS). The payload names the kind of alert, its severity and a link inside the application that
-- needs a login; it never carries an amount, a percentage or the name of a contractor (the kernel refuses such a payload before the event is written). A tenant without a published workflow for a rung gets no message for it,
-- and the receipt of the rung says NO_WORKFLOW instead of pretending it was sent.

INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
SELECT gen_random_uuid(), 'home.alert_ladder_' || channel || '.v1', 'HOME', 1,
  '{"type":"object","required":["tenant_id","run_id","rung_id","alert_type","severity","deep_link"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"run_id":{"type":"string","format":"uuid"},"rung_id":{"type":"string","format":"uuid"},"alert_type":{"type":"string","pattern":"^[A-Z][A-Z0-9_]{1,63}$"},"severity":{"type":"string","enum":["URGENT","ACTION","WATCH"]},"deep_link":{"type":"string","pattern":"^/[A-Za-z0-9/_-]{1,120}$"}}}'::jsonb,
  ARRAY['OPERATIONAL', 'REMINDER'], 'INTERNAL', 'Active'
FROM unnest(ARRAY['in_app', 'push', 'email', 'zalo', 'sms']) AS channel
ON CONFLICT (event_type, schema_version) DO NOTHING;

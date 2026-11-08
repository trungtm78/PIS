-- Authored by hand (not generated): one rung of a channel ladder (governance deepening, lane GOV-10, roadmap G2-6) with its delivery receipt. A rung is sent by writing an event of the outbox in the same transaction as the row;
-- the notification workflows of the tenant turn the event into a notification and the delivery engine carries it; the receipt of the rung is read back from `notification_instance` and `delivery_attempt` (delivered, opened,
-- failed, suppressed) and written here, so the ladder, the screen and the KPI of the delivery of urgent alerts all read one fact. A rung that was not sent says why (`reason`): no consent, quiet hours, a cap, no contact,
-- no published workflow. The event of a rung carries a hint and a link, never a financial figure.

CREATE TABLE machvon.alert_ladder_rung (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  rung_index integer NOT NULL CHECK (rung_index BETWEEN 0 AND 9),
  channel text NOT NULL CHECK (channel IN ('IN_APP', 'PUSH', 'EMAIL', 'ZALO', 'SMS')),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'SENT', 'DELIVERED', 'SEEN', 'FAILED', 'SUPPRESSED')),
  reason text CHECK (reason IS NULL OR reason IN ('NO_CONSENT', 'QUIET_HOURS', 'DAILY_CAP', 'NO_CONTACT', 'NO_WORKFLOW', 'PROFILE')),
  sent_at timestamptz,
  receipt_at timestamptz,
  event_key text CHECK (event_key IS NULL OR (event_key = btrim(event_key) AND char_length(event_key) BETWEEN 1 AND 200)),
  outbox_event_id uuid,
  notification_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES machvon.alert_ladder_run (tenant_id, id),
  CONSTRAINT alert_ladder_rung_index_uq UNIQUE (tenant_id, run_id, rung_index),
  CONSTRAINT alert_ladder_rung_reason_chk CHECK ((state = 'SUPPRESSED') = (reason IS NOT NULL)),
  CONSTRAINT alert_ladder_rung_receipt_chk CHECK (receipt_at IS NULL OR state IN ('DELIVERED', 'SEEN'))
);

CREATE INDEX alert_ladder_rung_run_idx ON machvon.alert_ladder_rung (tenant_id, run_id, rung_index);
CREATE INDEX alert_ladder_rung_open_idx ON machvon.alert_ladder_rung (tenant_id, state, sent_at) WHERE state IN ('QUEUED', 'SENT', 'DELIVERED');
CREATE INDEX alert_ladder_rung_event_idx ON machvon.alert_ladder_rung (tenant_id, outbox_event_id) WHERE outbox_event_id IS NOT NULL;
CREATE INDEX alert_ladder_rung_notification_idx ON machvon.alert_ladder_rung (tenant_id, notification_id) WHERE notification_id IS NOT NULL;

ALTER TABLE machvon.alert_ladder_rung ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_ladder_rung FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_ladder_rung AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_ladder_rung AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.alert_ladder_rung FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.alert_ladder_rung FROM machvon_app;
GRANT UPDATE (state, reason, sent_at, receipt_at, outbox_event_id, notification_id, updated_at) ON TABLE machvon.alert_ladder_rung TO machvon_app;

COMMENT ON TABLE machvon.alert_ladder_rung IS 'One rung of a channel ladder with its delivery receipt (sent, delivered, seen, failed, suppressed and why); the receipt is read back from the delivery engine.';

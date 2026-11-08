-- Authored by hand (not generated): the storms of the alert centre (governance deepening, lane GOV-10, roadmap G2-11). When a person gets more new alerts in an hour than the rule `ALERT_FLOOD_POLICY` allows, the centre
-- is in a storm for that person: the new alerts below the urgent level are shown as grouped summary cards and the urgent ones stay apart. The storm ends when the number falls below the end threshold (a second,
-- lower number, so that it does not flap). A storm is a row with its start and its end, so the time spent in storms (the KPI of the alert health) is measured, not guessed.

CREATE TABLE machvon.alert_flood_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  peak_new integer NOT NULL CHECK (peak_new >= 0),
  window_minutes integer NOT NULL CHECK (window_minutes >= 1),
  start_threshold integer NOT NULL CHECK (start_threshold >= 1),
  end_threshold integer NOT NULL CHECK (end_threshold >= 0),
  grouped_count integer NOT NULL DEFAULT 0 CHECK (grouped_count >= 0),
  policy_version text NOT NULL CHECK (policy_version = btrim(policy_version) AND char_length(policy_version) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT alert_flood_event_end_chk CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One storm is open for a person at a time.
CREATE UNIQUE INDEX alert_flood_event_open_uq ON machvon.alert_flood_event (tenant_id, membership_id) WHERE ended_at IS NULL;
CREATE INDEX alert_flood_event_time_idx ON machvon.alert_flood_event (tenant_id, started_at DESC);
CREATE INDEX alert_flood_event_member_idx ON machvon.alert_flood_event (tenant_id, membership_id, started_at DESC);

ALTER TABLE machvon.alert_flood_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_flood_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_flood_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_flood_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.alert_flood_event FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.alert_flood_event FROM machvon_app;
GRANT UPDATE (ended_at, peak_new, grouped_count) ON TABLE machvon.alert_flood_event TO machvon_app;

COMMENT ON TABLE machvon.alert_flood_event IS 'A storm of new alerts for one person: its start, its end and its peak; one is open for a person at a time.';

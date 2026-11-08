-- Authored by hand (not generated): how a person is reached about alerts, and the record of every decision to tell them (governance deepening, lane GOV-9a, roadmap G2-5).
-- `alert_notification_profile`: the choices of one person (channels by severity, quiet hours, the morning digest, the threshold and the cap of pushes); whatever is NULL is the policy's (`ALERT_NOTIFY_POLICY`). The bell of the
-- application is not a choice: it always tells the truth. The quiet hours in NOT-03 (`notification_preference_profile`) stay for the other notifications; for alerts the alert profile wins when it has them.
-- `alert_notification_log`: one row for each decision of the job about telling a person of an occasion (a new item, a reminder, a level of escalation, the digest): what was decided for each channel, whether it was sent inside the quiet
-- hours and by what allowance. It is the source of the pushes-per-person and the out-of-hours indicators and is appended, never changed. A push carries no amounts and no names: the log keeps ids and decisions, never words.

CREATE TABLE machvon.alert_notification_profile (
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  channels jsonb CHECK (channels IS NULL OR jsonb_typeof(channels) = 'object'),
  quiet_from time,
  quiet_to time,
  quiet_weekends boolean,
  quiet_time_zone text CHECK (quiet_time_zone IS NULL OR (quiet_time_zone <> '' AND char_length(quiet_time_zone) <= 64)),
  digest_enabled boolean NOT NULL DEFAULT true,
  digest_at time,
  push_min_severity text CHECK (push_min_severity IS NULL OR push_min_severity IN ('URGENT', 'ACTION')),
  push_cap_per_day integer CHECK (push_cap_per_day IS NULL OR push_cap_per_day BETWEEN 0 AND 100),
  group_same_root boolean,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT alert_notification_profile_quiet_chk CHECK (
    (quiet_from IS NULL AND quiet_to IS NULL AND quiet_weekends IS NULL AND quiet_time_zone IS NULL)
    OR (quiet_from IS NOT NULL AND quiet_to IS NOT NULL AND quiet_weekends IS NOT NULL AND quiet_time_zone IS NOT NULL AND quiet_from <> quiet_to)
  )
);

CREATE TABLE machvon.alert_notification_log (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_membership_id uuid NOT NULL,
  occasion text NOT NULL CHECK (occasion IN ('NEW_ITEM', 'REMINDER', 'ESCALATION', 'RECLAIM', 'DIGEST')),
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  source text CHECK (source IS NULL OR source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  source_id text CHECK (source_id IS NULL OR (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 64)),
  channel text NOT NULL CHECK (channel IN ('PUSH', 'EMAIL', 'SMS', 'ZALO', 'DIGEST')),
  decision text NOT NULL CHECK (decision IN ('SEND_NOW', 'SEND_GROUPED', 'HOLD_QUIET', 'DIGEST', 'SKIP_CAP', 'SKIP_THRESHOLD', 'SKIP_CONSENT')),
  hold_until timestamptz,
  bypass text CHECK (bypass IS NULL OR bypass IN ('URGENT_UNCLAIMED')),
  in_quiet boolean NOT NULL DEFAULT false,
  -- The day of the person (their zone) the decision was made on: the day the daily cap counts.
  local_day date NOT NULL,
  series_key text NOT NULL CHECK (series_key = btrim(series_key) AND char_length(series_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT alert_notification_log_series_uq UNIQUE (tenant_id, series_key),
  -- A notice that broke the quiet hours always carries the allowance that let it.
  CONSTRAINT alert_notification_log_quiet_chk CHECK (NOT in_quiet OR bypass IS NOT NULL)
);

CREATE INDEX alert_notification_log_day_idx ON machvon.alert_notification_log (tenant_id, recipient_membership_id, local_day, decision);
CREATE INDEX alert_notification_log_created_idx ON machvon.alert_notification_log (tenant_id, created_at DESC);

DO $gov9$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['alert_notification_profile', 'alert_notification_log'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, tbl);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, tbl);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE machvon.%I FROM machvon_app', tbl);
  END LOOP;
END
$gov9$;

REVOKE UPDATE ON TABLE machvon.alert_notification_log FROM machvon_app;

COMMENT ON TABLE machvon.alert_notification_profile IS 'The choices of one person about how alerts reach them; NULL is the policy ALERT_NOTIFY_POLICY. The bell of the application is not a choice.';
COMMENT ON TABLE machvon.alert_notification_log IS 'Every decision to tell a person of an alert, per channel: sent, held in the quiet hours, digested, capped; append-only, ids and decisions only, never words.';

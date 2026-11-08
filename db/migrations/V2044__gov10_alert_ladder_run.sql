-- Authored by hand (not generated): the channel ladder of an alert for one person (governance deepening, lane GOV-10, roadmap G2-6). The delivery engine of notifications already retries a send and falls back to the next channel
-- of a plan when a channel fails; the ladder is about the alert: an urgent alert goes to the person in the application, then by push, and when nobody has seen it after the wait of a rung it goes to Zalo, then SMS,
-- and at the end the escalation takes over. A run is the ladder of one alert item for one recipient; its rungs are in `alert_ladder_rung`. The policy that governed (the rule `ALERT_CHANNEL_LADDER` of the severity) is kept on
-- the run as it was, with its version, so a run can be explained after the rule changed. One run is active for an item and a person at a time; a run that ended is never reopened (a new one starts if the item needs it).
-- Prefixed `alert_ladder_` on purpose: the per-person notification profiles, the escalation and the alert health page are another lane (GOV-9a) and keep their own tables.

CREATE TABLE machvon.alert_ladder_run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  source_id text NOT NULL CHECK (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 200),
  recipient_membership_id uuid NOT NULL,
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  alert_type_code text CHECK (alert_type_code IS NULL OR alert_type_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  policy_version text NOT NULL CHECK (policy_version = btrim(policy_version) AND char_length(policy_version) BETWEEN 1 AND 40),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'DONE', 'ESCALATED', 'EXHAUSTED', 'EXPIRED')),
  -- How a finished ladder ended: a receipt of the kind the policy wants, a person took the alert up, or its condition cleared.
  done_by text CHECK (done_by IS NULL OR done_by IN ('RECEIPT', 'ACTED', 'CLEARED')),
  started_at timestamptz NOT NULL,
  next_at timestamptz NOT NULL,
  escalated_at timestamptz,
  ended_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT alert_ladder_run_end_chk CHECK ((state = 'ACTIVE') = (ended_at IS NULL)),
  CONSTRAINT alert_ladder_run_done_chk CHECK ((state = 'DONE') = (done_by IS NOT NULL)),
  CONSTRAINT alert_ladder_run_escalated_chk CHECK ((state = 'ESCALATED') = (escalated_at IS NOT NULL))
);

-- One active ladder for an item and a person.
CREATE UNIQUE INDEX alert_ladder_run_active_uq ON machvon.alert_ladder_run (tenant_id, source, source_id, recipient_membership_id) WHERE state = 'ACTIVE';
CREATE INDEX alert_ladder_run_due_idx ON machvon.alert_ladder_run (tenant_id, next_at, id) WHERE state = 'ACTIVE';
CREATE INDEX alert_ladder_run_item_idx ON machvon.alert_ladder_run (tenant_id, source_id, source, started_at DESC);
CREATE INDEX alert_ladder_run_recipient_idx ON machvon.alert_ladder_run (tenant_id, recipient_membership_id, started_at DESC);
CREATE INDEX alert_ladder_run_time_idx ON machvon.alert_ladder_run (tenant_id, started_at DESC, severity);

ALTER TABLE machvon.alert_ladder_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_ladder_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_ladder_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_ladder_run AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- What the run was (item, person, severity, the policy that governed, when it started) never changes; only where it stands does.
REVOKE DELETE, TRUNCATE ON TABLE machvon.alert_ladder_run FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.alert_ladder_run FROM machvon_app;
GRANT UPDATE (state, done_by, next_at, escalated_at, ended_at, version) ON TABLE machvon.alert_ladder_run TO machvon_app;

COMMENT ON TABLE machvon.alert_ladder_run IS 'The channel ladder of one alert item for one person: the policy that governed, where the ladder stands, how it ended; never deleted.';

-- Authored by hand (not generated): what the alert centre recorded about the life of each item (governance deepening, lane GOV-9a, roadmap G2-10 and G2-3).
-- The items of the alert centre are read from the tables of the modules each time the list is asked for, so nothing remembered when an item first appeared, when somebody took it up, when it was closed or how far it went up
-- a chain. The job `alert-escalation` writes one row for each item it sees (a pass of every active member, every 15 minutes): the first time it saw it, when it began, severity, who owns it, the claim, the closing (RESOLVED when
-- its own state says so, CLEARED when it no longer appears while its source could be read), the highest escalation level and the count of postponements. The health page of the alert system (G2-10) computes its indicators from here:
-- the moments are those of the passes, so a figure is as exact as a quarter of an hour. A row is changed only by the job; it is never deleted by the application.

CREATE TABLE machvon.alert_item_trace (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  source_id text NOT NULL CHECK (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- The alert type of the registry (`ALERT_TYPE`) when the item has one, else the kind.
  type_code text NOT NULL CHECK (type_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- How the item was shown to its owner and where it is opened: what a level of escalation (or a notice to the leadership of an owner who left) needs to show it to somebody else.
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 300),
  subtitle text CHECK (subtitle IS NULL OR char_length(subtitle) <= 300),
  due_on date,
  target_screen text NOT NULL CHECK (target_screen ~ '^[A-Z]{2,4}-[0-9]{2}$'),
  target_id text NOT NULL CHECK (target_id = btrim(target_id) AND char_length(target_id) BETWEEN 1 AND 64),
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  severity_first text NOT NULL CHECK (severity_first IN ('URGENT', 'ACTION', 'WATCH')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('NEW', 'CLAIMED', 'IN_PROGRESS')),
  owner_membership_id uuid,
  owner_unit_id uuid,
  started_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  first_claim_at timestamptz,
  -- The end of the resolve clock and of the claim clock as the last pass counted them (null when the module gives none).
  due_at timestamptz,
  claim_due_at timestamptz,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RESOLVED', 'CLEARED')),
  closed_at timestamptz,
  last_change_at timestamptz NOT NULL,
  max_escalation_level integer NOT NULL DEFAULT 0 CHECK (max_escalation_level BETWEEN 0 AND 5),
  levels_configured integer NOT NULL DEFAULT 0 CHECK (levels_configured BETWEEN 0 AND 5),
  snooze_count integer NOT NULL DEFAULT 0 CHECK (snooze_count >= 0),
  reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  promoted boolean NOT NULL DEFAULT false,
  -- The pauses of the clocks of the item, as {"from": ..., "until": ...} instants (what the time to resolve takes away).
  pauses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pauses) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  CONSTRAINT alert_item_trace_item_uq UNIQUE (tenant_id, source, source_id),
  CONSTRAINT alert_item_trace_closed_chk CHECK ((state = 'OPEN') = (closed_at IS NULL))
);

CREATE INDEX alert_item_trace_state_idx ON machvon.alert_item_trace (tenant_id, state, last_seen_at);
CREATE INDEX alert_item_trace_owner_idx ON machvon.alert_item_trace (tenant_id, owner_membership_id, state) WHERE owner_membership_id IS NOT NULL;
CREATE INDEX alert_item_trace_unit_idx ON machvon.alert_item_trace (tenant_id, owner_unit_id, state) WHERE owner_unit_id IS NOT NULL;
CREATE INDEX alert_item_trace_seen_idx ON machvon.alert_item_trace (tenant_id, first_seen_at);
CREATE INDEX alert_item_trace_source_idx ON machvon.alert_item_trace (tenant_id, source_id);
CREATE INDEX alert_item_trace_closed_idx ON machvon.alert_item_trace (tenant_id, closed_at) WHERE closed_at IS NOT NULL;

ALTER TABLE machvon.alert_item_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_item_trace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_item_trace AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_item_trace AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.alert_item_trace FROM machvon_app;

COMMENT ON TABLE machvon.alert_item_trace IS 'The life of each item of the alert centre as the job alert-escalation saw it: first seen, claimed, closed, escalated; the source of the health indicators of the alert system.';

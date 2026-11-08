-- Authored by hand (not generated): the levels an item of the alert centre has been sent up (governance deepening, lane GOV-9a, roadmap G2-3).
-- One row for each person who received a level (a function is a team: one row for each member), and one row when an item that was only to be watched is raised one step (PROMOTION, with the reason). A row is appended by the job
-- `alert-escalation` together with the event of the outbox that carries it; `series_key` names the one row of a level and a person, so a pass that runs twice, or two that run at once, record it once. A recipient acknowledges the row
-- (which holds the later levels for the time the policy gives); the row is CLOSED when the item is resolved or no longer appears. Only the state of a row changes, along OPEN, ACKNOWLEDGED, CLOSED, and nothing else about it ever does.

CREATE TABLE machvon.alert_escalation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  source_id text NOT NULL CHECK (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 64),
  level integer NOT NULL CHECK (level BETWEEN 0 AND 5),
  kind text NOT NULL CHECK (kind IN ('FUNCTIONAL', 'HIERARCHICAL', 'PROMOTION')),
  trigger text NOT NULL CHECK (trigger IN ('NOT_CLAIMED', 'NO_PROGRESS', 'OVERDUE', 'ORPHANED', 'WATCH_AGED')),
  -- The person who receives the level (null for a promotion), the owner of the item at the time, and how the recipient was found.
  recipient_membership_id uuid,
  owner_membership_id uuid,
  routed_via text NOT NULL CHECK (routed_via IN ('PRIMARY', 'FALLBACK_HIERARCHY', 'FALLBACK_ADMIN', 'DEPUTY', 'NONE')),
  cover_id uuid,
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  from_severity text CHECK (from_severity IS NULL OR from_severity IN ('URGENT', 'ACTION', 'WATCH')),
  -- What the recipient needs to open the item: a snapshot of how it was shown to its owner, and where it is opened.
  item_title text NOT NULL CHECK (item_title = btrim(item_title) AND char_length(item_title) BETWEEN 1 AND 300),
  item_subtitle text CHECK (item_subtitle IS NULL OR char_length(item_subtitle) <= 300),
  item_due_on date,
  target_screen text NOT NULL CHECK (target_screen ~ '^[A-Z]{2,4}-[0-9]{2}$'),
  target_id text NOT NULL CHECK (target_id = btrim(target_id) AND char_length(target_id) BETWEEN 1 AND 64),
  -- The moment the level was due by the clocks, and the moment the pass recorded it (the difference is how late the pass was).
  reached_at timestamptz NOT NULL,
  policy_version text NOT NULL CHECK (policy_version = btrim(policy_version) AND char_length(policy_version) BETWEEN 1 AND 40),
  series_key text NOT NULL CHECK (series_key = btrim(series_key) AND char_length(series_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'CLOSED')),
  acknowledged_at timestamptz,
  closed_at timestamptz,
  close_reason text CHECK (close_reason IS NULL OR close_reason IN ('RESOLVED', 'SOURCE_CLEARED', 'OWNER_BACK')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT alert_escalation_series_uq UNIQUE (tenant_id, series_key),
  CONSTRAINT alert_escalation_shape_chk CHECK (
    (kind = 'PROMOTION' AND level = 0 AND recipient_membership_id IS NULL AND from_severity IS NOT NULL AND trigger = 'WATCH_AGED' AND routed_via = 'NONE')
    OR (kind <> 'PROMOTION' AND level >= 1 AND recipient_membership_id IS NOT NULL AND from_severity IS NULL AND trigger <> 'WATCH_AGED' AND routed_via <> 'NONE')
  ),
  CONSTRAINT alert_escalation_state_chk CHECK (
    (status = 'OPEN' AND acknowledged_at IS NULL AND closed_at IS NULL AND close_reason IS NULL)
    OR (status = 'ACKNOWLEDGED' AND acknowledged_at IS NOT NULL AND closed_at IS NULL AND close_reason IS NULL)
    OR (status = 'CLOSED' AND closed_at IS NOT NULL AND close_reason IS NOT NULL)
  )
);

CREATE INDEX alert_escalation_item_idx ON machvon.alert_escalation (tenant_id, source_id, source, level);
CREATE INDEX alert_escalation_recipient_idx ON machvon.alert_escalation (tenant_id, recipient_membership_id, status, created_at DESC) WHERE recipient_membership_id IS NOT NULL;
CREATE INDEX alert_escalation_owner_idx ON machvon.alert_escalation (tenant_id, owner_membership_id) WHERE owner_membership_id IS NOT NULL;
CREATE INDEX alert_escalation_cover_idx ON machvon.alert_escalation (tenant_id, cover_id) WHERE cover_id IS NOT NULL;
CREATE INDEX alert_escalation_status_idx ON machvon.alert_escalation (tenant_id, status, created_at DESC);

ALTER TABLE machvon.alert_escalation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_escalation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_escalation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_escalation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.alert_escalation FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.alert_escalation FROM machvon_app;
GRANT UPDATE (status, acknowledged_at, closed_at, close_reason) ON TABLE machvon.alert_escalation TO machvon_app;

-- The state of a row only moves forward: OPEN, then ACKNOWLEDGED, then CLOSED, or OPEN straight to CLOSED; a closed row is final and what a row says about the item never changes.
CREATE FUNCTION machvon.guard_alert_escalation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed escalation is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status AND NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'an escalation is acknowledged once and closed once' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'OPEN' THEN
    RAISE EXCEPTION 'an acknowledged escalation does not open again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER alert_escalation_guard BEFORE UPDATE ON machvon.alert_escalation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_alert_escalation();

COMMENT ON TABLE machvon.alert_escalation IS 'The levels an item of the alert centre was sent up (functional or hierarchical) and the promotions of items to be watched; appended by the job, only the state moves.';

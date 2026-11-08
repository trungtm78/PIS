-- Authored by hand (not generated): the places where an alert has nobody valid to receive it (governance deepening, lane GOV-9a, roadmap G2-7).
-- A gap is opened by the job `alert-coverage` and closed when the cause is gone (the person is back, a cover is in force, the chain has someone again), so the time to reroute can be measured. Kinds: ABSENT_NO_COVER (a person is away
-- with no cover for all sources in force), ABSENCE_STARTING_UNCOVERED (an absence starts soon and no cover was proposed), OWNER_INACTIVE (the owner of open items has left), NO_LEADER (the escalation found no leadership for the owner),
-- FUNCTION_VACANT (a function that a level names has nobody), POSITION_UNCOVERED (a position of leadership has no one present and no cover). The first three that leave an alert with nobody are what the health page counts as orphaned.
-- `subject_key` names the one open gap of a cause: opening it twice opens it once.

CREATE TABLE machvon.alert_routing_gap (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('ABSENT_NO_COVER', 'ABSENCE_STARTING_UNCOVERED', 'OWNER_INACTIVE', 'NO_LEADER', 'FUNCTION_VACANT', 'POSITION_UNCOVERED')),
  subject_key text NOT NULL CHECK (subject_key = btrim(subject_key) AND char_length(subject_key) BETWEEN 1 AND 200),
  membership_id uuid,
  unit_id uuid,
  absence_id uuid,
  -- How many open alerts the gap leaves without a valid recipient (at least one).
  item_count integer NOT NULL DEFAULT 1 CHECK (item_count >= 1),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  close_reason text CHECK (close_reason IS NULL OR close_reason IN ('COVERED', 'BACK', 'RESOLVED', 'ABSENCE_ENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_id) REFERENCES machvon.alert_absence (tenant_id, id),
  CONSTRAINT alert_routing_gap_closed_chk CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);

CREATE UNIQUE INDEX alert_routing_gap_open_uq ON machvon.alert_routing_gap (tenant_id, subject_key) WHERE closed_at IS NULL;
CREATE INDEX alert_routing_gap_member_idx ON machvon.alert_routing_gap (tenant_id, membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX alert_routing_gap_unit_idx ON machvon.alert_routing_gap (tenant_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX alert_routing_gap_absence_idx ON machvon.alert_routing_gap (tenant_id, absence_id) WHERE absence_id IS NOT NULL;
CREATE INDEX alert_routing_gap_time_idx ON machvon.alert_routing_gap (tenant_id, opened_at DESC);

ALTER TABLE machvon.alert_routing_gap ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_routing_gap FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_routing_gap AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_routing_gap AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.alert_routing_gap FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.alert_routing_gap FROM machvon_app;
GRANT UPDATE (item_count, closed_at, close_reason) ON TABLE machvon.alert_routing_gap TO machvon_app;

COMMENT ON TABLE machvon.alert_routing_gap IS 'Places where an alert has no valid recipient (absent with no cover, owner gone, no leadership); opened and closed by the job so the time to reroute is measured.';

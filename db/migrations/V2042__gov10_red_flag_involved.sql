-- Authored by hand (not generated): who took part in the procurement or the contract a red-flag finding is about (governance deepening, lane GOV-10, roadmap G4-3). A person who is in this table for a finding never sees that
-- finding, a count that includes it, or an alert about it: a signal about a procurement is not shown to the people who are assessed by it. The table is DERIVED: every evaluation rebuilds the set of a finding from the facts
-- of BID, CTR and PRJ (the drafter, the panel who declared on conflicts, the people who moved the workflow, approved the result or signed the contract, the leader accountable for the project), so a row is replaced, not edited.

CREATE TABLE machvon.red_flag_involved (
  tenant_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  -- Why the person is on the list (for the audit of the rule, never shown to the person): DRAFTER, PANEL, WORKFLOW, RESULT, CONTRACT, ACCOUNTABLE_LEADER.
  role text NOT NULL CHECK (role ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  derived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, finding_id, membership_id, role),
  FOREIGN KEY (tenant_id, finding_id) REFERENCES machvon.red_flag_finding (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX red_flag_involved_member_idx ON machvon.red_flag_involved (tenant_id, membership_id, finding_id);
CREATE INDEX red_flag_involved_finding_idx ON machvon.red_flag_involved (tenant_id, finding_id);

ALTER TABLE machvon.red_flag_involved ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.red_flag_involved FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.red_flag_involved AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.red_flag_involved AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Derived data: a row is replaced when the facts change, so the application role may delete (the set of a finding is rebuilt) but never update.
REVOKE UPDATE, TRUNCATE ON TABLE machvon.red_flag_involved FROM machvon_app;

COMMENT ON TABLE machvon.red_flag_involved IS 'The people who took part in the procurement or contract of a red-flag finding; derived at each evaluation; they never see the finding.';

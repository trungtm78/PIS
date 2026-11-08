-- Authored by hand (not generated): the gifts register (GOV-12, G4-12 should-have part, practice K17). A gift that a person received because of the work is declared; the policy (GIFT_RULE) says by which day, from which value a
-- second person reviews it and above which value it may not be kept. The flags are computed by the application at declaration with the rule of that day and stored with its version, so the register of a past year reads as it was.
-- The reviewer is never the recipient; a gift over the keep line is closed as RETURNED or HANDED_TO_UNIT only.

CREATE TABLE machvon.gift_register (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_membership_id uuid NOT NULL,
  declared_by uuid NOT NULL,
  giver_name text NOT NULL CHECK (giver_name = btrim(giver_name) AND char_length(giver_name) BETWEEN 1 AND 200),
  giver_kind text NOT NULL CHECK (giver_kind IN ('CONTRACTOR', 'SUPPLIER', 'OFFICIAL', 'COMMUNITY', 'OTHER')),
  project_id uuid,
  description text NOT NULL CHECK (description = btrim(description) AND char_length(description) BETWEEN 5 AND 1000),
  value_vnd numeric(18, 0) NOT NULL CHECK (value_vnd >= 0),
  received_on date NOT NULL,
  declared_on date NOT NULL,
  declare_due_on date NOT NULL,
  late boolean NOT NULL,
  needs_review boolean NOT NULL,
  may_be_kept boolean NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  status text NOT NULL DEFAULT 'DECLARED' CHECK (status IN ('DECLARED', 'UNDER_REVIEW', 'CLOSED')),
  reviewer_membership_id uuid,
  outcome text CHECK (outcome IS NULL OR outcome IN ('KEPT', 'RETURNED', 'HANDED_TO_UNIT')),
  outcome_note text CHECK (outcome_note IS NULL OR (outcome_note = btrim(outcome_note) AND char_length(outcome_note) BETWEEN 5 AND 1000)),
  closed_on date,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, declared_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT gift_register_dates_chk CHECK (declared_on >= received_on AND declare_due_on >= received_on AND late = (declared_on > declare_due_on) AND (closed_on IS NULL OR closed_on >= declared_on)),
  CONSTRAINT gift_register_reviewer_chk CHECK (reviewer_membership_id IS NULL OR reviewer_membership_id <> recipient_membership_id),
  CONSTRAINT gift_register_closed_chk CHECK ((status = 'CLOSED') = (outcome IS NOT NULL) AND (outcome IS NULL) = (closed_on IS NULL) AND (outcome IS NULL OR (reviewer_membership_id IS NOT NULL AND outcome_note IS NOT NULL))),
  CONSTRAINT gift_register_keep_chk CHECK (outcome IS DISTINCT FROM 'KEPT' OR may_be_kept),
  CONSTRAINT gift_register_review_chk CHECK (status = 'DECLARED' OR reviewer_membership_id IS NOT NULL)
);
CREATE INDEX gift_register_status_idx ON machvon.gift_register (tenant_id, status, declared_on DESC, id);
CREATE INDEX gift_register_recipient_idx ON machvon.gift_register (tenant_id, recipient_membership_id, declared_on DESC);
CREATE INDEX gift_register_declared_by_idx ON machvon.gift_register (tenant_id, declared_by);
CREATE INDEX gift_register_project_idx ON machvon.gift_register (tenant_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX gift_register_reviewer_idx ON machvon.gift_register (tenant_id, reviewer_membership_id) WHERE reviewer_membership_id IS NOT NULL;
ALTER TABLE machvon.gift_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.gift_register FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.gift_register AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.gift_register AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE, UPDATE ON TABLE machvon.gift_register FROM machvon_app;
GRANT UPDATE (status, reviewer_membership_id, outcome, outcome_note, closed_on, version) ON TABLE machvon.gift_register TO machvon_app;

COMMENT ON TABLE machvon.gift_register IS 'Gifts declared by staff: the flags are those of the rule of the day of declaration; a second person closes it; a gift over the keep line is never kept.';

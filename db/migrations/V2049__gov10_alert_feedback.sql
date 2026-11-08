-- Authored by hand (not generated): the "this alert is wrong" report of a person about an item of the alert centre, and the review of it by the owner of the alert type (governance deepening, lane GOV-10, roadmap G2-9).
-- A report never hides or silences anything: the item stays in the list and only shows that it was reported. What a report can lead to is a proposal to tune the rule of the type, which goes through the governance
-- rules (maker and checker) like any other change; `governance_rule_id` names the draft when the reviewer made one. The reviewer is never the reporter. The words of a note are kept here only; they are not in an audit
-- row or an event. One report of a person about an item is open at a time.

CREATE TABLE machvon.alert_feedback (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  source_id text NOT NULL CHECK (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 200),
  alert_type_code text NOT NULL CHECK (alert_type_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  reporter_membership_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('NOT_APPLICABLE', 'WRONG_DATA', 'DUPLICATE', 'ALREADY_HANDLED', 'NOT_MY_ROLE', 'TOO_EARLY', 'OTHER')),
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 500)),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED_FOR_TUNING', 'REJECTED', 'DUPLICATE_OF', 'WITHDRAWN')),
  reviewer_membership_id uuid,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR (review_note = btrim(review_note) AND char_length(review_note) BETWEEN 1 AND 500)),
  proposal_note text CHECK (proposal_note IS NULL OR (proposal_note = btrim(proposal_note) AND char_length(proposal_note) BETWEEN 1 AND 500)),
  governance_rule_id uuid,
  duplicate_of_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, reporter_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, governance_rule_id) REFERENCES machvon.governance_rule (tenant_id, id),
  FOREIGN KEY (tenant_id, duplicate_of_id) REFERENCES machvon.alert_feedback (tenant_id, id),
  CONSTRAINT alert_feedback_reviewer_chk CHECK (reviewer_membership_id IS NULL OR reviewer_membership_id <> reporter_membership_id),
  CONSTRAINT alert_feedback_other_note_chk CHECK (reason <> 'OTHER' OR note IS NOT NULL),
  CONSTRAINT alert_feedback_review_chk CHECK (
    (status IN ('PENDING', 'WITHDRAWN') AND reviewer_membership_id IS NULL AND reviewed_at IS NULL)
    OR (status IN ('ACCEPTED_FOR_TUNING', 'REJECTED', 'DUPLICATE_OF') AND reviewer_membership_id IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT alert_feedback_duplicate_chk CHECK ((status = 'DUPLICATE_OF') = (duplicate_of_id IS NOT NULL)),
  CONSTRAINT alert_feedback_reject_note_chk CHECK (status <> 'REJECTED' OR review_note IS NOT NULL)
);

-- One open report of a person about an item.
CREATE UNIQUE INDEX alert_feedback_open_uq ON machvon.alert_feedback (tenant_id, source, source_id, reporter_membership_id) WHERE status = 'PENDING';
CREATE INDEX alert_feedback_queue_idx ON machvon.alert_feedback (tenant_id, status, alert_type_code, created_at, id);
CREATE INDEX alert_feedback_item_idx ON machvon.alert_feedback (tenant_id, source_id, source);
CREATE INDEX alert_feedback_reporter_idx ON machvon.alert_feedback (tenant_id, reporter_membership_id, created_at DESC);
CREATE INDEX alert_feedback_reviewer_idx ON machvon.alert_feedback (tenant_id, reviewer_membership_id) WHERE reviewer_membership_id IS NOT NULL;
CREATE INDEX alert_feedback_rule_idx ON machvon.alert_feedback (tenant_id, governance_rule_id) WHERE governance_rule_id IS NOT NULL;
CREATE INDEX alert_feedback_duplicate_idx ON machvon.alert_feedback (tenant_id, duplicate_of_id) WHERE duplicate_of_id IS NOT NULL;

ALTER TABLE machvon.alert_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_feedback AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_feedback AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- A report is not edited after it is made except by its own moves (withdrawn by the reporter, decided by the reviewer); it is never deleted.
REVOKE DELETE, TRUNCATE ON TABLE machvon.alert_feedback FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.alert_feedback FROM machvon_app;
GRANT UPDATE (status, reviewer_membership_id, reviewed_at, review_note, proposal_note, governance_rule_id, duplicate_of_id, version) ON TABLE machvon.alert_feedback TO machvon_app;

COMMENT ON TABLE machvon.alert_feedback IS 'A person reports that an alert of the alert centre is wrong; the owner of its type reviews it; nothing is suppressed automatically.';

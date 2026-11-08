-- Authored by hand (not generated): the red flags of procurement (governance deepening, lane GOV-10, roadmap G4-3). One row per subject (a procurement package or a contract) with the result of the last evaluation of the twelve
-- indicators of the Open Contracting Partnership that the data of BID and CTR can compute: the score, the indicators that fired with the number they measured and the number they were compared with, the ones that could not be
-- computed, and the version of every rule that judged. A finding is a signal for the auditors to look at, ranked so that the work starts where the signals pile up; it is never a conclusion. It is CONFIDENTIAL: only the
-- auditors read it, the people who took part in the procurement never do (`red_flag_involved`), and no contractor-facing or public read model carries it.
-- The review is the status: NEW -> IN_REVIEW -> CLEAR_PROPOSED -> CLEARED (a second auditor confirms), or IN_REVIEW -> REFERRED. Every move is a row of `red_flag_review`, appended.

CREATE TABLE machvon.red_flag_finding (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('PACKAGE', 'CONTRACT')),
  subject_id uuid NOT NULL,
  subject_code text NOT NULL CHECK (subject_code = btrim(subject_code) AND char_length(subject_code) BETWEEN 1 AND 120),
  project_id uuid,
  score integer NOT NULL CHECK (score >= 0),
  band text NOT NULL CHECK (band IN ('NONE', 'LOW', 'MEDIUM', 'HIGH')),
  -- [{code, ocp_id, value, threshold, weight}] for what fired; every reading (fired, clear, not computable) for the detail screen; the codes that could not be computed.
  fired jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fired) = 'array'),
  readings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(readings) = 'array'),
  not_computable text[] NOT NULL DEFAULT '{}',
  rule_versions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rule_versions) = 'object'),
  ranking_version text NOT NULL CHECK (ranking_version = btrim(ranking_version) AND char_length(ranking_version) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'IN_REVIEW', 'CLEAR_PROPOSED', 'CLEARED', 'REFERRED')),
  first_flagged_at timestamptz NOT NULL,
  last_evaluated_at timestamptz NOT NULL,
  evaluation_count integer NOT NULL DEFAULT 1 CHECK (evaluation_count >= 1),
  reviewer_membership_id uuid,
  review_started_at timestamptz,
  clear_proposed_by uuid,
  clear_reason text CHECK (clear_reason IS NULL OR (clear_reason = btrim(clear_reason) AND char_length(clear_reason) BETWEEN 5 AND 1000)),
  cleared_by uuid,
  cleared_at timestamptz,
  referred_by uuid,
  referred_at timestamptz,
  referral_reason text CHECK (referral_reason IS NULL OR (referral_reason = btrim(referral_reason) AND char_length(referral_reason) BETWEEN 5 AND 1000)),
  reopened_count integer NOT NULL DEFAULT 0 CHECK (reopened_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, clear_proposed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, cleared_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, referred_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT red_flag_finding_subject_uq UNIQUE (tenant_id, subject_type, subject_id),
  CONSTRAINT red_flag_finding_clear_chk CHECK (cleared_by IS NULL OR clear_proposed_by IS NOT NULL),
  CONSTRAINT red_flag_finding_two_eyes_chk CHECK (cleared_by IS NULL OR cleared_by <> clear_proposed_by),
  CONSTRAINT red_flag_finding_cleared_chk CHECK ((status = 'CLEARED') = (cleared_by IS NOT NULL)),
  CONSTRAINT red_flag_finding_referred_chk CHECK ((status = 'REFERRED') = (referred_by IS NOT NULL))
);

CREATE INDEX red_flag_finding_rank_idx ON machvon.red_flag_finding (tenant_id, status, score DESC, first_flagged_at, id);
CREATE INDEX red_flag_finding_subject_idx ON machvon.red_flag_finding (tenant_id, subject_id);
CREATE INDEX red_flag_finding_project_idx ON machvon.red_flag_finding (tenant_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX red_flag_finding_reviewer_idx ON machvon.red_flag_finding (tenant_id, reviewer_membership_id) WHERE reviewer_membership_id IS NOT NULL;
CREATE INDEX red_flag_finding_proposer_idx ON machvon.red_flag_finding (tenant_id, clear_proposed_by) WHERE clear_proposed_by IS NOT NULL;
CREATE INDEX red_flag_finding_cleared_by_idx ON machvon.red_flag_finding (tenant_id, cleared_by) WHERE cleared_by IS NOT NULL;
CREATE INDEX red_flag_finding_referred_by_idx ON machvon.red_flag_finding (tenant_id, referred_by) WHERE referred_by IS NOT NULL;

ALTER TABLE machvon.red_flag_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.red_flag_finding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.red_flag_finding AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.red_flag_finding AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- A finding is never deleted; the subject, the first time it was flagged and the facts of the first evaluation stay.
REVOKE DELETE, TRUNCATE ON TABLE machvon.red_flag_finding FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.red_flag_finding FROM machvon_app;
GRANT UPDATE (subject_code, project_id, score, band, fired, readings, not_computable, rule_versions, ranking_version, status, last_evaluated_at, evaluation_count, reviewer_membership_id, review_started_at, clear_proposed_by, clear_reason,
              cleared_by, cleared_at, referred_by, referred_at, referral_reason, reopened_count, version) ON TABLE machvon.red_flag_finding TO machvon_app;

COMMENT ON TABLE machvon.red_flag_finding IS 'Red flags of procurement (OCP indicators computed from BID and CTR): a ranked signal for the auditors, CONFIDENTIAL, hidden from the people involved, never a conclusion.';

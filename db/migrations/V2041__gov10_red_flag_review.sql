-- Authored by hand (not generated): every move of the review of a red-flag finding (governance deepening, lane GOV-10, roadmap G4-3) and every re-evaluation that changed its score or reopened it. Appended and never changed:
-- who looked, what they decided, the reason in their words and the score at that moment, so that the history of a finding reads as the facts it was.

CREATE TABLE machvon.red_flag_review (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('FLAGGED', 'RESCORED', 'REOPENED', 'TAKE', 'PROPOSE_CLEAR', 'CONFIRM_CLEAR', 'REJECT_CLEAR', 'REFER')),
  from_status text CHECK (from_status IS NULL OR from_status IN ('NEW', 'IN_REVIEW', 'CLEAR_PROPOSED', 'CLEARED', 'REFERRED')),
  to_status text NOT NULL CHECK (to_status IN ('NEW', 'IN_REVIEW', 'CLEAR_PROPOSED', 'CLEARED', 'REFERRED')),
  actor_membership_id uuid,
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 1000)),
  score integer NOT NULL CHECK (score >= 0),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, finding_id) REFERENCES machvon.red_flag_finding (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT red_flag_review_actor_chk CHECK ((move IN ('FLAGGED', 'RESCORED', 'REOPENED')) = (actor_membership_id IS NULL))
);

CREATE INDEX red_flag_review_finding_idx ON machvon.red_flag_review (tenant_id, finding_id, at, id);
CREATE INDEX red_flag_review_actor_idx ON machvon.red_flag_review (tenant_id, actor_membership_id) WHERE actor_membership_id IS NOT NULL;

ALTER TABLE machvon.red_flag_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.red_flag_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.red_flag_review AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.red_flag_review AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.red_flag_review FROM machvon_app;

COMMENT ON TABLE machvon.red_flag_review IS 'The history of a red-flag finding: flagged, rescored, reopened, taken up, cleared in two steps, referred; append-only.';

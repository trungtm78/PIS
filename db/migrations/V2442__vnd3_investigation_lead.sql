-- Authored by hand (not generated): the leads of the investigation, their review and the people who must not see them (VND-3, research V6; docs/vendor-investigation.md section 3).
-- A lead is a ranked signal about contractors (a cluster of linked parties, rotating winners, a cover bid, a price pattern, the same file author, the same origin, a bidder that withdraws for the same winner, a new company of a
-- banned party). It is a signal for the auditors, never a conclusion. The review is the one of the red flags (G4-3): take, propose a dismissal with a reason, a DIFFERENT auditor confirms; or confirm the signal as right; or refer it.
-- One lead is one row for good (the key is the hash of the signal kind, the packages and the contractors, so a scan finds the same lead again); a scan updates its rank and evidence and may reopen a dismissed lead.
-- vendor_lead_involved lists the people who took part in the packages a lead is about: they never see, act on or learn of it. vendor_lead_review is the append-only history of the moves.

CREATE TABLE machvon.vendor_investigation_lead (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('LINK_CLUSTER', 'RESTRICTED_AFFILIATE', 'ROTATING_WINNERS', 'COVER_BID', 'PRICE_PATTERN', 'FILE_METADATA', 'SHARED_ORIGIN', 'WITHDRAWAL_FOR_WINNER')),
  lead_key char(64) NOT NULL CHECK (lead_key ~ '^[0-9a-f]{64}$'),
  contractor_ids uuid[] NOT NULL CHECK (cardinality(contractor_ids) BETWEEN 1 AND 50),
  package_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(package_ids) <= 200),
  rank smallint NOT NULL CHECK (rank BETWEEN 0 AND 100),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_kinds text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'IN_REVIEW', 'DISMISS_PROPOSED', 'DISMISSED', 'CONFIRMED', 'REFERRED')),
  scan_id uuid NOT NULL,
  first_flagged_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  evaluation_count integer NOT NULL DEFAULT 1 CHECK (evaluation_count >= 1),
  reviewer_id uuid,
  review_started_at timestamptz,
  dismiss_proposed_by uuid,
  dismiss_reason text CHECK (dismiss_reason IS NULL OR (dismiss_reason = btrim(dismiss_reason) AND char_length(dismiss_reason) BETWEEN 5 AND 2000)),
  dismissed_by uuid,
  dismissed_at timestamptz,
  confirmed_by uuid,
  confirmed_at timestamptz,
  confirm_reason text CHECK (confirm_reason IS NULL OR (confirm_reason = btrim(confirm_reason) AND char_length(confirm_reason) BETWEEN 5 AND 2000)),
  referred_by uuid,
  referred_at timestamptz,
  referral_reason text CHECK (referral_reason IS NULL OR (referral_reason = btrim(referral_reason) AND char_length(referral_reason) BETWEEN 5 AND 2000)),
  decided_rank smallint CHECK (decided_rank IS NULL OR decided_rank BETWEEN 0 AND 100),
  decided_evidence_kinds text[],
  reopened_count integer NOT NULL DEFAULT 0 CHECK (reopened_count >= 0),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, scan_id) REFERENCES machvon.vendor_link_scan (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, dismiss_proposed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, dismissed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, referred_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT lead_key_uq UNIQUE (tenant_id, lead_key),
  CONSTRAINT lead_dismissal_sod_chk CHECK (dismissed_by IS NULL OR dismiss_proposed_by IS NULL OR dismissed_by <> dismiss_proposed_by),
  CONSTRAINT lead_dismissal_chk CHECK ((dismissed_at IS NULL) = (dismissed_by IS NULL) AND (status <> 'DISMISSED' OR dismissed_at IS NOT NULL)),
  CONSTRAINT lead_confirm_chk CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL) AND (confirmed_at IS NULL) = (confirm_reason IS NULL)),
  CONSTRAINT lead_referral_chk CHECK ((referred_at IS NULL) = (referred_by IS NULL) AND (referred_at IS NULL) = (referral_reason IS NULL) AND (status <> 'REFERRED' OR referred_at IS NOT NULL))
);
CREATE INDEX lead_queue_idx ON machvon.vendor_investigation_lead (tenant_id, status, rank DESC, first_flagged_at);
CREATE INDEX lead_scan_idx ON machvon.vendor_investigation_lead (tenant_id, scan_id);
CREATE INDEX lead_reviewer_idx ON machvon.vendor_investigation_lead (tenant_id, reviewer_id) WHERE reviewer_id IS NOT NULL;
CREATE INDEX lead_proposer_idx ON machvon.vendor_investigation_lead (tenant_id, dismiss_proposed_by) WHERE dismiss_proposed_by IS NOT NULL;
CREATE INDEX lead_dismisser_idx ON machvon.vendor_investigation_lead (tenant_id, dismissed_by) WHERE dismissed_by IS NOT NULL;
CREATE INDEX lead_confirmer_idx ON machvon.vendor_investigation_lead (tenant_id, confirmed_by) WHERE confirmed_by IS NOT NULL;
CREATE INDEX lead_referrer_idx ON machvon.vendor_investigation_lead (tenant_id, referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX lead_contractors_idx ON machvon.vendor_investigation_lead USING gin (contractor_ids);
CREATE INDEX lead_packages_idx ON machvon.vendor_investigation_lead USING gin (package_ids);

ALTER TABLE machvon.vendor_investigation_lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_investigation_lead FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_investigation_lead AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_investigation_lead AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_investigation_lead FROM machvon_app;

COMMENT ON TABLE machvon.vendor_investigation_lead IS 'VND-3: a ranked signal about contractors for the auditors (never a conclusion): rank, evidence, review in two steps, hidden from the people who took part in its packages.';

CREATE TABLE machvon.vendor_lead_involved (
  tenant_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('DRAFTER', 'PANEL', 'WORKFLOW', 'RESULT', 'CONTRACT', 'RECEIVER')),
  PRIMARY KEY (tenant_id, lead_id, membership_id, role),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES machvon.vendor_investigation_lead (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX lead_involved_member_idx ON machvon.vendor_lead_involved (tenant_id, membership_id);

ALTER TABLE machvon.vendor_lead_involved ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_lead_involved FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_lead_involved AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_lead_involved AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_lead_involved FROM machvon_app;

COMMENT ON TABLE machvon.vendor_lead_involved IS 'VND-3: the people who took part in the packages a lead is about; they never see the lead.';

CREATE TABLE machvon.vendor_lead_review (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('SCAN_NEW', 'SCAN_UPDATE', 'SCAN_REOPEN', 'TAKE', 'PROPOSE_DISMISS', 'CONFIRM_DISMISS', 'REJECT_DISMISS', 'CONFIRM_SIGNAL', 'REFER')),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 2000),
  rank smallint NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES machvon.vendor_investigation_lead (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX lead_review_lead_idx ON machvon.vendor_lead_review (tenant_id, lead_id, at);
CREATE INDEX lead_review_actor_idx ON machvon.vendor_lead_review (tenant_id, actor_id, at DESC) WHERE actor_id IS NOT NULL;

ALTER TABLE machvon.vendor_lead_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_lead_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_lead_review AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_lead_review AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.vendor_lead_review FROM machvon_app;
CREATE TRIGGER vendor_lead_review_append_only BEFORE UPDATE OR DELETE ON machvon.vendor_lead_review FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.vendor_lead_review IS 'VND-3: the append-only history of a lead (scan and review moves).';

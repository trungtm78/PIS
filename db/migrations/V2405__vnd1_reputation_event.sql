-- Authored by hand (not generated): the ledger of events of bid conduct (VND-1, research V3; docs/vendor-management.md section 7).
-- Điều 20 NĐ 214/2025 lists behaviours that harm the reputation of a bidder (not comparing documents, not negotiating, winning without signing, withdrawing after closing, not paying the bid security, not paying the performance
-- security, not confirming an award within 3 working days, not providing the key staff or equipment). The investor posts each on the national system within 7 working days; a bidder on the list pays three times the bid security
-- for two years. This table is the record of such an event: who recorded it, on which package, with which paper, the day the posting falls due (counted on the published working calendar with the rule
-- EGP_POSTING_DEADLINES code REPUTATION_EVENT, so the clock here and the obligation of the posting are one number), who posted it and the receipt of the network.
-- An event is posted or retracted once, by somebody other than the person who recorded it; both are final (a wrong posting is answered by a new event). Nothing about what happened is rewritten.

CREATE TABLE machvon.contractor_reputation_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  package_id uuid,
  contract_id uuid,
  behaviour_code text NOT NULL CHECK (behaviour_code IN ('NOT_COMPARING_DOCUMENTS', 'NOT_NEGOTIATING', 'WINNING_WITHOUT_SIGNING', 'WITHDRAWING_AFTER_CLOSING', 'NO_BID_SECURITY', 'NO_PERFORMANCE_SECURITY', 'NO_AWARD_CONFIRMATION', 'NO_KEY_RESOURCES', 'OTHER_BY_LAW')),
  event_on date NOT NULL,
  description text NOT NULL CHECK (description = btrim(description) AND char_length(description) BETWEEN 10 AND 2000),
  evidence_document_id uuid,
  status text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'POSTED', 'RETRACTED')),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  post_due_at timestamptz,
  deadline_policy_version text NOT NULL,
  posted_by uuid,
  posted_at timestamptz,
  posting_ref text CHECK (posting_ref IS NULL OR (posting_ref = btrim(posting_ref) AND char_length(posting_ref) BETWEEN 3 AND 100)),
  retracted_by uuid,
  retracted_at timestamptz,
  retract_reason text CHECK (retract_reason IS NULL OR (retract_reason = btrim(retract_reason) AND char_length(retract_reason) BETWEEN 20 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT reputation_event_post_chk CHECK ((status = 'POSTED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL) AND (posted_at IS NULL) = (posting_ref IS NULL)),
  CONSTRAINT reputation_event_retract_chk CHECK ((status = 'RETRACTED') = (retracted_at IS NOT NULL) AND (retracted_at IS NULL) = (retracted_by IS NULL) AND (retracted_at IS NULL) = (retract_reason IS NULL)),
  -- The posting and the retraction are looked at by somebody other than the person who recorded the event.
  CONSTRAINT reputation_event_sod_chk CHECK ((posted_by IS NULL OR posted_by <> recorded_by) AND (retracted_by IS NULL OR retracted_by <> recorded_by))
);
CREATE INDEX reputation_event_contractor_idx ON machvon.contractor_reputation_event (tenant_id, contractor_id, event_on DESC);
CREATE INDEX reputation_event_package_idx ON machvon.contractor_reputation_event (tenant_id, package_id) WHERE package_id IS NOT NULL;
CREATE INDEX reputation_event_contract_idx ON machvon.contractor_reputation_event (tenant_id, contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX reputation_event_document_idx ON machvon.contractor_reputation_event (tenant_id, evidence_document_id) WHERE evidence_document_id IS NOT NULL;
CREATE INDEX reputation_event_open_idx ON machvon.contractor_reputation_event (tenant_id, post_due_at) WHERE status = 'RECORDED';

CREATE FUNCTION machvon.guard_contractor_reputation_event() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an event of bid conduct is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contractor_id, NEW.package_id, NEW.contract_id, NEW.behaviour_code, NEW.event_on, NEW.description, NEW.evidence_document_id, NEW.recorded_by, NEW.recorded_at, NEW.post_due_at, NEW.deadline_policy_version)
     IS DISTINCT FROM
     (OLD.contractor_id, OLD.package_id, OLD.contract_id, OLD.behaviour_code, OLD.event_on, OLD.description, OLD.evidence_document_id, OLD.recorded_by, OLD.recorded_at, OLD.post_due_at, OLD.deadline_policy_version) THEN
    RAISE EXCEPTION 'an event of bid conduct is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'RECORDED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'an event that is posted or retracted stays so' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER contractor_reputation_event_guard BEFORE UPDATE OR DELETE ON machvon.contractor_reputation_event FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_reputation_event();

ALTER TABLE machvon.contractor_reputation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_reputation_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_reputation_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_reputation_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_reputation_event FROM machvon_app;

COMMENT ON TABLE machvon.contractor_reputation_event IS 'VND-1: an event of bid conduct (Dieu 20 ND 214/2025): who, which package, the day the posting falls due, the posting and its receipt; posted or retracted once.';

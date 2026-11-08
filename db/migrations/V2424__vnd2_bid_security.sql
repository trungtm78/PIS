-- Authored by hand (not generated): the bid security of a bidder (VND-2, research V10; docs/vendor-controls-security-subcontract.md).
-- A bid security (a bank guarantee, an insurance bond or a deposit) is received by one person, confirmed with the issuer by another, and ends released, expired or forfeited. A forfeiture is proposed by one person and decided by
-- another on a decision paper. The amount the package asked and the factor that applied (three times for a contractor with a posted event of bid conduct) are kept on the row as they were on the day it was received.
-- `vendor_bid_security_event` is the append-only ledger of every move. Nothing about the identity of a security is rewritten and a final state stays final.

CREATE TABLE machvon.vendor_bid_security (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('BANK_GUARANTEE', 'INSURANCE_BOND', 'CASH_DEPOSIT')),
  issuer text NOT NULL CHECK (issuer = btrim(issuer) AND char_length(issuer) BETWEEN 2 AND 300),
  security_no text NOT NULL CHECK (security_no = btrim(security_no) AND char_length(security_no) BETWEEN 1 AND 100),
  amount numeric(24,0) NOT NULL CHECK (amount > 0),
  issued_on date NOT NULL,
  valid_until date NOT NULL,
  state text NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED', 'CONFIRMED', 'REJECTED', 'FORFEIT_PROPOSED', 'FORFEITED', 'RELEASED', 'EXPIRED')),
  document_id uuid,
  received_by uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  required_amount numeric(24,0) CHECK (required_amount IS NULL OR required_amount >= 0),
  factor_applied integer NOT NULL DEFAULT 1 CHECK (factor_applied BETWEEN 1 AND 20),
  rule_version text NOT NULL DEFAULT 'builtin',
  confirmed_by uuid,
  confirmed_at timestamptz,
  issuer_reference text CHECK (issuer_reference IS NULL OR (issuer_reference = btrim(issuer_reference) AND char_length(issuer_reference) BETWEEN 3 AND 200)),
  rejected_by uuid,
  rejected_at timestamptz,
  reject_reason text CHECK (reject_reason IS NULL OR (reject_reason = btrim(reject_reason) AND char_length(reject_reason) BETWEEN 20 AND 2000)),
  forfeit_proposed_by uuid,
  forfeit_proposed_at timestamptz,
  forfeit_reason_code text CHECK (forfeit_reason_code IS NULL OR forfeit_reason_code IN ('WITHDREW_AFTER_CLOSING', 'WITHDREW_BEFORE_VALIDITY_END', 'REFUSED_TO_SIGN', 'NO_PERFORMANCE_SECURITY', 'FALSE_DECLARATION', 'OTHER_BY_BIDDING_DOCUMENT')),
  forfeit_reason text CHECK (forfeit_reason IS NULL OR (forfeit_reason = btrim(forfeit_reason) AND char_length(forfeit_reason) BETWEEN 20 AND 2000)),
  forfeit_decided_by uuid,
  forfeit_decided_at timestamptz,
  forfeit_decision_document_id uuid,
  forfeit_decision_reason text CHECK (forfeit_decision_reason IS NULL OR (forfeit_decision_reason = btrim(forfeit_decision_reason) AND char_length(forfeit_decision_reason) BETWEEN 20 AND 2000)),
  released_by uuid,
  released_at timestamptz,
  release_reason text CHECK (release_reason IS NULL OR (release_reason = btrim(release_reason) AND char_length(release_reason) BETWEEN 5 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, received_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT vendor_bid_security_period_chk CHECK (valid_until >= issued_on),
  CONSTRAINT vendor_bid_security_confirm_chk CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL) AND (confirmed_by IS NULL) = (issuer_reference IS NULL) AND (confirmed_by IS NULL OR confirmed_by <> received_by)),
  CONSTRAINT vendor_bid_security_reject_chk CHECK ((rejected_by IS NULL) = (rejected_at IS NULL) AND (rejected_by IS NULL) = (reject_reason IS NULL) AND (rejected_by IS NULL OR rejected_by <> received_by)),
  CONSTRAINT vendor_bid_security_propose_chk CHECK ((forfeit_proposed_by IS NULL) = (forfeit_proposed_at IS NULL)),
  CONSTRAINT vendor_bid_security_decide_chk CHECK ((forfeit_decided_by IS NULL) = (forfeit_decided_at IS NULL) AND (forfeit_decided_by IS NULL OR (forfeit_decided_by IS DISTINCT FROM forfeit_proposed_by AND forfeit_decision_document_id IS NOT NULL))),
  CONSTRAINT vendor_bid_security_forfeited_chk CHECK (state <> 'FORFEITED' OR forfeit_decided_by IS NOT NULL)
);
CREATE INDEX vendor_bid_security_package_idx ON machvon.vendor_bid_security (tenant_id, package_id, contractor_id);
CREATE INDEX vendor_bid_security_contractor_idx ON machvon.vendor_bid_security (tenant_id, contractor_id, state);
CREATE INDEX vendor_bid_security_open_idx ON machvon.vendor_bid_security (tenant_id, valid_until) WHERE state IN ('RECEIVED', 'CONFIRMED');
CREATE INDEX vendor_bid_security_document_idx ON machvon.vendor_bid_security (tenant_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX vendor_bid_security_decision_document_idx ON machvon.vendor_bid_security (tenant_id, forfeit_decision_document_id) WHERE forfeit_decision_document_id IS NOT NULL;
CREATE INDEX vendor_bid_security_received_by_idx ON machvon.vendor_bid_security (tenant_id, received_by);
CREATE INDEX vendor_bid_security_confirmed_by_idx ON machvon.vendor_bid_security (tenant_id, confirmed_by) WHERE confirmed_by IS NOT NULL;
CREATE INDEX vendor_bid_security_rejected_by_idx ON machvon.vendor_bid_security (tenant_id, rejected_by) WHERE rejected_by IS NOT NULL;
CREATE INDEX vendor_bid_security_proposed_by_idx ON machvon.vendor_bid_security (tenant_id, forfeit_proposed_by) WHERE forfeit_proposed_by IS NOT NULL;
CREATE INDEX vendor_bid_security_decided_by_idx ON machvon.vendor_bid_security (tenant_id, forfeit_decided_by) WHERE forfeit_decided_by IS NOT NULL;
CREATE INDEX vendor_bid_security_released_by_idx ON machvon.vendor_bid_security (tenant_id, released_by) WHERE released_by IS NOT NULL;

CREATE TABLE machvon.vendor_bid_security_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  security_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('RECEIVE', 'CONFIRM', 'REJECT', 'PROPOSE_FORFEIT', 'WITHDRAW_FORFEIT', 'DECIDE_FORFEIT', 'REFUSE_FORFEIT', 'RELEASE', 'EXPIRE')),
  from_state text,
  to_state text NOT NULL,
  actor_id uuid NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, security_id) REFERENCES machvon.vendor_bid_security (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX vendor_bid_security_event_security_idx ON machvon.vendor_bid_security_event (tenant_id, security_id, occurred_at);
CREATE INDEX vendor_bid_security_event_actor_idx ON machvon.vendor_bid_security_event (tenant_id, actor_id, occurred_at DESC);

-- The identity of a security (what was lodged, with whom, when and for how much) never changes; a security that is forfeited, released, expired or rejected stays so; an event is never rewritten.
CREATE FUNCTION machvon.guard_vendor_bid_security() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a bid security is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.package_id, NEW.contractor_id, NEW.kind, NEW.issuer, NEW.security_no, NEW.amount, NEW.issued_on, NEW.valid_until, NEW.received_by, NEW.received_at, NEW.required_amount, NEW.factor_applied)
     IS DISTINCT FROM
     (OLD.package_id, OLD.contractor_id, OLD.kind, OLD.issuer, OLD.security_no, OLD.amount, OLD.issued_on, OLD.valid_until, OLD.received_by, OLD.received_at, OLD.required_amount, OLD.factor_applied) THEN
    RAISE EXCEPTION 'a bid security is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('REJECTED', 'FORFEITED', 'RELEASED', 'EXPIRED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a bid security that is rejected, forfeited, released or expired stays so' USING ERRCODE = '23514';
  END IF;
  IF OLD.confirmed_by IS NOT NULL AND (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.issuer_reference IS DISTINCT FROM OLD.issuer_reference) THEN
    RAISE EXCEPTION 'a confirmation stays as it was made' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER vendor_bid_security_guard BEFORE UPDATE OR DELETE ON machvon.vendor_bid_security FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_bid_security();

CREATE FUNCTION machvon.guard_vendor_bid_security_event() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the ledger of a bid security is append-only' USING ERRCODE = '23514';
END;
$fn$;
CREATE TRIGGER vendor_bid_security_event_guard BEFORE UPDATE OR DELETE ON machvon.vendor_bid_security_event FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_bid_security_event();

ALTER TABLE machvon.vendor_bid_security ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_bid_security FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_bid_security AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_bid_security AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.vendor_bid_security_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_bid_security_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_bid_security_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_bid_security_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_bid_security FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_bid_security_event FROM machvon_app;

COMMENT ON TABLE machvon.vendor_bid_security IS 'VND-2: the bid security of a bidder: received, confirmed with the issuer by a second person, released, expired or forfeited by a decision of a second person.';
COMMENT ON TABLE machvon.vendor_bid_security_event IS 'VND-2: append-only ledger of every move of a bid security.';

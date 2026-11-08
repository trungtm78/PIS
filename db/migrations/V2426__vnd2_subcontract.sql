-- Authored by hand (not generated): subcontractors of a contract and what the prime paid them (VND-2, research V11; docs/vendor-controls-security-subcontract.md).
--   * `vendor_subcontract`: a subcontract is proposed, approved by a person other than the proposer (the check of the gate SUBCONTRACT of VND-1 runs at the approval), and ends terminated or rejected. The assessment against
--     the declaration of the bid and the limits of the rule is stored with the rule version at the approval; an exception (a share over the declared one, a subcontractor the bid did not name) carries its reason.
--   * `vendor_subcontract_payment`: after a payment request of the prime is paid, the contract manager records what the prime paid the subcontractor (amount, day, reference). The subcontractor confirms it later through the
--     supplier portal (VND-3): the columns for that are here and stay empty until then. A record is never edited.

CREATE TABLE machvon.vendor_subcontract (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  subcontractor_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope = btrim(scope) AND char_length(scope) BETWEEN 5 AND 2000),
  value numeric(24,0) NOT NULL CHECK (value > 0),
  share_pct numeric(7,4) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
  declared_in_bid boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED', 'APPROVED', 'REJECTED', 'TERMINATED')),
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  exception_reason text CHECK (exception_reason IS NULL OR (exception_reason = btrim(exception_reason) AND char_length(exception_reason) BETWEEN 20 AND 2000)),
  exception_approved boolean NOT NULL DEFAULT false,
  assessment jsonb,
  rule_version text,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 5 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, subcontractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT vendor_subcontract_approve_chk CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (approved_by IS NULL OR approved_by <> proposed_by)),
  CONSTRAINT vendor_subcontract_state_chk CHECK ((state IN ('APPROVED', 'TERMINATED') AND approved_by IS NOT NULL) OR state IN ('PROPOSED', 'REJECTED')),
  CONSTRAINT vendor_subcontract_exception_chk CHECK (NOT exception_approved OR exception_reason IS NOT NULL),
  CONSTRAINT vendor_subcontract_decided_chk CHECK ((decided_by IS NULL) = (decided_at IS NULL))
);
-- One live subcontract of a subcontractor on a contract: a second proposal waits until the first ends.
CREATE UNIQUE INDEX vendor_subcontract_live_uq ON machvon.vendor_subcontract (tenant_id, contract_id, subcontractor_id) WHERE state IN ('PROPOSED', 'APPROVED');
CREATE INDEX vendor_subcontract_contract_idx ON machvon.vendor_subcontract (tenant_id, contract_id, state);
CREATE INDEX vendor_subcontract_subcontractor_idx ON machvon.vendor_subcontract (tenant_id, subcontractor_id, state);
CREATE INDEX vendor_subcontract_proposed_by_idx ON machvon.vendor_subcontract (tenant_id, proposed_by);
CREATE INDEX vendor_subcontract_approved_by_idx ON machvon.vendor_subcontract (tenant_id, approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX vendor_subcontract_decided_by_idx ON machvon.vendor_subcontract (tenant_id, decided_by) WHERE decided_by IS NOT NULL;

CREATE TABLE machvon.vendor_subcontract_payment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subcontract_id uuid NOT NULL,
  payment_request_id uuid,
  paid_amount numeric(24,0) NOT NULL CHECK (paid_amount > 0),
  paid_on date NOT NULL,
  reference text NOT NULL CHECK (reference = btrim(reference) AND char_length(reference) BETWEEN 3 AND 100),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by_subcontractor boolean NOT NULL DEFAULT false,
  subcontractor_confirmed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subcontract_id) REFERENCES machvon.vendor_subcontract (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_request_id) REFERENCES machvon.payment_request (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT vendor_subcontract_payment_confirm_chk CHECK (confirmed_by_subcontractor = (subcontractor_confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX vendor_subcontract_payment_request_uq ON machvon.vendor_subcontract_payment (tenant_id, subcontract_id, payment_request_id) WHERE payment_request_id IS NOT NULL;
CREATE INDEX vendor_subcontract_payment_subcontract_idx ON machvon.vendor_subcontract_payment (tenant_id, subcontract_id, paid_on);
CREATE INDEX vendor_subcontract_payment_request_idx ON machvon.vendor_subcontract_payment (tenant_id, payment_request_id) WHERE payment_request_id IS NOT NULL;
CREATE INDEX vendor_subcontract_payment_recorded_by_idx ON machvon.vendor_subcontract_payment (tenant_id, recorded_by);

-- What a subcontract is (the contract, the subcontractor, the scope, the value and the share) never changes, and an ended one stays ended; a payment record is written once (only the confirmation of the subcontractor is added later).
CREATE FUNCTION machvon.guard_vendor_subcontract() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a subcontract and its payment records are never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'vendor_subcontract' THEN
    IF (NEW.contract_id, NEW.subcontractor_id, NEW.scope, NEW.value, NEW.share_pct, NEW.declared_in_bid, NEW.proposed_by, NEW.proposed_at)
       IS DISTINCT FROM (OLD.contract_id, OLD.subcontractor_id, OLD.scope, OLD.value, OLD.share_pct, OLD.declared_in_bid, OLD.proposed_by, OLD.proposed_at) THEN
      RAISE EXCEPTION 'a subcontract is not rewritten' USING ERRCODE = '23514';
    END IF;
    IF OLD.state IN ('REJECTED', 'TERMINATED') AND NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'a subcontract that is rejected or terminated stays so' USING ERRCODE = '23514';
    END IF;
    IF OLD.approved_by IS NOT NULL AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.exception_approved IS DISTINCT FROM OLD.exception_approved) THEN
      RAISE EXCEPTION 'an approval stays as it was made' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.subcontract_id, NEW.payment_request_id, NEW.paid_amount, NEW.paid_on, NEW.reference, NEW.recorded_by, NEW.recorded_at) IS DISTINCT FROM (OLD.subcontract_id, OLD.payment_request_id, OLD.paid_amount, OLD.paid_on, OLD.reference, OLD.recorded_by, OLD.recorded_at) THEN
      RAISE EXCEPTION 'a record of a payment to a subcontractor is not rewritten' USING ERRCODE = '23514';
    END IF;
    IF OLD.confirmed_by_subcontractor AND NOT NEW.confirmed_by_subcontractor THEN
      RAISE EXCEPTION 'a confirmation of the subcontractor stays' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER vendor_subcontract_guard BEFORE UPDATE OR DELETE ON machvon.vendor_subcontract FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_subcontract();
CREATE TRIGGER vendor_subcontract_payment_guard BEFORE UPDATE OR DELETE ON machvon.vendor_subcontract_payment FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_subcontract();

ALTER TABLE machvon.vendor_subcontract ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_subcontract FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_subcontract AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_subcontract AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.vendor_subcontract_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_subcontract_payment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_subcontract_payment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_subcontract_payment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_subcontract FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_subcontract_payment FROM machvon_app;

COMMENT ON TABLE machvon.vendor_subcontract IS 'VND-2: a subcontract of a contract: proposed, approved by a second person (with a reasoned exception when it passes the declared share), terminated or rejected.';
COMMENT ON TABLE machvon.vendor_subcontract_payment IS 'VND-2: what the prime paid a subcontractor after a payment request; the subcontractor confirms it later through the supplier portal.';

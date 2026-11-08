-- Authored by hand (not generated): the claim register of a contract (GOV-8, roadmap G1-9, docs/ctr-claims.md).
-- A claim is a demand one side of a contract makes on the other because of an event: the contractor asks for more time or money, the owner asks for delay damages, the cost of a defect or a set-off.
--   * `contract_claim`: one row per claim, numbered per contract (`CLM-001`). It carries the dates of the steps the limits of the contract are counted from (the denormalised copy of the timeline, written in the
--     transaction of each step), the term it is bound to (`term_id`: the approved term of its side on the day it was registered, or the one approved later; null while the contract has none and then it has no
--     limitation clock), the figures asked for and settled, and the links to a change order and a payment request of the same contract;
--   * a settlement is proposed by one person and approved by another (maker is not checker, a CHECK), and a claim is `SETTLED` only with an approver, a day and at least one of an amount or days granted;
--   * a claim declared barred (`TIME_BARRED`) names who declared it, never the person who registered it (a CHECK), and the statement of why is in the timeline (`contract_claim_step`, V1982);
--   * no row is ever deleted by the application role.

CREATE TABLE machvon.contract_claim (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  code text NOT NULL,
  claimant_side text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  event_description text NOT NULL,
  event_on date NOT NULL,
  awareness_on date NOT NULL,
  status text NOT NULL DEFAULT 'EVENT_RECORDED',
  term_id uuid,
  claimed_amount_vnd numeric(24,0),
  claimed_days integer,
  settled_amount_vnd numeric(24,0),
  granted_days integer,
  change_request_id uuid,
  payment_request_id uuid,
  responsible_membership_id uuid,
  registered_by uuid NOT NULL,
  notice_on date,
  particulars_on date,
  last_particulars_on date,
  response_on date,
  response_decision text,
  accepted_on date,
  last_step_on date NOT NULL,
  settlement_proposed_by uuid,
  settlement_approved_by uuid,
  settled_on date,
  closed_on date,
  closed_by uuid,
  step_count integer NOT NULL DEFAULT 1,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, term_id) REFERENCES machvon.contract_claim_term (tenant_id, id),
  FOREIGN KEY (tenant_id, change_request_id) REFERENCES machvon.change_request (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_request_id) REFERENCES machvon.payment_request (tenant_id, id),
  FOREIGN KEY (tenant_id, responsible_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT contract_claim_code_chk CHECK (code ~ '^CLM-[0-9]{3,6}$'),
  CONSTRAINT contract_claim_side_chk CHECK (claimant_side IN ('CONTRACTOR', 'OWNER')),
  CONSTRAINT contract_claim_kind_chk CHECK (kind IN ('EXTENSION_OF_TIME', 'ADDITIONAL_PAYMENT', 'TIME_AND_COST', 'DELAY_DAMAGES', 'DEFECT_COST', 'SET_OFF', 'OTHER')),
  CONSTRAINT contract_claim_side_kind_chk CHECK (
    (claimant_side = 'CONTRACTOR' AND kind IN ('EXTENSION_OF_TIME', 'ADDITIONAL_PAYMENT', 'TIME_AND_COST', 'OTHER'))
    OR (claimant_side = 'OWNER' AND kind IN ('DELAY_DAMAGES', 'DEFECT_COST', 'SET_OFF', 'OTHER'))
  ),
  CONSTRAINT contract_claim_status_chk CHECK (status IN ('EVENT_RECORDED', 'NOTICE_SERVED', 'PARTICULARS_SUBMITTED', 'RESPONDED', 'SETTLEMENT_PROPOSED', 'SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED')),
  CONSTRAINT contract_claim_text_chk CHECK (title = btrim(title) AND char_length(title) BETWEEN 5 AND 200 AND event_description = btrim(event_description) AND char_length(event_description) BETWEEN 5 AND 2000),
  CONSTRAINT contract_claim_dates_chk CHECK (awareness_on >= event_on),
  CONSTRAINT contract_claim_amounts_chk CHECK (
    (claimed_amount_vnd IS NULL OR claimed_amount_vnd >= 0) AND (settled_amount_vnd IS NULL OR settled_amount_vnd >= 0)
    AND (claimed_days IS NULL OR claimed_days >= 0) AND (granted_days IS NULL OR granted_days >= 0)
  ),
  CONSTRAINT contract_claim_settled_within_chk CHECK (
    (settled_amount_vnd IS NULL OR claimed_amount_vnd IS NULL OR settled_amount_vnd <= claimed_amount_vnd) AND (granted_days IS NULL OR claimed_days IS NULL OR granted_days <= claimed_days)
  ),
  CONSTRAINT contract_claim_decision_chk CHECK (response_decision IS NULL OR response_decision IN ('ACCEPTED', 'PARTLY_ACCEPTED', 'REJECTED', 'MORE_INFORMATION_REQUESTED')),
  CONSTRAINT contract_claim_response_pair_chk CHECK ((response_on IS NULL) = (response_decision IS NULL)),
  CONSTRAINT contract_claim_settle_maker_checker_chk CHECK (settlement_approved_by IS NULL OR settlement_proposed_by IS NULL OR settlement_approved_by <> settlement_proposed_by),
  CONSTRAINT contract_claim_settled_chk CHECK (
    status <> 'SETTLED' OR (settlement_approved_by IS NOT NULL AND settlement_proposed_by IS NOT NULL AND settled_on IS NOT NULL AND (settled_amount_vnd IS NOT NULL OR granted_days IS NOT NULL))
  ),
  CONSTRAINT contract_claim_bar_maker_checker_chk CHECK (status <> 'TIME_BARRED' OR (closed_by IS NOT NULL AND closed_by <> registered_by)),
  CONSTRAINT contract_claim_closed_chk CHECK ((status IN ('SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED')) = (closed_on IS NOT NULL)),
  CONSTRAINT contract_claim_notice_chk CHECK (status = 'EVENT_RECORDED' OR status IN ('WITHDRAWN', 'TIME_BARRED') OR notice_on IS NOT NULL),
  CONSTRAINT contract_claim_step_count_chk CHECK (step_count >= 1),
  CONSTRAINT contract_claim_version_chk CHECK (version >= 1),
  CONSTRAINT contract_claim_code_uq UNIQUE (tenant_id, contract_id, code)
);

CREATE INDEX contract_claim_contract_id_idx ON machvon.contract_claim (tenant_id, contract_id, created_at DESC, id DESC);
CREATE INDEX contract_claim_term_id_idx ON machvon.contract_claim (tenant_id, term_id) WHERE term_id IS NOT NULL;
CREATE INDEX contract_claim_change_request_id_idx ON machvon.contract_claim (tenant_id, change_request_id) WHERE change_request_id IS NOT NULL;
CREATE INDEX contract_claim_payment_request_id_idx ON machvon.contract_claim (tenant_id, payment_request_id) WHERE payment_request_id IS NOT NULL;
CREATE INDEX contract_claim_responsible_membership_id_idx ON machvon.contract_claim (tenant_id, responsible_membership_id) WHERE responsible_membership_id IS NOT NULL;
CREATE INDEX contract_claim_open_idx ON machvon.contract_claim (tenant_id, status, awareness_on) WHERE status NOT IN ('SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED');

-- The identity of a claim never changes: its contract, side, kind, the event and the day of awareness (the day the limits count from) and who registered it. What moves is the timeline.
CREATE FUNCTION machvon.guard_contract_claim() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.claimant_side IS DISTINCT FROM OLD.claimant_side OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.event_on IS DISTINCT FROM OLD.event_on OR NEW.awareness_on IS DISTINCT FROM OLD.awareness_on OR NEW.registered_by IS DISTINCT FROM OLD.registered_by THEN
    RAISE EXCEPTION 'a claim keeps its contract, its side, its kind, its event and the day of awareness' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.settled_amount_vnd IS DISTINCT FROM OLD.settled_amount_vnd OR NEW.granted_days IS DISTINCT FROM OLD.granted_days) THEN
    RAISE EXCEPTION 'a claim that ended is not moved or settled again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_claim_guard BEFORE UPDATE ON machvon.contract_claim FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_claim();

ALTER TABLE machvon.contract_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_claim AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_claim AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_claim FROM machvon_app;

COMMENT ON TABLE machvon.contract_claim IS 'GOV-8: a claim of one side of a contract: dates the limits count from, the bound term, the figures, the settlement (maker is not checker) and the links to a change order and a payment request.';

-- Authored by hand (not generated): the reversal of a settled payment (ST-PAY-008, PAY 3.4, UAT-AC331).
-- A settled request is reversed by new entries against a refund the Treasury confirmed; nothing is updated or deleted. This keeps the proof on the request (who reversed it, when, why, on what
-- document and against which refund), lets a refund be matched to the request it undoes, lets the request go from SETTLED to REVERSED only when that refund is matched to it, and lets an advance
-- that was paid and never recovered go back to planned when its payment is reversed.

-- V002 gave the request who reversed it, when and why (reversed_by, reversed_at, reversal_reason); this adds the document that approved it and the refund it stands on.
ALTER TABLE machvon.payment_request
  ADD COLUMN reversal_approval_document_version_id uuid,
  ADD COLUMN refund_transaction_id uuid;
ALTER TABLE machvon.payment_request
  ADD CONSTRAINT payment_request_reversed_by_fk FOREIGN KEY (tenant_id, reversed_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT payment_request_reversal_approval_fk FOREIGN KEY (tenant_id, reversal_approval_document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  ADD CONSTRAINT payment_request_refund_transaction_fk FOREIGN KEY (tenant_id, refund_transaction_id) REFERENCES machvon.treasury_transaction (tenant_id, id),
  -- A reversed request says who reversed it, when, why, on which document and against which refund; any other request says none of it.
  ADD CONSTRAINT payment_request_reversed_chk CHECK (
    (status = 'REVERSED') = (reversed_by IS NOT NULL)
    AND (reversed_by IS NOT NULL) = (reversed_at IS NOT NULL)
    AND (reversed_by IS NOT NULL) = (reversal_reason IS NOT NULL)
    AND (reversed_by IS NOT NULL) = (reversal_approval_document_version_id IS NOT NULL)
    AND (reversed_by IS NOT NULL) = (refund_transaction_id IS NOT NULL)
  );
CREATE INDEX payment_request_reversal_approval_idx ON machvon.payment_request (tenant_id, reversal_approval_document_version_id);
CREATE INDEX payment_request_refund_transaction_id_idx ON machvon.payment_request (tenant_id, refund_transaction_id);

-- One refund is matched to a request, and a refund undoes one request.
CREATE UNIQUE INDEX treasury_transaction_refund_request_uq ON machvon.treasury_transaction (tenant_id, payment_request_id)
  WHERE match_status = 'MATCHED' AND direction = 'REFUND';

-- The match of a transaction: a payment is matched to a request that is with the Treasury, for its net; a refund is matched to the settled request whose payment it undoes, for the same amount.
CREATE OR REPLACE FUNCTION machvon.treasury_transaction_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
     OR NEW.import_id IS DISTINCT FROM OLD.import_id OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.document_no IS DISTINCT FROM OLD.document_no OR NEW.document_date IS DISTINCT FROM OLD.document_date
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.row_hash IS DISTINCT FROM OLD.row_hash
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR NEW.evidence_document_version_id IS DISTINCT FROM OLD.evidence_document_version_id
     OR NEW.treasury_office_record_id IS DISTINCT FROM OLD.treasury_office_record_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a Treasury transaction keeps what it says; a mistake is corrected by a reversal' USING ERRCODE = '23514';
  END IF;
  IF OLD.match_status = 'MATCHED' THEN
    RAISE EXCEPTION 'TRANSACTION_ALREADY_MATCHED: a matched Treasury transaction is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.match_status = 'EXCEPTION' AND NEW.match_status = 'UNMATCHED' THEN
    RAISE EXCEPTION 'a Treasury transaction in exception does not go back to unmatched' USING ERRCODE = '23514';
  END IF;
  IF OLD.payment_request_id IS NOT NULL AND NEW.payment_request_id IS DISTINCT FROM OLD.payment_request_id THEN
    RAISE EXCEPTION 'TRANSACTION_ALREADY_MATCHED: a Treasury transaction is tied to one payment request' USING ERRCODE = '23514';
  END IF;
  IF NEW.match_status = 'MATCHED' THEN
    IF NEW.matched_by IS NULL THEN
      RAISE EXCEPTION 'a matched transaction says who matched it' USING ERRCODE = '23514';
    END IF;
    IF NEW.direction = 'PAYMENT' AND NOT EXISTS (
      SELECT 1 FROM machvon.payment_request pr
       WHERE pr.tenant_id = NEW.tenant_id AND pr.id = NEW.payment_request_id AND pr.status = 'SENT_TREASURY' AND pr.project_id = NEW.project_id AND pr.net_vnd = NEW.amount_vnd
    ) THEN
      RAISE EXCEPTION 'TRANSACTION_NOT_MATCHABLE: a transaction is matched to a request with the Treasury of the same project, for exactly its net' USING ERRCODE = '23514';
    END IF;
    IF NEW.direction = 'REFUND' AND NOT EXISTS (
      SELECT 1 FROM machvon.payment_request pr
       WHERE pr.tenant_id = NEW.tenant_id AND pr.id = NEW.payment_request_id AND pr.status = 'SETTLED' AND pr.project_id = NEW.project_id AND pr.net_vnd = NEW.amount_vnd
         AND pr.settled_transaction_id = NEW.reversal_of_id
    ) THEN
      RAISE EXCEPTION 'REFUND_NOT_CONFIRMED: a refund is matched to the settled request whose payment it undoes, for the same amount' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- A request is REVERSED only against the refund matched to it, and an advance request only once its advance is planned again.
CREATE OR REPLACE FUNCTION machvon.guard_payment_request() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  paid timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM machvon.contract c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contract_id AND c.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'a payment request is for the project of its contract' USING ERRCODE = '23514';
    END IF;
    IF NEW.request_kind <> 'ADVANCE' AND NOT EXISTS (
      SELECT 1 FROM machvon.acceptance a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.acceptance_id AND a.contract_id = NEW.contract_id AND a.status = 'APPROVED'
    ) THEN
      RAISE EXCEPTION 'ACCEPTANCE_NOT_APPROVED: a payment request is drawn from an approved acceptance of its contract' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.acceptance_id, NEW.request_kind, NEW.advance_id, NEW.currency, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.acceptance_id, OLD.request_kind, OLD.advance_id, OLD.currency, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a payment request is about never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: a payment request that is over is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'SUBMITTED'), ('DRAFT', 'CANCELLED'), ('SUBMITTED', 'VERIFIED'), ('SUBMITTED', 'RETURNED'), ('VERIFIED', 'SENT_TREASURY'), ('VERIFIED', 'RETURNED'),
                   ('SENT_TREASURY', 'SETTLED'), ('SENT_TREASURY', 'RETURNED'), ('SETTLED', 'REVERSED'), ('RETURNED', 'DRAFT'), ('RETURNED', 'CANCELLED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('DRAFT', 'RETURNED') AND
     (NEW.gross_vnd, NEW.advance_recovery_vnd, NEW.retention_vnd, NEW.tax_adjustment_vnd, NEW.net_vnd, NEW.tax_adjustment_basis, NEW.advance_recovery_extra_vnd, NEW.request_no, NEW.allocation_line_id, NEW.plan_year, NEW.settlement_revision_id)
     IS DISTINCT FROM
     (OLD.gross_vnd, OLD.advance_recovery_vnd, OLD.retention_vnd, OLD.tax_adjustment_vnd, OLD.net_vnd, OLD.tax_adjustment_basis, OLD.advance_recovery_extra_vnd, OLD.request_no, OLD.allocation_line_id, OLD.plan_year, OLD.settlement_revision_id) THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: the amounts of a request are fixed once it is sent' USING ERRCODE = '23514';
  END IF;
  -- What settled a request is not changed afterwards, even when the request is reversed.
  IF OLD.settled_transaction_id IS NOT NULL AND (NEW.settled_transaction_id, NEW.treasury_paid_on, NEW.settled_by, NEW.settled_at) IS DISTINCT FROM (OLD.settled_transaction_id, OLD.treasury_paid_on, OLD.settled_by, OLD.settled_at) THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: what settled a request is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Whoever moves a request says who they are: the checker is held to be neither the one who drew the request up nor the one who sent it only if the sender is known.
    IF NEW.status = 'SUBMITTED' AND (NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL) THEN
      RAISE EXCEPTION 'a request that is sent says who sent it and when' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'VERIFIED' AND (NEW.verified_by IS NULL OR NEW.verified_at IS NULL) THEN
      RAISE EXCEPTION 'a request that is checked says who checked it and when' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'RETURNED' AND (NEW.return_reason IS NULL OR NEW.returned_by IS NULL OR NEW.returned_at IS NULL) THEN
      RAISE EXCEPTION 'a request that is returned says who returned it, when and why' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'SENT_TREASURY' THEN
      IF NEW.treasury_submitted_on IS NULL OR NEW.treasury_sent_by IS NULL OR NEW.treasury_sent_at IS NULL THEN
        RAISE EXCEPTION 'a request sent to the Treasury says on which day, by whom and when' USING ERRCODE = '23514';
      END IF;
      IF (SELECT count(DISTINCT f.form_code) FROM machvon.payment_form_instance f
           WHERE f.tenant_id = NEW.tenant_id AND f.payment_request_id = NEW.id AND f.status = 'GENERATED' AND f.form_code IN ('03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT')) <> 4 THEN
        RAISE EXCEPTION 'FORMS_NOT_GENERATED: a request goes to the Treasury with a form of each of the four kinds' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.status = 'SETTLED' THEN
      SELECT t.confirmed_at INTO paid FROM machvon.treasury_transaction t
       WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.settled_transaction_id AND t.payment_request_id = NEW.id AND t.direction = 'PAYMENT' AND t.match_status = 'MATCHED'
         AND t.project_id = NEW.project_id AND t.amount_vnd = NEW.net_vnd;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'TRANSACTION_NOT_MATCHABLE: a request is settled by the transaction matched to it, for exactly its net' USING ERRCODE = '23514';
      END IF;
      IF NEW.treasury_paid_on IS DISTINCT FROM (paid AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
        RAISE EXCEPTION 'the day a payment counts from is the day the Treasury confirmed it' USING ERRCODE = '23514';
      END IF;
      IF NEW.allocation_line_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM machvon.allocation_line al JOIN machvon.appropriation ap ON ap.tenant_id = al.tenant_id AND ap.id = al.appropriation_id
         WHERE al.tenant_id = NEW.tenant_id AND al.id = NEW.allocation_line_id AND ap.plan_year = NEW.plan_year
      ) THEN
        RAISE EXCEPTION 'PLAN_YEAR_MISMATCH: a payment is settled on the line of capital of the year it was asked for' USING ERRCODE = '23514';
      END IF;
      IF NEW.request_kind = 'ADVANCE' AND NOT EXISTS (
        SELECT 1 FROM machvon.contract_advance a
         WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.advance_id AND a.status = 'PAID' AND a.paid_vnd = NEW.gross_vnd AND a.paid_on = NEW.treasury_paid_on
      ) THEN
        RAISE EXCEPTION 'ADVANCE_STATE_INVALID: an advance request is settled once the advance has been paid for the amount asked' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.status = 'REVERSED' THEN
      IF NEW.reversed_by IS NULL OR NEW.reversed_at IS NULL OR NEW.reversal_reason IS NULL OR NEW.reversal_approval_document_version_id IS NULL OR NEW.refund_transaction_id IS NULL THEN
        RAISE EXCEPTION 'a request that is reversed says who reversed it, when, why, on which document and against which refund' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM machvon.treasury_transaction t
         WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.refund_transaction_id AND t.payment_request_id = NEW.id AND t.direction = 'REFUND' AND t.match_status = 'MATCHED'
           AND t.reversal_of_id = NEW.settled_transaction_id AND t.amount_vnd = NEW.net_vnd
      ) THEN
        RAISE EXCEPTION 'REFUND_NOT_CONFIRMED: a payment is reversed against the refund matched to it' USING ERRCODE = '23514';
      END IF;
      IF NEW.request_kind = 'ADVANCE' AND NOT EXISTS (
        SELECT 1 FROM machvon.contract_advance a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.advance_id AND a.status = 'PLANNED' AND a.paid_vnd = 0
      ) THEN
        RAISE EXCEPTION 'ADVANCE_STATE_INVALID: the advance of a reversed payment is planned again' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  -- What reversed a request is not changed afterwards.
  IF OLD.reversed_by IS NOT NULL AND (NEW.reversed_by, NEW.reversed_at, NEW.reversal_reason, NEW.reversal_approval_document_version_id, NEW.refund_transaction_id)
     IS DISTINCT FROM (OLD.reversed_by, OLD.reversed_at, OLD.reversal_reason, OLD.reversal_approval_document_version_id, OLD.refund_transaction_id) THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: what reversed a request is kept as it is' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- What is held back goes with the request when it is returned, and with a payment that is reversed (the money came back), and only while nothing of it was released: once the retention has been
-- paid out the payment cannot be reversed here.
CREATE OR REPLACE FUNCTION machvon.guard_retention_hold_delete() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM machvon.payment_request p WHERE p.tenant_id = OLD.tenant_id AND p.id = OLD.payment_request_id AND p.status IN ('RETURNED', 'REVERSED')) OR OLD.released_vnd <> 0 THEN
    RAISE EXCEPTION 'a hold of retention goes only with the request that is returned or reversed, and only while nothing of it is released' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$fn$;

-- An advance that was paid and never recovered goes back to planned when its payment is reversed (the money came back); one that was recovered, even in part, does not.
CREATE OR REPLACE FUNCTION machvon.guard_contract_advance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  covering machvon.guarantee%ROWTYPE;
  facts RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM machvon.contract_party p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.party_id AND p.contract_id = NEW.contract_id AND p.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'an advance is paid to an active member of its contract' USING ERRCODE = '23514';
    END IF;
    -- A planned advance is a request: it is made on a contract in force, from a rule that was read, and a contract advance is covered by a guarantee that is valid today.
    IF NEW.status = 'PLANNED' THEN
      SELECT c.status, c.effective_from INTO facts FROM machvon.contract c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contract_id;
      IF facts.status IS DISTINCT FROM 'ACTIVE' OR facts.effective_from IS NULL OR facts.effective_from > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
        RAISE EXCEPTION 'ADVANCE_CONTRACT_NOT_EFFECTIVE: an advance is asked for on a contract that is in force' USING ERRCODE = '23514';
      END IF;
      IF NEW.cap_rule_version_id IS NULL THEN
        RAISE EXCEPTION 'an advance keeps the version of the rule that capped it' USING ERRCODE = '23514';
      END IF;
      IF NEW.kind = 'CONTRACT' THEN
        SELECT g.* INTO covering FROM machvon.guarantee g WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.guarantee_id;
        IF NOT FOUND OR covering.contract_id <> NEW.contract_id OR covering.kind <> 'ADVANCE' OR covering.status <> 'ACTIVE' OR covering.verification_status <> 'VERIFIED'
           OR covering.expires_at <= now() OR covering.amount_vnd < NEW.amount_vnd OR (covering.party_id IS NOT NULL AND covering.party_id <> NEW.party_id) THEN
          RAISE EXCEPTION 'ADVANCE_GUARANTEE_REQUIRED: an advance of a contract is covered by an active, verified guarantee that is valid and large enough' USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.party_id, NEW.tranche_no, NEW.kind, NEW.amount_vnd, NEW.cap_vnd, NEW.cap_rule_version_id, NEW.guarantee_id, NEW.allocation_line_id, NEW.recovery_threshold_pct, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.party_id, OLD.tranche_no, OLD.kind, OLD.amount_vnd, OLD.cap_vnd, OLD.cap_rule_version_id, OLD.guarantee_id, OLD.allocation_line_id, OLD.recovery_threshold_pct, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an advance is about never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('PLANNED', 'REQUESTED'), ('PLANNED', 'CANCELLED'), ('REQUESTED', 'PLANNED'), ('REQUESTED', 'PAID'), ('REQUESTED', 'CANCELLED'), ('PAID', 'PLANNED'),
                   ('PAID', 'RECOVERING'), ('PAID', 'FULLY_RECOVERED'), ('RECOVERING', 'PAID'), ('RECOVERING', 'FULLY_RECOVERED'), ('FULLY_RECOVERED', 'RECOVERING'), ('FULLY_RECOVERED', 'PAID')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'ADVANCE_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  -- The money paid is fixed at the moment it is paid, and taken back only when the payment is reversed before anything was recovered.
  IF NEW.paid_vnd IS DISTINCT FROM OLD.paid_vnd AND NOT (OLD.status = 'REQUESTED' AND NEW.status = 'PAID' AND OLD.paid_vnd = 0) AND NOT (OLD.status = 'PAID' AND NEW.status = 'PLANNED' AND OLD.recovered_vnd = 0 AND NEW.paid_vnd = 0) THEN
    RAISE EXCEPTION 'ADVANCE_STATE_INVALID: the amount paid is set once, when the advance is paid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

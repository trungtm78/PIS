-- Authored by hand (not generated): matching a Treasury transaction to a payment and the work on a difference (ST-PAY-007, PAY 3.3 steps 4 and 5, CXN-03).
-- V002 and V1560 gave treasury_transaction and reconciliation_item their columns, the key under which a voucher is counted once and the guard that fixes what a transaction says. This adds what
-- makes a match a match: a request is SETTLED only by one matched transaction of exactly its net, on the line of capital of its year, and carries the day the Treasury paid (the day the
-- disbursement counts from, R-PAY-05); an item of difference moves only along the edges of its life, is written off only with the document that approves it and by someone other than its owner,
-- and remembers that it was reported overdue so that it is reported once.

ALTER TABLE machvon.payment_request
  ADD COLUMN treasury_paid_on date,
  ADD COLUMN settled_transaction_id uuid,
  ADD COLUMN settled_by uuid,
  ADD COLUMN settled_at timestamptz;
ALTER TABLE machvon.payment_request
  ADD CONSTRAINT payment_request_settled_transaction_fk FOREIGN KEY (tenant_id, settled_transaction_id) REFERENCES machvon.treasury_transaction (tenant_id, id),
  ADD CONSTRAINT payment_request_settled_by_fk FOREIGN KEY (tenant_id, settled_by) REFERENCES machvon.membership (tenant_id, id),
  -- A settled request (and one that was reversed after it) says which transaction settled it, on which day the Treasury paid, who matched it and when; any other request says none of it.
  ADD CONSTRAINT payment_request_settled_chk CHECK (
    (status IN ('SETTLED', 'REVERSED')) = (settled_transaction_id IS NOT NULL)
    AND (settled_transaction_id IS NOT NULL) = (treasury_paid_on IS NOT NULL)
    AND (settled_transaction_id IS NOT NULL) = (settled_by IS NOT NULL)
    AND (settled_transaction_id IS NOT NULL) = (settled_at IS NOT NULL)
  );
CREATE INDEX payment_request_settled_transaction_id_idx ON machvon.payment_request (tenant_id, settled_transaction_id);
CREATE INDEX payment_request_treasury_paid_on_idx ON machvon.payment_request (tenant_id, treasury_paid_on) WHERE treasury_paid_on IS NOT NULL;

-- A payment request is settled by one transaction, and a transaction settles one request.
CREATE UNIQUE INDEX treasury_transaction_matched_request_uq ON machvon.treasury_transaction (tenant_id, payment_request_id)
  WHERE match_status = 'MATCHED' AND direction = 'PAYMENT';

-- The match: a transaction becomes MATCHED only against a request that is with the Treasury, of the same project, for exactly the amount, and it is tied to one request for good.
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
    IF NOT EXISTS (
      SELECT 1 FROM machvon.payment_request pr
       WHERE pr.tenant_id = NEW.tenant_id AND pr.id = NEW.payment_request_id AND pr.status = 'SENT_TREASURY' AND pr.project_id = NEW.project_id
         AND pr.net_vnd = NEW.amount_vnd AND NEW.direction = 'PAYMENT'
    ) THEN
      RAISE EXCEPTION 'TRANSACTION_NOT_MATCHABLE: a transaction is matched to a request with the Treasury of the same project, for exactly its net' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- The settlement: a request is SETTLED only by the transaction that was matched to it, on the day the Treasury paid (Vietnam time), on the line of capital of the year of the request; an
-- advance is settled only once it has been paid for the amount asked.
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
  END IF;
  RETURN NEW;
END;
$fn$;

-- The work on a difference.
ALTER TABLE machvon.reconciliation_item
  ADD COLUMN approval_document_version_id uuid,
  ADD COLUMN overdue_flagged_at timestamptz;
ALTER TABLE machvon.reconciliation_item
  ADD CONSTRAINT reconciliation_item_approval_fk FOREIGN KEY (tenant_id, approval_document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  -- A difference is written off with the document that approves it, by someone other than the person who owned it.
  ADD CONSTRAINT reconciliation_item_write_off_chk CHECK (status <> 'WRITTEN_OFF_APPROVED' OR (approval_document_version_id IS NOT NULL AND resolved_by <> owner_membership_id)),
  -- An item that still waits has no resolver, no day of resolution and no approval.
  ADD CONSTRAINT reconciliation_item_waiting_chk CHECK (status NOT IN ('OPEN', 'EXPLAINED') OR (resolved_by IS NULL AND resolved_at IS NULL AND approval_document_version_id IS NULL));
CREATE INDEX reconciliation_item_approval_document_version_id_idx ON machvon.reconciliation_item (tenant_id, approval_document_version_id);
-- The pass that reports the overdue finds the items that wait, are late and were not yet reported.
CREATE INDEX reconciliation_item_unreported_idx ON machvon.reconciliation_item (tenant_id, due_at, id) WHERE status IN ('OPEN', 'EXPLAINED') AND overdue_flagged_at IS NULL;

CREATE FUNCTION machvon.guard_reconciliation_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'RECONCILIATION_STATE_INVALID: an item of difference begins open' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.payment_request_id, NEW.treasury_transaction_id, NEW.import_row_id, NEW.kind, NEW.internal_amount_vnd, NEW.confirmed_amount_vnd, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.payment_request_id, OLD.treasury_transaction_id, OLD.import_row_id, OLD.kind, OLD.internal_amount_vnd, OLD.confirmed_amount_vnd, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a difference keeps the two figures it was opened with' USING ERRCODE = '23514';
  END IF;
  -- An item that ended is kept as it is; the issue that was opened for it while it waited may still be written back. (The difference is generated after this trigger runs, so it is left out of the comparison.)
  IF OLD.status IN ('RESOLVED', 'WRITTEN_OFF_APPROVED') AND (to_jsonb(NEW) - 'issue_id' - 'difference_vnd') IS DISTINCT FROM (to_jsonb(OLD) - 'issue_id' - 'difference_vnd') THEN
    RAISE EXCEPTION 'RECONCILIATION_STATE_INVALID: an item that ended is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('OPEN', 'EXPLAINED'), ('OPEN', 'WRITTEN_OFF_APPROVED'), ('EXPLAINED', 'RESOLVED'), ('EXPLAINED', 'WRITTEN_OFF_APPROVED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'RECONCILIATION_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER reconciliation_item_guard BEFORE INSERT OR UPDATE ON machvon.reconciliation_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_reconciliation_item();

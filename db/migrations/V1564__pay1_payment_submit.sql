-- Authored by hand (not generated): sending, checking and returning a payment request (ST-PAY-003, PAY 3.1 step 3 and the branches, BR-PAY-02, BR-PAY-16).
-- V1563 holds the draft. This adds who returned a request and why, the note of the checker, and what keeps the sending honest when the application is bypassed: a request that is sent says who sent it
-- (the checker must be neither the one who drew it up nor the one who sent it, which a request without a sender would escape), one that is checked says who checked it, one that is returned says who
-- returned it and why, the advance ledger is append-only like the cumulative ledger, and a hold of retention goes only when its request is returned.

ALTER TABLE machvon.payment_request
  ADD COLUMN returned_by uuid,
  ADD COLUMN returned_at timestamptz,
  ADD COLUMN returned_by_treasury boolean NOT NULL DEFAULT false,
  ADD COLUMN verification_note text;

ALTER TABLE machvon.payment_request
  ADD CONSTRAINT payment_request_note_chk CHECK (verification_note IS NULL OR (verification_note = btrim(verification_note) AND verification_note <> '' AND char_length(verification_note) <= 2000));

CREATE OR REPLACE FUNCTION machvon.guard_payment_request() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
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
  END IF;
  RETURN NEW;
END;
$fn$;

-- The advance ledger is kept like the cumulative one: an entry is never changed or deleted, by the runtime role or by anyone else.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.advance_ledger_entry FROM machvon_app;

CREATE FUNCTION machvon.guard_advance_ledger_entry_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'LEDGER_ENTRY_IMMUTABLE: a posted entry is corrected by an entry that reverses it' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER advance_ledger_entry_append_only BEFORE UPDATE OR DELETE ON machvon.advance_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_advance_ledger_entry_append_only();
CREATE TRIGGER advance_ledger_entry_no_truncate BEFORE TRUNCATE ON machvon.advance_ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_advance_ledger_entry_append_only();

-- What is held back is held for a request that was sent: it goes (the request is returned, and nothing was ever paid on it) only with that request, and never otherwise.
CREATE FUNCTION machvon.guard_retention_hold_delete() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM machvon.payment_request p WHERE p.tenant_id = OLD.tenant_id AND p.id = OLD.payment_request_id AND p.status = 'RETURNED') OR OLD.released_vnd <> 0 THEN
    RAISE EXCEPTION 'a hold of retention goes only with the request that is returned, and only while nothing of it is released' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER retention_hold_delete_guard BEFORE DELETE ON machvon.retention_hold
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_retention_hold_delete();

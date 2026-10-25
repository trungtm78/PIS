-- Authored by hand (not generated): the draft of a payment request (ST-PAY-002, PAY 3.1 and 5, BR-PAY-03..08, BR-PAY-17).
-- The tables payment_request, payment_request_line and payment_document come from the generated schema (V002, with the row level security, the net checks, the claim check, the one claim for
-- an acceptance, the number of a request in a contract, the one document version in a request and the one invoice number in a contract). This adds what the commands rely on and what keeps a
-- request honest when the application is bypassed: the basis of the tax adjustment and the extra recovery that went into the amounts, the guard of the edges of the status, amounts that
-- change only while the request is a draft, lines that are lines of the acceptance and worth what it says, lines that add up to the header at every commit, and documents that are clean,
-- of the contract of the request, written while it is a draft and kept as they are.

ALTER TABLE machvon.payment_request
  ADD COLUMN tax_adjustment_basis text,
  ADD COLUMN advance_recovery_extra_vnd numeric(24,0) NOT NULL DEFAULT 0;

ALTER TABLE machvon.payment_request
  ADD CONSTRAINT payment_request_draft_text_chk CHECK (
    (request_no IS NULL OR (request_no = btrim(request_no) AND request_no <> '' AND char_length(request_no) <= 100))
    AND (tax_adjustment_basis IS NULL OR (tax_adjustment_basis = btrim(tax_adjustment_basis) AND tax_adjustment_basis <> '' AND char_length(tax_adjustment_basis) <= 2000))
    AND (return_reason IS NULL OR (return_reason = btrim(return_reason) AND return_reason <> '' AND char_length(return_reason) <= 2000))
    AND (cancel_reason IS NULL OR (cancel_reason = btrim(cancel_reason) AND cancel_reason <> '' AND char_length(cancel_reason) <= 2000))
  ),
  -- A tax adjustment says what it is based on, and a request that is a draft has a number.
  ADD CONSTRAINT payment_request_tax_basis_chk CHECK (tax_adjustment_vnd = 0 OR tax_adjustment_basis IS NOT NULL),
  ADD CONSTRAINT payment_request_number_chk CHECK (status NOT IN ('DRAFT', 'RETURNED') OR request_no IS NOT NULL),
  ADD CONSTRAINT payment_request_extra_chk CHECK (advance_recovery_extra_vnd >= 0),
  ADD CONSTRAINT payment_request_cancel_chk CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  -- A request that takes a settlement is the final one.
  ADD CONSTRAINT payment_request_settlement_chk CHECK (settlement_revision_id IS NULL OR request_kind = 'FINAL');

-- The edges of the status (PAY 4): a request moves DRAFT -> SUBMITTED -> VERIFIED -> SENT_TREASURY -> SETTLED -> REVERSED, is returned from the three middle ones to be corrected and sent again,
-- and is cancelled from the draft or the returned. Nothing leaves CANCELLED or REVERSED. What a request is about never changes; its amounts, number and capital line change only while it is a draft
-- (or has been returned, which is the one move that opens it again, back to DRAFT).
CREATE FUNCTION machvon.guard_payment_request() RETURNS trigger
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
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER payment_request_guard BEFORE INSERT OR UPDATE ON machvon.payment_request
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_payment_request();

-- A line is a line of the acceptance of its request, worth what the acceptance says, and is written only while the request is a draft or returned.
CREATE FUNCTION machvon.guard_payment_request_line() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent machvon.payment_request%ROWTYPE;
  target uuid;
  tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target := OLD.payment_request_id;
    tenant := OLD.tenant_id;
  ELSE
    target := NEW.payment_request_id;
    tenant := NEW.tenant_id;
  END IF;
  SELECT * INTO parent FROM machvon.payment_request WHERE tenant_id = tenant AND id = target;
  IF NOT FOUND OR parent.status NOT IN ('DRAFT', 'RETURNED') THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: the lines of a request are written while it is a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF parent.request_kind = 'ADVANCE' THEN
    RAISE EXCEPTION 'a request for an advance has no lines' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.payment_request_id, NEW.acceptance_line_id, NEW.boq_item_id, NEW.party_id) IS DISTINCT FROM (OLD.tenant_id, OLD.payment_request_id, OLD.acceptance_line_id, OLD.boq_item_id, OLD.party_id) THEN
    RAISE EXCEPTION 'what a line of a payment request is about never changes' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM machvon.acceptance_line l
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.acceptance_line_id AND l.acceptance_id = parent.acceptance_id
       AND l.boq_item_id = NEW.boq_item_id AND l.party_id IS NOT DISTINCT FROM NEW.party_id AND l.amount_vnd = NEW.gross_vnd
  ) THEN
    RAISE EXCEPTION 'a line of a payment request is a line of its acceptance, worth what the acceptance says' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER payment_request_line_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.payment_request_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_payment_request_line();

-- At every commit the lines of a request add up to its header: gross is the gross of the acceptance, recovery and retention are the sums of the lines, and the net of the header is the net of
-- the lines plus the tax adjustment (which belongs to the header only). A draft is held to it always; a request past the draft is held to it when it has lines (the lines are kept as they were when it was sent).
CREATE FUNCTION machvon.check_payment_request_sum() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target uuid;
  tenant uuid;
  header machvon.payment_request%ROWTYPE;
  summed record;
  accepted numeric;
BEGIN
  IF TG_TABLE_NAME = 'payment_request' THEN
    target := NEW.id;
    tenant := NEW.tenant_id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.payment_request_id;
    tenant := OLD.tenant_id;
  ELSE
    target := NEW.payment_request_id;
    tenant := NEW.tenant_id;
  END IF;
  SELECT * INTO header FROM machvon.payment_request WHERE tenant_id = tenant AND id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS lines, COALESCE(sum(gross_vnd), 0) AS gross, COALESCE(sum(advance_recovery_vnd), 0) AS recovery, COALESCE(sum(retention_vnd), 0) AS retention, COALESCE(sum(net_vnd), 0) AS net
    INTO summed FROM machvon.payment_request_line WHERE tenant_id = tenant AND payment_request_id = target;
  IF header.request_kind = 'ADVANCE' THEN
    IF summed.lines > 0 OR header.advance_recovery_vnd <> 0 OR header.retention_vnd <> 0 THEN
      RAISE EXCEPTION 'PAYMENT_NET_MISMATCH: a request for an advance has no lines, recovery or retention' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF header.status = 'DRAFT' OR summed.lines > 0 THEN
    SELECT accepted_amount_vnd INTO accepted FROM machvon.acceptance WHERE tenant_id = tenant AND id = header.acceptance_id;
    IF (header.gross_vnd, header.advance_recovery_vnd, header.retention_vnd) IS DISTINCT FROM (summed.gross, summed.recovery, summed.retention)
       OR header.net_vnd <> summed.net + header.tax_adjustment_vnd
       OR (header.status = 'DRAFT' AND header.gross_vnd IS DISTINCT FROM accepted) THEN
      RAISE EXCEPTION 'PAYMENT_NET_MISMATCH: the lines of a payment request add up to its header and its gross is the gross of the acceptance' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER payment_request_sum AFTER INSERT OR UPDATE ON machvon.payment_request
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_payment_request_sum();
CREATE CONSTRAINT TRIGGER payment_request_line_sum AFTER INSERT OR UPDATE OR DELETE ON machvon.payment_request_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_payment_request_sum();

-- A document is of the contract of the request, a clean version of a file, and its checksum is that of the file; it is attached while the request is a draft or returned, and kept as it is.
CREATE FUNCTION machvon.guard_payment_document() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent machvon.payment_request%ROWTYPE;
  version_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a document attached to a payment request is kept as it is' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO parent FROM machvon.payment_request WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_request_id;
  IF NOT FOUND OR parent.status NOT IN ('DRAFT', 'RETURNED') THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: documents are attached while the request is a draft' USING ERRCODE = '23514';
  END IF;
  IF parent.contract_id <> NEW.contract_id THEN
    RAISE EXCEPTION 'a document is of the contract of its payment request' USING ERRCODE = '23514';
  END IF;
  SELECT scan_status, checksum INTO version_row FROM machvon.document_version WHERE tenant_id = NEW.tenant_id AND id = NEW.document_version_id;
  IF NOT FOUND OR version_row.scan_status <> 'CLEAN' THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_CLEAN: only a clean version of a file is attached' USING ERRCODE = '23514';
  END IF;
  IF version_row.checksum IS DISTINCT FROM NEW.checksum THEN
    RAISE EXCEPTION 'the checksum of a document is that of its file' USING ERRCODE = '23514';
  END IF;
  IF NEW.doc_kind <> 'INVOICE' AND (NEW.invoice_no IS NOT NULL OR NEW.invoice_date IS NOT NULL OR NEW.duplicate_override_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'only an invoice has a number, a date and an override' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER payment_document_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.payment_document
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_payment_document();

ALTER TABLE machvon.payment_document
  ADD CONSTRAINT payment_document_text_chk CHECK (
    (invoice_no IS NULL OR (invoice_no = btrim(invoice_no) AND invoice_no <> '' AND char_length(invoice_no) <= 100))
    AND (duplicate_override_reason IS NULL OR (duplicate_override_reason = btrim(duplicate_override_reason) AND duplicate_override_reason <> '' AND char_length(duplicate_override_reason) <= 2000))
  );

-- The list of requests is read in a stable order, for the whole tenant and for one contract.
CREATE INDEX payment_request_order_idx ON machvon.payment_request (tenant_id, created_at, id);
CREATE INDEX payment_request_contract_order_idx ON machvon.payment_request (tenant_id, contract_id, created_at, id);

-- A payment request is never deleted, a document is never changed or deleted, and a line is written only while its request is a draft (the guard above); the runtime role holds no more right than that.
REVOKE DELETE, TRUNCATE ON TABLE machvon.payment_request FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.payment_request_line FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.payment_document FROM machvon_app;

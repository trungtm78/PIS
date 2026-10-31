-- Authored by hand (not generated): the forms of a settlement of a year or of a completed project (ST-PAY-012, PAY 3.5 step 3, CXN-09).
-- The table payment_form_instance holds the forms of a settlement as well as those of a payment request (subject_kind SETTLEMENT, settlement_revision_id, the unique index of the form that stands) and V1566 made
-- a form a proof. This adds what the forms of a settlement need to be honest when the application is bypassed: they are drawn for a settlement that is verified, with a code of its scope (01 to 05/QTNĐ for a year, 01 to 12/QTDA for a project; a settlement of
-- one contract has none), and the form is one of the 17 codes of the settlement (01 to 05/QTNĐ, 01 to 12/QTDA). The codes below are those of packages/kernel/src/pay-settlement-forms.ts and await the original forms (CXN-09).

ALTER TABLE machvon.payment_form_instance
  ADD CONSTRAINT payment_form_instance_settlement_code_chk CHECK (subject_kind <> 'SETTLEMENT' OR form_code ~ '^(0[1-5]/QTNĐ|(0[1-9]|1[0-2])/QTDA)$');

CREATE OR REPLACE FUNCTION machvon.guard_payment_form_instance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- A form becomes a proof when it is generated, by an insert or by the move from requested: it is judged then, whichever way it got there.
  IF NEW.status = 'GENERATED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'GENERATED') THEN
    -- A form is drawn for a request that has been checked; it is the figures of that request.
    IF NEW.subject_kind = 'PAYMENT_REQUEST' AND NOT EXISTS (
      SELECT 1 FROM machvon.payment_request p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_request_id AND p.status = 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'PAYMENT_STATE_INVALID: the forms are drawn for a request that is checked' USING ERRCODE = '23514';
    END IF;
    -- A form of a settlement is drawn for a settlement that is verified, and is one of its scope: 01 to 05/QTNĐ for a year, 01 to 12/QTDA for a project (a settlement of one contract has none).
    IF NEW.subject_kind = 'SETTLEMENT' AND NOT EXISTS (
      SELECT 1 FROM machvon.settlement_revision s
       WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.settlement_revision_id AND s.status = 'VERIFIED'
         AND ((s.settlement_scope = 'ANNUAL' AND NEW.form_code LIKE '%/QTNĐ') OR (s.settlement_scope = 'PROJECT' AND NEW.form_code LIKE '%/QTDA'))
    ) THEN
      RAISE EXCEPTION 'SETTLEMENT_STATE_INVALID: the forms are drawn for a settlement that is verified' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a form that was drawn is kept: a new one replaces it' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.subject_kind, NEW.payment_request_id, NEW.settlement_revision_id, NEW.form_code, NEW.template_version_id, NEW.template_code, NEW.template_revision, NEW.document_id,
      NEW.document_version_id, NEW.file_sha256, NEW.payload_sha256, NEW.input_sha256, NEW.legal_basis, NEW.generated_at, NEW.generated_by, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.subject_kind, OLD.payment_request_id, OLD.settlement_revision_id, OLD.form_code, OLD.template_version_id, OLD.template_code, OLD.template_revision, OLD.document_id,
      OLD.document_version_id, OLD.file_sha256, OLD.payload_sha256, OLD.input_sha256, OLD.legal_basis, OLD.generated_at, OLD.generated_by, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a form says never changes: a new form replaces it' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('REQUESTED', 'GENERATED'), ('REQUESTED', 'FAILED'), ('GENERATED', 'SUPERSEDED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'this move of the status of a form is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

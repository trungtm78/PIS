-- Authored by hand (not generated): the Treasury forms of a payment request and the record that the file was sent (ST-PAY-005, PAY 3.3 steps 1 and 2, CXN-08).
-- The table payment_form_instance is in V002 with its status and the unique index of the form that stands. This adds what makes a generated form a proof: the file it is (document, version and
-- hash), the template revision it was drawn from with the legal basis of that revision, the hash of the payload that filled it; a form is made for a request that is checked and goes only
-- from generated to superseded; and a request is recorded as sent to the Treasury only with the date, the person and a standing form of each of the four kinds. The four codes below are the
-- ones of packages/kernel/src/pay-forms.ts; they await the original appendix of Decree 254/2025 (CXN-08).

ALTER TABLE machvon.payment_form_instance
  ADD COLUMN document_id uuid,
  ADD COLUMN document_version_id uuid,
  ADD COLUMN template_code text,
  ADD COLUMN template_revision integer,
  ADD COLUMN payload_sha256 char(64),
  ADD COLUMN input_sha256 char(64);

ALTER TABLE machvon.payment_form_instance
  ADD CONSTRAINT payment_form_instance_document_version_fk FOREIGN KEY (tenant_id, document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  ADD CONSTRAINT payment_form_instance_document_fk FOREIGN KEY (tenant_id, document_id) REFERENCES machvon.document (tenant_id, id),
  ADD CONSTRAINT payment_form_instance_hash_chk CHECK (
    (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$') AND (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$') AND (input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$')
  ),
  -- A form that stands, or one that stood, is the proof of what was sent: the template it came from, the legal basis, the file and the hash of what filled it.
  ADD CONSTRAINT payment_form_instance_generated_chk CHECK (
    status NOT IN ('GENERATED', 'SUPERSEDED')
    OR (template_version_id IS NOT NULL AND template_code IS NOT NULL AND template_revision IS NOT NULL AND document_id IS NOT NULL AND document_version_id IS NOT NULL
        AND file_sha256 IS NOT NULL AND payload_sha256 IS NOT NULL AND input_sha256 IS NOT NULL AND generated_at IS NOT NULL AND generated_by IS NOT NULL)
  ),
  ADD CONSTRAINT payment_form_instance_text_chk CHECK (form_code = btrim(form_code) AND form_code <> '' AND legal_basis = btrim(legal_basis) AND legal_basis <> '');

CREATE INDEX payment_form_instance_document_id_idx ON machvon.payment_form_instance (tenant_id, document_id);
CREATE INDEX payment_form_instance_document_version_id_idx ON machvon.payment_form_instance (tenant_id, document_version_id);

ALTER TABLE machvon.payment_request
  ADD COLUMN treasury_sent_by uuid,
  ADD COLUMN treasury_sent_at timestamptz;

ALTER TABLE machvon.payment_request
  ADD CONSTRAINT payment_request_treasury_ref_chk CHECK (treasury_ref IS NULL OR (treasury_ref = btrim(treasury_ref) AND treasury_ref <> '' AND char_length(treasury_ref) <= 200)),
  ADD CONSTRAINT payment_request_treasury_sent_chk CHECK ((treasury_sent_by IS NULL) = (treasury_sent_at IS NULL) AND (treasury_sent_by IS NULL) = (treasury_submitted_on IS NULL));

REVOKE DELETE, TRUNCATE ON TABLE machvon.payment_form_instance FROM machvon_app;

CREATE FUNCTION machvon.guard_payment_form_instance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A form is drawn for a request that has been checked; it is the figures of that request.
    IF NEW.subject_kind = 'PAYMENT_REQUEST' AND NEW.status = 'GENERATED' AND NOT EXISTS (
      SELECT 1 FROM machvon.payment_request p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_request_id AND p.status = 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'PAYMENT_STATE_INVALID: the forms are drawn for a request that is checked' USING ERRCODE = '23514';
    END IF;
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

CREATE FUNCTION machvon.guard_payment_form_instance_truncate() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the forms that were drawn are kept' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER payment_form_instance_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.payment_form_instance
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_payment_form_instance();
CREATE TRIGGER payment_form_instance_no_truncate BEFORE TRUNCATE ON machvon.payment_form_instance
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_payment_form_instance_truncate();

-- The request goes to the Treasury with the day it was sent, the person who sent it and a standing form of each of the four kinds.
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
    IF NEW.status = 'SENT_TREASURY' THEN
      IF NEW.treasury_submitted_on IS NULL OR NEW.treasury_sent_by IS NULL OR NEW.treasury_sent_at IS NULL THEN
        RAISE EXCEPTION 'a request sent to the Treasury says on which day, by whom and when' USING ERRCODE = '23514';
      END IF;
      IF (SELECT count(DISTINCT f.form_code) FROM machvon.payment_form_instance f
           WHERE f.tenant_id = NEW.tenant_id AND f.payment_request_id = NEW.id AND f.status = 'GENERATED' AND f.form_code IN ('03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT')) <> 4 THEN
        RAISE EXCEPTION 'FORMS_NOT_GENERATED: a request goes to the Treasury with a form of each of the four kinds' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Authored by hand (not generated): issuing an outgoing document and distributing it (ST-DOC-010, DOC.md F7 and F8, BR-DOC-10, BR-DOC-17).
-- The table document_distribution comes from the generated schema (V002: one row per recipient and channel, unique per document). This slice makes it a record:
--   * Which recipients must acknowledge. The design says "all mandatory recipients acknowledge" but the table has no column that says which ones are mandatory:
--     `acknowledgement_required` (default true) is that column. A copy sent for information needs no receipt.
--   * The rows are kept for good (retention 10 years): the runtime role cannot delete or truncate them, and a guard trigger holds what a row says about its
--     recipient and channel, the order of its states (PENDING, SENT, DELIVERED, ACKNOWLEDGED, with FAILED and CANCELLED on the side) and the instants that
--     were proven: the instant of the receipt never changes once it is written.
--   * The text of a row is stored as it is shown: trimmed and not empty. The internal channel delivers into a unit of this system, so it needs one.
--   * A document that has been issued never goes back to a state before the issue, and the instant of the issue and the reason of an override of an
--     unconfirmed template never change (the override is the legal record of why a document with a watermark went out).

REVOKE DELETE, TRUNCATE ON TABLE machvon.document_distribution FROM machvon_app;

ALTER TABLE machvon.document_distribution
  ADD COLUMN acknowledgement_required boolean NOT NULL DEFAULT true;

ALTER TABLE machvon.document_distribution
  ADD CONSTRAINT document_distribution_name_chk CHECK (recipient_name = btrim(recipient_name) AND recipient_name <> '' AND char_length(recipient_name) <= 300),
  ADD CONSTRAINT document_distribution_code_chk CHECK (recipient_code IS NULL OR (recipient_code = btrim(recipient_code) AND recipient_code <> '' AND char_length(recipient_code) <= 100)),
  ADD CONSTRAINT document_distribution_ref_chk CHECK (external_ref IS NULL OR (external_ref = btrim(external_ref) AND external_ref <> '' AND char_length(external_ref) <= 120)),
  ADD CONSTRAINT document_distribution_internal_chk CHECK (channel <> 'INTERNAL' OR (recipient_kind = 'INTERNAL_UNIT' AND recipient_unit_id IS NOT NULL)),
  ADD CONSTRAINT document_distribution_attempts_chk CHECK (attempts >= 0),
  ADD CONSTRAINT document_distribution_sent_chk CHECK (status NOT IN ('SENT', 'DELIVERED', 'ACKNOWLEDGED') OR sent_at IS NOT NULL),
  ADD CONSTRAINT document_distribution_delivered_chk CHECK (status NOT IN ('DELIVERED', 'ACKNOWLEDGED') OR delivered_at IS NOT NULL),
  ADD CONSTRAINT document_distribution_failed_chk CHECK ((status = 'FAILED') = (error_code IS NOT NULL) AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z_]{2,59}$')),
  ADD CONSTRAINT document_distribution_order_chk CHECK (
    (sent_at IS NULL OR delivered_at IS NULL OR sent_at <= delivered_at)
    AND (delivered_at IS NULL OR acknowledged_at IS NULL OR delivered_at <= acknowledged_at));

CREATE INDEX document_distribution_status_idx ON machvon.document_distribution (tenant_id, outgoing_document_id, status);

CREATE FUNCTION machvon.guard_document_distribution() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'distributions are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF NEW.outgoing_document_id <> OLD.outgoing_document_id
     OR NEW.recipient_kind <> OLD.recipient_kind
     OR NEW.recipient_unit_id IS DISTINCT FROM OLD.recipient_unit_id
     OR NEW.recipient_name <> OLD.recipient_name
     OR NEW.recipient_code IS DISTINCT FROM OLD.recipient_code
     OR NEW.channel <> OLD.channel
     OR NEW.acknowledgement_required <> OLD.acknowledgement_required
     OR NEW.created_at <> OLD.created_at
     OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'the recipient, the channel and the duty to acknowledge of a distribution never change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('SENT', 'DELIVERED', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'SENT' AND NEW.status IN ('DELIVERED', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'DELIVERED' AND NEW.status IN ('ACKNOWLEDGED', 'CANCELLED'))
    OR (OLD.status = 'FAILED' AND NEW.status IN ('SENT', 'DELIVERED', 'FAILED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'a distribution does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('ACKNOWLEDGED', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a distribution that has ended stays as it was' USING ERRCODE = '23514';
  END IF;
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'the instant of delivery never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at OR NEW.external_ref IS DISTINCT FROM OLD.external_ref) THEN
    RAISE EXCEPTION 'the receipt of a distribution is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at AND (NEW.sent_at IS NULL OR NEW.sent_at < OLD.sent_at) THEN
    RAISE EXCEPTION 'the instant of sending only moves forward' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'attempts are counted, never taken back' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_distribution_guard BEFORE UPDATE OR DELETE ON machvon.document_distribution
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_distribution();
CREATE TRIGGER document_distribution_no_truncate BEFORE TRUNCATE ON machvon.document_distribution
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_document_distribution();

-- The override of an unconfirmed template is a written reason of a person (BR-DOC-10).
ALTER TABLE machvon.outgoing_document
  ADD CONSTRAINT outgoing_document_override_chk CHECK (
    unconfirmed_override_reason IS NULL
    OR (unconfirmed_override_by IS NOT NULL AND unconfirmed_override_reason = btrim(unconfirmed_override_reason) AND char_length(unconfirmed_override_reason) BETWEEN 20 AND 1000 AND status IN ('ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED', 'ARCHIVED', 'RECALLED', 'REPLACED', 'CORRECTED')));

CREATE OR REPLACE FUNCTION machvon.guard_outgoing_document() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'outgoing documents are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
      USING ERRCODE = '42501';
  END IF;
  IF NEW.document_id <> OLD.document_id
     OR NEW.drafter_user_id <> OLD.drafter_user_id
     OR NEW.drafting_unit_id <> OLD.drafting_unit_id
     OR NEW.layout_profile_id <> OLD.layout_profile_id THEN
    RAISE EXCEPTION 'the document, the drafter, the drafting unit and the layout of an outgoing document never change' USING ERRCODE = '23514';
  END IF;
  IF NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.source_module IS DISTINCT FROM OLD.source_module
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.issue_request_id IS DISTINCT FROM OLD.issue_request_id THEN
    RAISE EXCEPTION 'the template and the source of an outgoing document never change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'DRAFT'
     AND (NEW.payload_json IS DISTINCT FROM OLD.payload_json
          OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
          OR NEW.signer_user_id IS DISTINCT FROM OLD.signer_user_id
          OR NEW.signer_title IS DISTINCT FROM OLD.signer_title
          OR NEW.signing_mode IS DISTINCT FROM OLD.signing_mode
          OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
          OR NEW.recipients IS DISTINCT FROM OLD.recipients
          OR NEW.urgency IS DISTINCT FROM OLD.urgency
          OR NEW.circulation IS DISTINCT FROM OLD.circulation) THEN
    RAISE EXCEPTION 'the content, the signer and the recipients of an outgoing document are fixed once it leaves the draft' USING ERRCODE = '23514';
  END IF;
  IF OLD.leader_signed_at IS NOT NULL AND NEW.leader_signed_at IS DISTINCT FROM OLD.leader_signed_at THEN
    RAISE EXCEPTION 'the instant of the leader signature never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at THEN
    RAISE EXCEPTION 'the instant of the organisation seal never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.issued_at IS NOT NULL AND NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'the instant of the issue never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.unconfirmed_override_reason IS NOT NULL
     AND (NEW.unconfirmed_override_reason IS DISTINCT FROM OLD.unconfirmed_override_reason OR NEW.unconfirmed_override_by IS DISTINCT FROM OLD.unconfirmed_override_by) THEN
    RAISE EXCEPTION 'the override of an unconfirmed template is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('SIGNED', 'NUMBERED', 'SEALED') AND NEW.status IN ('DRAFT', 'IN_REVIEW', 'SUBMITTED') THEN
    RAISE EXCEPTION 'a signed outgoing document does not go back to a state before the signature' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('ISSUED', 'DELIVERED', 'ACKNOWLEDGED') AND NEW.status IN ('DRAFT', 'IN_REVIEW', 'SUBMITTED', 'SIGNED', 'NUMBERED', 'SEALED') THEN
    RAISE EXCEPTION 'an issued outgoing document does not go back to a state before the issue' USING ERRCODE = '23514';
  END IF;
  IF (OLD.status = 'DELIVERED' AND NEW.status = 'ISSUED') OR (OLD.status = 'ACKNOWLEDGED' AND NEW.status IN ('ISSUED', 'DELIVERED')) THEN
    RAISE EXCEPTION 'the distribution of a document does not go back' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- A recipient written with other capitals is the same recipient: resending never makes a second row (DOC.md F8).
CREATE UNIQUE INDEX document_distribution_recipient_ci_uq ON machvon.document_distribution (tenant_id, outgoing_document_id, lower(recipient_name), channel);

-- Authored by hand (not generated): the issue request that a source module sends to DOC (ST-DOC-008, DOC.md F2, BR-DOC-17).
-- V002 gave `doc_issue_request` its columns, the unique (source_module, event_id) that makes one event one request, and the unique open
-- (source_module, source_ref, payload_sha256) that keeps a second request for the same content out while the first one lives. This slice
-- makes the request provable from the database alone:
--   * It is kept for good (retention 10 years): the runtime role cannot delete or truncate it.
--   * What the source asked for never changes: module, reference, template, hash, payload location, event and requester are fixed when the row
--     is written. Only the outcome moves, along the state machine of DOC.md section 4: RECEIVED to ACCEPTED or REJECTED, ACCEPTED to ISSUED or
--     CANCELLED, ISSUED to RECALLED. REJECTED, CANCELLED and RECALLED are final.
--   * The outcome is complete: an accepted request names the outgoing document it produced, a rejected one names one of the reasons the module
--     document lists (and the state secret refusal of BR-DOC-20), and a request that has been decided says when.
--   * Listing indexes for the foreign keys.

REVOKE DELETE, TRUNCATE ON TABLE machvon.doc_issue_request FROM machvon_app;

ALTER TABLE machvon.doc_issue_request
  ADD CONSTRAINT doc_issue_request_module_chk CHECK (source_module ~ '^[A-Z]{2,10}$'),
  ADD CONSTRAINT doc_issue_request_reject_code_chk CHECK (
    (status = 'REJECTED') = (reject_code IS NOT NULL)
    AND (reject_code IS NULL OR reject_code IN ('DOC_TEMPLATE_MISSING', 'TEMPLATE_NOT_EFFECTIVE', 'PAYLOAD_HASH_MISMATCH', 'PAYLOAD_SCHEMA_INVALID', 'STATE_SECRET_NOT_SUPPORTED'))),
  ADD CONSTRAINT doc_issue_request_document_chk CHECK ((status IN ('RECEIVED', 'REJECTED')) = (outgoing_document_id IS NULL)),
  ADD CONSTRAINT doc_issue_request_completed_chk CHECK ((status = 'RECEIVED') = (completed_at IS NULL));

CREATE INDEX doc_issue_request_outgoing_idx ON machvon.doc_issue_request (tenant_id, outgoing_document_id) WHERE outgoing_document_id IS NOT NULL;
CREATE INDEX doc_issue_request_template_idx ON machvon.doc_issue_request (tenant_id, template_id) WHERE template_id IS NOT NULL;
CREATE INDEX doc_issue_request_source_idx ON machvon.doc_issue_request (tenant_id, source_module, source_ref, created_at DESC);

CREATE FUNCTION machvon.guard_doc_issue_request() RETURNS trigger
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
    RAISE EXCEPTION 'issue requests are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF NEW.source_module IS DISTINCT FROM OLD.source_module
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.template_code IS DISTINCT FROM OLD.template_code
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.payload_ref IS DISTINCT FROM OLD.payload_ref
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.signer_hint IS DISTINCT FROM OLD.signer_hint
     OR NEW.recipients_hint IS DISTINCT FROM OLD.recipients_hint THEN
    RAISE EXCEPTION 'what a source module asked for never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'RECEIVED' AND NEW.status IN ('ACCEPTED', 'REJECTED'))
    OR (OLD.status = 'ACCEPTED' AND NEW.status IN ('ISSUED', 'CANCELLED'))
    OR (OLD.status = 'ISSUED' AND NEW.status = 'RECALLED')) THEN
    RAISE EXCEPTION 'an issue request does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED', 'RECALLED') THEN
    RAISE EXCEPTION 'a request that has ended stays as it was' USING ERRCODE = '23514';
  END IF;
  IF OLD.outgoing_document_id IS NOT NULL AND NEW.outgoing_document_id IS DISTINCT FROM OLD.outgoing_document_id THEN
    RAISE EXCEPTION 'the document an issue request produced never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER doc_issue_request_guard BEFORE UPDATE OR DELETE ON machvon.doc_issue_request
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_doc_issue_request();
CREATE TRIGGER doc_issue_request_no_truncate BEFORE TRUNCATE ON machvon.doc_issue_request
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_doc_issue_request();

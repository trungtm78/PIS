-- Authored by hand (not generated): handing a dossier over to the archive, proposing and deciding its disposal, and the governance of the retention rules (ST-DOC-017, DOC.md F11, BR-DOC-22, BR-DOC-23).
-- V1226 gave the dossier its states, the retention written when it is closed and the exclusion of overlapping published rules. What the three new steps rest on is put into the database here, whatever the application
-- checked first:
--   * the handover of a dossier says where it went (the reference of the archive), when, and who handed it over; a dossier that was handed over keeps it;
--   * a disposal is proposed by one person with a reason and decided by another (the same person cannot do both); a dossier that is provisional is never proposed; a disposal that is approved needs the decision of the
--     council (a document), one that is rejected sends the dossier back to the state it was proposed from and clears the proposal; a disposed dossier is final and keeps who proposed, who decided and when;
--   * the job `doc.handover-due` reminds the archivists of a dossier whose handover is due 30, 7 and 1 days ahead, once for each, and keeps the smallest of the three in `handover_reminded_days`;
--   * a retention rule is drafted by one person, published by another and confirmed (its legal basis) by a third who is neither: its content never changes after it is written, its approval is written once, and nothing is deleted.

ALTER TABLE machvon.dossier
  ADD COLUMN handed_over_by uuid,
  ADD COLUMN disposal_proposed_by uuid,
  ADD COLUMN disposal_proposed_at timestamptz,
  ADD COLUMN disposal_reason text,
  ADD COLUMN disposal_from_status text,
  ADD COLUMN disposal_decided_by uuid,
  ADD COLUMN disposal_decided_at timestamptz,
  ADD COLUMN disposal_comment text,
  ADD COLUMN handover_reminded_days smallint;

ALTER TABLE machvon.dossier
  ADD CONSTRAINT dossier_handover_chk CHECK (status NOT IN ('HANDED_OVER', 'ARCHIVED') OR (handed_over_at IS NOT NULL AND archive_ref IS NOT NULL AND handed_over_by IS NOT NULL)),
  ADD CONSTRAINT dossier_handover_reminder_chk CHECK (handover_reminded_days IS NULL OR handover_reminded_days IN (30, 7, 1)),
  ADD CONSTRAINT dossier_handover_ref_chk CHECK (archive_ref IS NULL OR (archive_ref = btrim(archive_ref) AND char_length(archive_ref) BETWEEN 3 AND 200)),
  ADD CONSTRAINT dossier_disposal_chk CHECK (
    (status IN ('DISPOSAL_PROPOSED', 'DISPOSED') AND disposal_proposed_by IS NOT NULL AND disposal_proposed_at IS NOT NULL AND disposal_reason IS NOT NULL AND disposal_from_status IN ('CLOSED', 'HANDED_OVER', 'ARCHIVED'))
    OR (status NOT IN ('DISPOSAL_PROPOSED', 'DISPOSED') AND disposal_proposed_by IS NULL AND disposal_proposed_at IS NULL AND disposal_reason IS NULL AND disposal_from_status IS NULL)),
  ADD CONSTRAINT dossier_disposal_decision_chk CHECK (
    (status = 'DISPOSED' AND disposal_decided_by IS NOT NULL AND disposal_decided_at IS NOT NULL)
    OR (status <> 'DISPOSED' AND disposal_decided_by IS NULL AND disposal_decided_at IS NULL AND disposal_comment IS NULL)),
  ADD CONSTRAINT dossier_disposal_sod_chk CHECK (disposal_decided_by IS NULL OR disposal_decided_by <> disposal_proposed_by),
  ADD CONSTRAINT dossier_disposal_reason_chk CHECK (disposal_reason IS NULL OR (disposal_reason = btrim(disposal_reason) AND char_length(disposal_reason) BETWEEN 10 AND 2000));

CREATE OR REPLACE FUNCTION machvon.guard_dossier() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.dossier_code, NEW.year, NEW.organization_unit_id, NEW.category_code, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.dossier_code, OLD.year, OLD.organization_unit_id, OLD.category_code, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'the code, year, unit and category of a dossier are not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    EXISTS (
      SELECT 1
        FROM (VALUES ('OPEN', 'CLOSED'), ('CLOSED', 'HANDED_OVER'), ('CLOSED', 'DISPOSAL_PROPOSED'), ('HANDED_OVER', 'ARCHIVED'), ('HANDED_OVER', 'DISPOSAL_PROPOSED'),
                     ('ARCHIVED', 'DISPOSAL_PROPOSED'), ('DISPOSAL_PROPOSED', 'DISPOSED')) AS allowed (from_status, to_status)
       WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status)
    -- A disposal that is rejected sends the dossier back to the state it was proposed from.
    OR (OLD.status = 'DISPOSAL_PROPOSED' AND NEW.status = OLD.disposal_from_status)
  ) THEN
    RAISE EXCEPTION 'a dossier does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', DETAIL = 'DOSSIER_STATE_INVALID';
  END IF;
  -- A dossier that is provisional is kept for ever: it is never proposed for disposal.
  IF NEW.status = 'DISPOSAL_PROPOSED' AND OLD.status <> 'DISPOSAL_PROPOSED' AND NEW.provisional_retention THEN
    RAISE EXCEPTION 'a provisional dossier is not proposed for disposal' USING ERRCODE = '23514', DETAIL = 'RETENTION_PROVISIONAL';
  END IF;
  -- What closing wrote down stays as it was; the one exception is a dossier that was provisional, which a later command may settle once.
  IF OLD.status <> 'OPEN' AND NOT OLD.provisional_retention
     AND (NEW.retention_rule_id, NEW.retention_class_code, NEW.provisional_retention, NEW.retention_ends_on, NEW.handover_due_on, NEW.closed_at, NEW.closed_by, NEW.settlement_closed_on)
         IS DISTINCT FROM (OLD.retention_rule_id, OLD.retention_class_code, OLD.provisional_retention, OLD.retention_ends_on, OLD.handover_due_on, OLD.closed_at, OLD.closed_by, OLD.settlement_closed_on) THEN
    RAISE EXCEPTION 'the retention written when a dossier was closed is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'OPEN' AND OLD.provisional_retention AND (NEW.closed_at, NEW.closed_by) IS DISTINCT FROM (OLD.closed_at, OLD.closed_by) THEN
    RAISE EXCEPTION 'the day a dossier was closed is not rewritten' USING ERRCODE = '23514';
  END IF;
  -- The handover is written once, by the move that makes it.
  IF OLD.handed_over_at IS NOT NULL AND (NEW.handed_over_at, NEW.archive_ref, NEW.handed_over_by) IS DISTINCT FROM (OLD.handed_over_at, OLD.archive_ref, OLD.handed_over_by) THEN
    RAISE EXCEPTION 'the handover of a dossier is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DISPOSED' THEN
    RAISE EXCEPTION 'a disposed dossier is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- The proposals waiting for the decision of the council, found by tenant.
CREATE INDEX dossier_disposal_idx ON machvon.dossier (tenant_id, status) WHERE status = 'DISPOSAL_PROPOSED';

-- ---- the retention rules ----------------------------------------------------------------------------------------------------------------------------

ALTER TABLE machvon.doc_retention_rule
  ADD COLUMN published_at timestamptz,
  ADD COLUMN legal_confirmed_by uuid,
  ADD COLUMN legal_confirmed_at timestamptz,
  ADD COLUMN legal_evidence_document_id uuid,
  ADD COLUMN legal_confirmation_note text;

ALTER TABLE machvon.doc_retention_rule
  ADD CONSTRAINT doc_retention_rule_evidence_fk FOREIGN KEY (tenant_id, legal_evidence_document_id) REFERENCES machvon.document (tenant_id, id),
  ADD CONSTRAINT doc_retention_rule_confirmed_chk CHECK (
    (confirmation_status = 'CONFIRMED' AND legal_confirmation_ref IS NOT NULL) OR confirmation_status = 'PENDING_CONFIRMATION') NOT VALID,
  ADD CONSTRAINT doc_retention_rule_basis_chk CHECK (legal_basis = btrim(legal_basis) AND char_length(legal_basis) BETWEEN 3 AND 2000) NOT VALID;
-- NOT VALID: the two checks judge every row written from now on, as the retention rules of the tenants that exist keep what they were written with.

CREATE INDEX doc_retention_rule_evidence_idx ON machvon.doc_retention_rule (tenant_id, legal_evidence_document_id);

CREATE FUNCTION machvon.guard_doc_retention_rule() RETURNS trigger
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
    RAISE EXCEPTION 'retention rules are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;

  -- The content of a rule is fixed when it is written.
  IF (to_jsonb(NEW) - ARRAY['status', 'approved_by', 'published_at', 'confirmation_status', 'legal_confirmation_ref', 'legal_confirmed_by', 'legal_confirmed_at', 'legal_evidence_document_id', 'legal_confirmation_note',
        'updated_at', 'updated_by', 'version'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approved_by', 'published_at', 'confirmation_status', 'legal_confirmation_ref', 'legal_confirmed_by', 'legal_confirmed_at', 'legal_evidence_document_id',
        'legal_confirmation_note', 'updated_at', 'updated_by', 'version']) THEN
    RAISE EXCEPTION 'the content of a retention rule never changes (UPDATE on %.% by %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;

  IF NOT (OLD.status = NEW.status OR (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED') OR (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a retention rule cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;

  -- The approval is written once, by the move to PUBLISHED.
  IF OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED' THEN
    IF NEW.approved_by IS NULL OR NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'publishing a retention rule names the approver and the time' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'the approval of a retention rule is written once' USING ERRCODE = '42501';
  END IF;

  -- The legal confirmation: PENDING_CONFIRMATION to CONFIRMED once, on a published rule, with its reference and evidence, by someone who neither drafted nor published it. It is never undone here.
  IF NEW.confirmation_status IS DISTINCT FROM OLD.confirmation_status THEN
    IF NOT (OLD.confirmation_status = 'PENDING_CONFIRMATION' AND NEW.confirmation_status = 'CONFIRMED' AND OLD.status = 'PUBLISHED' AND NEW.status = 'PUBLISHED') THEN
      RAISE EXCEPTION 'a retention rule can only be confirmed once, while it is published' USING ERRCODE = '42501';
    END IF;
    IF NEW.legal_confirmation_ref IS NULL OR NEW.legal_evidence_document_id IS NULL OR NEW.legal_confirmed_by IS NULL OR NEW.legal_confirmed_by = OLD.created_by
       OR NEW.legal_confirmed_by IS NOT DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'the legal confirmation needs its reference, its evidence and a confirmer who is neither the drafter nor the publisher' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.legal_confirmation_ref IS DISTINCT FROM OLD.legal_confirmation_ref OR NEW.legal_confirmed_by IS DISTINCT FROM OLD.legal_confirmed_by OR NEW.legal_confirmed_at IS DISTINCT FROM OLD.legal_confirmed_at
     OR NEW.legal_evidence_document_id IS DISTINCT FROM OLD.legal_evidence_document_id OR NEW.legal_confirmation_note IS DISTINCT FROM OLD.legal_confirmation_note THEN
    RAISE EXCEPTION 'the legal confirmation of a retention rule is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER doc_retention_rule_guard BEFORE UPDATE OR DELETE ON machvon.doc_retention_rule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_doc_retention_rule();
CREATE TRIGGER doc_retention_rule_no_truncate BEFORE TRUNCATE ON machvon.doc_retention_rule
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_doc_retention_rule();

REVOKE DELETE, TRUNCATE ON TABLE machvon.doc_retention_rule FROM machvon_app;

-- The reminder to the archivists of a dossier whose handover falls due (DOC 3 F11, job doc-handover-due). The payload names the dossier by its id and code, the day and the stage, never its title.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'doc.handover_due.v1',
  'DOC',
  1,
  '{"type":"object","required":["tenant_id","dossier_id","handover_due_on","days_left","stage"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"dossier_id":{"type":"string","format":"uuid"},"dossier_code":{"type":"string"},"version":{"type":"integer"},"handover_due_on":{"type":"string","format":"date"},"days_left":{"type":"integer"},"stage":{"type":"integer","enum":[30,7,1]},"organization_unit_id":{"type":"string","format":"uuid"},"notification":{"type":"object"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;

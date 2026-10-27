-- ST-MNE-003: review, approval and issuance of the monitoring report through the document engine (MNE 3.1 F3, BR-MNE-02, DOC 9).
--
-- V1702 kept who handed a report in. This migration keeps what the decision, the request for issuance and the answer of DOC leave behind, and puts into the database the rules the commands rely on:
--   * who decided a report, when and why (an approval and a return both leave the words);
--   * what is frozen when issuance is asked for: the hash of the payload, where the payload is kept and the event that asked, so that the answer of DOC can be matched to it;
--   * when DOC answered, and when it recalled what it had issued;
--   * the one who approves is neither the one who wrote the report nor the one who handed it in;
--   * a report moves along the states of MNE 3.1 section 4 only, and keeps the hash and the document it was given.

ALTER TABLE machvon.mne_report
  ADD COLUMN decided_by uuid,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text,
  ADD COLUMN issue_requested_at timestamptz,
  ADD COLUMN issue_event_id uuid,
  ADD COLUMN payload_ref text,
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN recalled_at timestamptz;

ALTER TABLE machvon.mne_report
  ADD CONSTRAINT mne_report_approver_sod_chk CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by),
  ADD CONSTRAINT mne_report_review_chk CHECK (status <> 'IN_REVIEW' OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL)),
  ADD CONSTRAINT mne_report_approved_chk CHECK (status NOT IN ('APPROVED', 'ISSUING', 'ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL') OR (approved_by IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  ADD CONSTRAINT mne_report_issuing_chk CHECK (status <> 'ISSUING' OR (payload_sha256 IS NOT NULL AND payload_ref IS NOT NULL AND issue_event_id IS NOT NULL AND issue_requested_at IS NOT NULL)),
  ADD CONSTRAINT mne_report_issued_at_chk CHECK (status NOT IN ('ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL') OR issued_at IS NOT NULL),
  ADD CONSTRAINT mne_report_decision_text_chk CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 5 AND 2000);

CREATE UNIQUE INDEX mne_report_issue_event_uq ON machvon.mne_report (tenant_id, issue_event_id) WHERE issue_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION machvon.guard_mne_report() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.form_id IS DISTINCT FROM OLD.form_id OR NEW.scope_unit_id IS DISTINCT FROM OLD.scope_unit_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.report_year IS DISTINCT FROM OLD.report_year OR NEW.period_label IS DISTINCT FROM OLD.period_label
     OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'a monitoring report keeps its form, unit, project, period and revision for good' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.payload_json IS DISTINCT FROM OLD.payload_json) THEN
    RAISE EXCEPTION 'a monitoring report that left DRAFT keeps its snapshot and its figures: a correction is a new revision' USING ERRCODE = '23514';
  END IF;
  IF (OLD.payload_sha256 IS NOT NULL AND NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256)
     OR (OLD.doc_document_id IS NOT NULL AND NEW.doc_document_id IS DISTINCT FROM OLD.doc_document_id) THEN
    RAISE EXCEPTION 'a monitoring report keeps the hash it was frozen with and the document it was issued as' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN (
       ('DRAFT', 'IN_REVIEW'), ('IN_REVIEW', 'DRAFT'), ('IN_REVIEW', 'APPROVED'), ('APPROVED', 'ISSUING'), ('ISSUING', 'ISSUED'), ('ISSUING', 'APPROVED'),
       ('ISSUED', 'EXPORTED'), ('EXPORTED', 'SUBMITTED_EXTERNAL'), ('SUBMITTED_EXTERNAL', 'RETURNED'),
       ('ISSUED', 'SUPERSEDED'), ('EXPORTED', 'SUPERSEDED'), ('SUBMITTED_EXTERNAL', 'SUPERSEDED'), ('RETURNED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'the state transition of the monitoring report is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- Authored by hand (not generated): the settlement of a project, of a year or of a contract (ST-PAY-009, PAY 3.5, BR-PAY-15, BR-PAY-16, UAT-AC339, UAT-AC66, UAT-PLAN-21).
-- V002 gave the table its columns and the checks on the money, the scope, the close and the deadline. This adds who did what and when, the document that approved the exception, what the close rests on,
-- the days the deadline was computed with (so a later change of the rule does not change a deadline already given), the reminders sent, and what keeps the settlement honest when the application is
-- bypassed: one settlement being worked for a project, a scope, a contract and a year; the status moves along the edges of PAY 4; the figures are read again only while the settlement is a draft or has
-- been returned; whoever verifies, approves the exception or closes is not who prepared it; a settlement is never deleted.

ALTER TABLE machvon.settlement_revision
  ALTER COLUMN audit_finding_refs SET DEFAULT '[]'::jsonb;

ALTER TABLE machvon.settlement_revision
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN deadline_days integer,
  ADD COLUMN deadline_rule_awaiting_confirmation boolean,
  ADD COLUMN verification_findings text,
  ADD COLUMN verified_by uuid,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN figures_refreshed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN figures_note text,
  ADD COLUMN exception_approval_document_version_id uuid,
  ADD COLUMN closed_by uuid,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN close_reason text,
  ADD COLUMN close_evidence_ids jsonb,
  ADD COLUMN deadline_t30_sent_at timestamptz,
  ADD COLUMN deadline_t7_sent_at timestamptz,
  ADD COLUMN deadline_overdue_sent_at timestamptz;

-- The foreign keys to the project, the contract, the earlier revision and the decision document are in V002.
ALTER TABLE machvon.settlement_revision
  ADD CONSTRAINT settlement_revision_exception_document_fk FOREIGN KEY (tenant_id, exception_approval_document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  ADD CONSTRAINT settlement_revision_submitted_by_fk FOREIGN KEY (tenant_id, submitted_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT settlement_revision_verified_by_fk FOREIGN KEY (tenant_id, verified_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT settlement_revision_exception_by_fk FOREIGN KEY (tenant_id, exception_approved_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT settlement_revision_closed_by_fk FOREIGN KEY (tenant_id, closed_by) REFERENCES machvon.membership (tenant_id, id);

ALTER TABLE machvon.settlement_revision
  ADD CONSTRAINT settlement_revision_revision_chk CHECK (revision >= 1),
  ADD CONSTRAINT settlement_revision_deadline_days_chk CHECK (deadline_days IS NULL OR deadline_days BETWEEN 1 AND 366),
  -- A settlement that was sent says who sent it, when, and with which rule the deadline was given; the one that is a draft carries none of it.
  ADD CONSTRAINT settlement_revision_submitted_chk CHECK (
    (status IN ('DRAFT', 'SUPERSEDED') AND submitted_on IS NULL)
    OR (status = 'SUPERSEDED')
    OR (status <> 'DRAFT' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND project_group IS NOT NULL AND deadline_rule_version_id IS NOT NULL AND deadline_days IS NOT NULL
        AND verification_due_on IS NOT NULL)
  ),
  ADD CONSTRAINT settlement_revision_exception_chk CHECK (
    (exception_reason IS NULL AND exception_approved_by IS NULL AND exception_approved_at IS NULL AND exception_approval_document_version_id IS NULL)
    OR (exception_reason IS NOT NULL AND exception_approved_by IS NOT NULL AND exception_approved_at IS NOT NULL AND exception_approval_document_version_id IS NOT NULL
        AND exception_approved_by IS DISTINCT FROM created_by AND exception_approved_by IS DISTINCT FROM submitted_by)
  ),
  ADD CONSTRAINT settlement_revision_verifier_chk CHECK (verified_by IS NULL OR verified_by IS DISTINCT FROM submitted_by),
  ADD CONSTRAINT settlement_revision_closed_chk CHECK (
    (status <> 'CLOSED' AND closed_at IS NULL)
    OR (status = 'SUPERSEDED')
    OR (status = 'CLOSED' AND closed_by IS NOT NULL AND closed_at IS NOT NULL AND close_reason IS NOT NULL AND decision_document_version_id IS NOT NULL AND verified_by IS NOT NULL
        AND closed_by IS DISTINCT FROM created_by AND closed_by IS DISTINCT FROM submitted_by)
  ),
  ADD CONSTRAINT settlement_revision_verified_chk CHECK (status NOT IN ('VERIFIED', 'CLOSED') OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verified_on IS NOT NULL));

-- One settlement is worked on for a project, a scope, a contract and a year; a closed one gives way to the next revision, which supersedes it.
CREATE UNIQUE INDEX settlement_revision_open_uq
  ON machvon.settlement_revision (tenant_id, project_id, contract_id, settlement_scope, fiscal_year) NULLS NOT DISTINCT
  WHERE status IN ('DRAFT', 'SUBMITTED', 'VERIFYING', 'VERIFIED', 'RETURNED');

-- The indexes on the rule, the documents, the earlier revision, the project, the contract and the deadline are in V002.

REVOKE DELETE, TRUNCATE ON TABLE machvon.settlement_revision FROM machvon_app;

CREATE FUNCTION machvon.guard_settlement_revision() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'SETTLEMENT_STATE_INVALID: a settlement is opened as a draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.settlement_scope, NEW.fiscal_year, NEW.revision, NEW.supersedes_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.settlement_scope, OLD.fiscal_year, OLD.revision, OLD.supersedes_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a settlement is about never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'SUBMITTED'), ('RETURNED', 'SUBMITTED'), ('SUBMITTED', 'VERIFYING'), ('SUBMITTED', 'RETURNED'), ('VERIFYING', 'VERIFIED'), ('VERIFYING', 'RETURNED'),
                   ('RETURNED', 'DRAFT'), ('VERIFIED', 'CLOSED'), ('CLOSED', 'SUPERSEDED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  -- The figures are read from the ledgers again only while the settlement is a draft or has been returned; after that they are what was sent.
  IF (NEW.settled_amount_vnd, NEW.outstanding_vnd, NEW.unrecovered_advance_vnd) IS DISTINCT FROM (OLD.settled_amount_vnd, OLD.outstanding_vnd, OLD.unrecovered_advance_vnd)
     AND OLD.status NOT IN ('DRAFT', 'RETURNED') THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_INVALID: the figures of a settlement that was sent are not changed' USING ERRCODE = '23514';
  END IF;
  -- The deadline is given once, when the settlement is sent, and kept: a later change of the rule does not move it.
  IF (NEW.submitted_on, NEW.project_group, NEW.verification_due_on, NEW.deadline_rule_version_id, NEW.deadline_days) IS DISTINCT FROM
     (OLD.submitted_on, OLD.project_group, OLD.verification_due_on, OLD.deadline_rule_version_id, OLD.deadline_days)
     AND NOT (OLD.status IN ('DRAFT', 'RETURNED') OR NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_INVALID: the deadline of a settlement that was sent is not changed' USING ERRCODE = '23514';
  END IF;
  -- The exception is approved for the settlement as it stands when it is verified, and is not taken back.
  IF OLD.exception_approved_at IS NOT NULL AND (NEW.exception_reason, NEW.exception_approved_by, NEW.exception_approved_at, NEW.exception_approval_document_version_id)
     IS DISTINCT FROM (OLD.exception_reason, OLD.exception_approved_by, OLD.exception_approved_at, OLD.exception_approval_document_version_id) THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_INVALID: an approved exception is not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.exception_approved_at IS DISTINCT FROM OLD.exception_approved_at AND OLD.exception_approved_at IS NULL AND OLD.status <> 'VERIFIED' THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_INVALID: an exception is approved for a settlement that was verified' USING ERRCODE = '23514';
  END IF;
  -- Nothing but the move to the next revision touches a settlement that was closed.
  IF OLD.status = 'CLOSED' AND NEW.status = 'CLOSED' THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_INVALID: a closed settlement is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER settlement_revision_guard BEFORE INSERT OR UPDATE ON machvon.settlement_revision
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_settlement_revision();

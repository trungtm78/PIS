-- Authored by hand (not generated): the extension of the disbursement of capital to the next year (ST-CAP-007, CAP 3.1 F6, BR-CAP-04).
-- V002 gave `allocation_extension` its states, the rule that an approved extension rests on a document and the four-eyes CHECK. Carrying capital over moves money
-- from the plan of one year into the capital of the next, so the database holds what the command relies on, whatever the application checked first:
--   * what was asked for never changes (the line, the project, the year, the last day, the amount, the reason and its words, who asked): a change of mind is a new
--     request; a request moves forward only and is never deleted;
--   * the last day of disbursement lies in the year after the plan year, the reason is one of the four of the contract and `KHAC` (other) is explained;
--   * the decision leaves its facts together: who decided (never the requester), when, why, and for an approval the document, the approver and the line and the
--     appropriation of the next year that the approval made;
--   * an entry that extends capital out of a line or into one names the line and the project, as an entry that allocates or reduces does (V1363).

ALTER TABLE machvon.allocation_extension
  ADD COLUMN justification text,
  ADD COLUMN decision_reason text,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decided_by uuid,
  ADD COLUMN new_appropriation_id uuid;

ALTER TABLE machvon.allocation_extension
  ADD CONSTRAINT allocation_extension_reason_code_chk CHECK (reason_code IN ('GPMB_CHAM', 'VUONG_MAC_PHAP_LY', 'THIEN_TAI_DICH_BENH', 'KHAC')),
  ADD CONSTRAINT allocation_extension_year_chk CHECK (from_plan_year BETWEEN 1990 AND 2099),
  ADD CONSTRAINT allocation_extension_window_chk CHECK (extended_to > make_date(from_plan_year, 12, 31) AND extended_to <= make_date(from_plan_year + 1, 12, 31)),
  ADD CONSTRAINT allocation_extension_justification_chk CHECK (
    (justification IS NULL OR (justification = btrim(justification) AND char_length(justification) BETWEEN 20 AND 2000)) AND (reason_code <> 'KHAC' OR justification IS NOT NULL)
  ),
  ADD CONSTRAINT allocation_extension_decision_reason_chk CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 5 AND 2000)),
  ADD CONSTRAINT allocation_extension_decider_chk CHECK (decided_by IS NULL OR decided_by <> created_by),
  ADD CONSTRAINT allocation_extension_decision_chk CHECK (
    (status IN ('APPROVED', 'APPLIED', 'REJECTED')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
    AND (status IN ('APPROVED', 'APPLIED')) = (approved_by IS NOT NULL)
    AND (approved_by IS NULL OR approved_by = decided_by)
  ),
  ADD CONSTRAINT allocation_extension_applied_chk CHECK ((status = 'APPLIED') = (new_allocation_line_id IS NOT NULL AND new_appropriation_id IS NOT NULL)),
  ADD CONSTRAINT allocation_extension_line_fk FOREIGN KEY (tenant_id, allocation_line_id) REFERENCES machvon.allocation_line (tenant_id, id),
  ADD CONSTRAINT allocation_extension_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  ADD CONSTRAINT allocation_extension_document_fk FOREIGN KEY (tenant_id, approving_document_id) REFERENCES machvon.document (tenant_id, id),
  ADD CONSTRAINT allocation_extension_new_line_fk FOREIGN KEY (tenant_id, new_allocation_line_id) REFERENCES machvon.allocation_line (tenant_id, id),
  ADD CONSTRAINT allocation_extension_new_appropriation_fk FOREIGN KEY (tenant_id, new_appropriation_id) REFERENCES machvon.appropriation (tenant_id, id);

CREATE FUNCTION machvon.guard_allocation_extension() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a request to carry capital over is kept for good' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.allocation_line_id, NEW.project_id, NEW.from_plan_year, NEW.extended_to, NEW.amount_vnd, NEW.reason_code, NEW.justification, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.allocation_line_id, OLD.project_id, OLD.from_plan_year, OLD.extended_to, OLD.amount_vnd, OLD.reason_code, OLD.justification, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a request to carry capital over asks for never changes: a change of mind is a new request' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED', 'APPLIED', 'REJECTED', 'LAPSED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPLIED', 'LAPSED'))) THEN
    RAISE EXCEPTION 'a request to carry capital over moves forward only (% to %)', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.decided_by IS NOT NULL
     AND (NEW.decided_by, NEW.decided_at, NEW.decision_reason, NEW.approved_by, NEW.approving_document_id) IS DISTINCT FROM (OLD.decided_by, OLD.decided_at, OLD.decision_reason, OLD.approved_by, OLD.approving_document_id) THEN
    RAISE EXCEPTION 'the decision on a request to carry capital over is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.new_allocation_line_id IS NOT NULL AND (NEW.new_allocation_line_id, NEW.new_appropriation_id) IS DISTINCT FROM (OLD.new_allocation_line_id, OLD.new_appropriation_id) THEN
    RAISE EXCEPTION 'the line and the appropriation that an extension made never change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER allocation_extension_guard BEFORE UPDATE OR DELETE ON machvon.allocation_extension
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_allocation_extension();

REVOKE DELETE, TRUNCATE ON TABLE machvon.allocation_extension FROM machvon_app;

-- An entry that extends capital out of a line or into one is for a line of a project (the reconciliation of the balances reads it by both).
ALTER TABLE machvon.capital_ledger_entry
  ADD CONSTRAINT capital_ledger_extend_line_chk CHECK (entry_type NOT IN ('EXTEND_OUT', 'EXTEND_IN') OR (allocation_line_id IS NOT NULL AND project_id IS NOT NULL));

-- The requests of a line (what is already promised on it), of a project and the lines, appropriation and document an extension names are found by index; a request
-- that nobody decided is found by the last day it could be decided.
CREATE INDEX allocation_extension_line_idx ON machvon.allocation_extension (tenant_id, allocation_line_id, status);
CREATE INDEX allocation_extension_project_idx ON machvon.allocation_extension (tenant_id, project_id);
CREATE INDEX allocation_extension_document_idx ON machvon.allocation_extension (tenant_id, approving_document_id);
CREATE INDEX allocation_extension_new_line_idx ON machvon.allocation_extension (tenant_id, new_allocation_line_id);
CREATE INDEX allocation_extension_new_appropriation_idx ON machvon.allocation_extension (tenant_id, new_appropriation_id);
CREATE INDEX allocation_extension_open_idx ON machvon.allocation_extension (tenant_id, extended_to) WHERE status IN ('REQUESTED', 'APPROVED');
CREATE INDEX allocation_extension_created_idx ON machvon.allocation_extension (tenant_id, created_at DESC, id DESC);

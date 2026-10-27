-- ST-PRJ-007: the transfer of a project between units, with an effective date and the attribution of history (PRJ 3.1 F10).
--
-- V002 gave `project_transfer` its columns, the check that the two units differ, the four-eyes check (the one who approves is not the one who asked) and the unique open request
-- for a project and a scope. This migration adds what the decision leaves behind and makes the database keep the order of a transfer's life:
--   * who decided, when, and the reason they gave (kept on the request, and not in the audit row);
--   * a request that was approved or applied names its approver, an applied one names the moment it was applied, a rejected or returned one has its reason;
--   * the job and the list read by day and by project.

ALTER TABLE machvon.project_transfer
  ADD COLUMN decision_reason text,
  ADD COLUMN decided_at timestamptz;

ALTER TABLE machvon.project_transfer
  ADD CONSTRAINT project_transfer_decision_chk CHECK (
    (status = 'REQUESTED' AND approved_by IS NULL AND decided_at IS NULL)
    OR (status IN ('APPROVED', 'APPLIED') AND approved_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
    OR (status IN ('REJECTED', 'CANCELLED') AND decided_at IS NOT NULL)
  ),
  ADD CONSTRAINT project_transfer_applied_chk CHECK ((status = 'APPLIED') = (applied_at IS NOT NULL)),
  ADD CONSTRAINT project_transfer_reason_chk CHECK (char_length(reason) BETWEEN 10 AND 2000 AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 5 AND 2000));

CREATE INDEX project_transfer_due_idx ON machvon.project_transfer (tenant_id, effective_date) WHERE status = 'APPROVED';
CREATE INDEX project_transfer_list_idx ON machvon.project_transfer (tenant_id, created_at DESC, id DESC);
CREATE INDEX project_transfer_project_idx ON machvon.project_transfer (tenant_id, project_id, created_at DESC);

-- Authored by hand (not generated): approval and publication of the capital plan (ST-CAP-003, CAP 3.1 F2 steps 3 to 5, BR-CAP-02, BR-CAP-05).
-- V002 gave `allocation_balance` (one row per line, CHECK allocated >= committed + disbursed) and `capital_ledger_entry` (append-only for the
-- runtime role, REVERSAL iff reversal_of_id, one fact once); V1361 made a reversal final. A plan is submitted, decided and published by three
-- commands, so the database holds what they rely on:
--   * the plan remembers who submitted it, when, who published it and why the last decision was taken, so a return is explained to the planner;
--   * a plan moves only with the people the step needs (a submitter, then an approver who is not the submitter, then a publication stamp), and
--     what the approval and the publication wrote is never edited afterwards;
--   * an entry that allocates or reduces capital names the line and the project it is for;
--   * the balance of a line is kept for good: the runtime role cannot delete or truncate it, because the ledger refers to the line it moved.

ALTER TABLE machvon.capital_plan
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text,
  ADD COLUMN published_by uuid,
  ADD CONSTRAINT capital_plan_decision_reason_chk CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 5 AND 2000));

-- The state machine of V1362 with the facts each step leaves. A legacy plan (backfilled by V1362) is never moved by these steps, so the
-- requirements are asked of the move, not of the row: a row that is already PUBLISHED may change its version and its audit columns only.
CREATE OR REPLACE FUNCTION machvon.guard_capital_plan_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.plan_code IS DISTINCT FROM OLD.plan_code
     OR NEW.plan_kind IS DISTINCT FROM OLD.plan_kind
     OR NEW.plan_year IS DISTINCT FROM OLD.plan_year
     OR NEW.period_from_year IS DISTINCT FROM OLD.period_from_year
     OR NEW.period_to_year IS DISTINCT FROM OLD.period_to_year
     OR NEW.scope_unit_id IS DISTINCT FROM OLD.scope_unit_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a capital plan keeps its code, kind, years, unit and revision for good' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REJECTED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'a rejected or superseded capital plan never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (('DRAFT', 'IN_REVIEW'), ('IN_REVIEW', 'DRAFT'), ('IN_REVIEW', 'APPROVED'), ('IN_REVIEW', 'REJECTED'), ('APPROVED', 'PUBLISHED'), ('PUBLISHED', 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'the state transition of the capital plan is not allowed' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'IN_REVIEW' AND NEW.submitted_by IS NULL THEN
      RAISE EXCEPTION 'a plan in review names the person who submitted it' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'APPROVED' AND (NEW.submitted_by IS NULL OR NEW.approved_by IS NULL) THEN
      RAISE EXCEPTION 'an approved plan names the person who submitted it and the one who approved it' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'PUBLISHED' AND (NEW.approved_by IS NULL OR NEW.published_at IS NULL) THEN
      RAISE EXCEPTION 'a published plan names its approver and the moment it was published' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status IN ('APPROVED', 'PUBLISHED') THEN
    -- The approval and the publication are final: only the version and the audit columns of the row may still change.
    IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.decision_document_id IS DISTINCT FROM OLD.decision_document_id OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
       OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by THEN
      RAISE EXCEPTION 'the approval and the publication of a capital plan are never edited' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- An entry that allocates or reduces capital is for a line of a project (the reconciliation of the balances reads it by both).
ALTER TABLE machvon.capital_ledger_entry
  ADD CONSTRAINT capital_ledger_allocation_line_chk CHECK (entry_type NOT IN ('ALLOCATE', 'REDUCE') OR (allocation_line_id IS NOT NULL AND project_id IS NOT NULL));

-- The balance of a line is the running total of its ledger entries: it is moved to the line of the next revision, never deleted.
REVOKE DELETE, TRUNCATE ON TABLE machvon.allocation_balance FROM machvon_app;

-- The publication finds the published revision of a plan code by index.
CREATE INDEX capital_plan_code_status_idx ON machvon.capital_plan (tenant_id, plan_code, status);

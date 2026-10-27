-- ST-CAP-010: the reallocation of capital from slow to fast projects, from a draft to an applied plan revision (CAP 3.1 F5, BR-CAP-05, BR-CAP-07).
--
-- V002 gave `reallocation_proposal` and `reallocation_line` their columns, the unique code, the check that a proposal is approved by someone other than the one who submitted it, and the check that a line moves
-- capital between two projects. This migration adds what the workflow leaves behind and puts into the database what the commands rely on:
--   * who decided a proposal, when and why (an approval, a rejection and a return all leave the words); who applied it and when;
--   * a line names the line of the receiving project it adds to, so that what the proposal moves is exactly the plan lines of one appropriation;
--   * each state of a proposal has what it needs: a submitted one its submitter, an approved one its approver, an applied one its decision document and the plan revision it made;
--   * the one who decides is neither the author nor the submitter of the proposal (the plan revision made on apply has the same maker and checker);
--   * a proposal moves along its state machine only, is final once applied, rejected or withdrawn, keeps its identity, and its lines change only while it is a draft.

ALTER TABLE machvon.reallocation_proposal
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN decided_by uuid,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text,
  ADD COLUMN applied_at timestamptz,
  ADD COLUMN applied_by uuid;

ALTER TABLE machvon.reallocation_line ADD COLUMN to_allocation_line_id uuid;

ALTER TABLE machvon.reallocation_proposal
  ADD CONSTRAINT reallocation_proposal_state_chk CHECK (
    status IN ('DRAFT', 'WITHDRAWN')
    OR (status = 'SUBMITTED' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
    OR (status = 'APPROVED' AND submitted_by IS NOT NULL AND approved_by IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
    OR (status = 'REJECTED' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
    OR (status = 'APPLIED' AND approved_by IS NOT NULL AND decision_document_id IS NOT NULL AND resulting_capital_plan_id IS NOT NULL AND applied_at IS NOT NULL AND applied_by IS NOT NULL)
  ),
  ADD CONSTRAINT reallocation_decider_sod_chk CHECK (decided_by IS NULL OR (decided_by <> created_by AND (submitted_by IS NULL OR decided_by <> submitted_by))),
  ADD CONSTRAINT reallocation_proposal_text_chk CHECK (char_length(reason) BETWEEN 20 AND 2000 AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 5 AND 2000) AND char_length(code) BETWEEN 1 AND 50);

ALTER TABLE machvon.reallocation_line
  ADD CONSTRAINT reallocation_line_target_chk CHECK (to_allocation_line_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT reallocation_line_target_fk FOREIGN KEY (tenant_id, to_allocation_line_id) REFERENCES machvon.allocation_line (tenant_id, id);

CREATE UNIQUE INDEX reallocation_line_pair_uq ON machvon.reallocation_line (tenant_id, proposal_id, from_allocation_line_id, to_allocation_line_id);
CREATE INDEX reallocation_line_target_idx ON machvon.reallocation_line (tenant_id, to_allocation_line_id);
CREATE INDEX reallocation_proposal_list_idx ON machvon.reallocation_proposal (tenant_id, plan_year, status, created_at DESC);
CREATE INDEX reallocation_proposal_plan_idx ON machvon.reallocation_proposal (tenant_id, source_capital_plan_id);

CREATE FUNCTION machvon.guard_reallocation_proposal() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.plan_year IS DISTINCT FROM OLD.plan_year
     OR NEW.scope_unit_id IS DISTINCT FROM OLD.scope_unit_id OR NEW.basis_snapshot_id IS DISTINCT FROM OLD.basis_snapshot_id
     OR NEW.source_capital_plan_id IS DISTINCT FROM OLD.source_capital_plan_id OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a proposal of reallocation keeps its code, year, unit, snapshot, plan and reason for good' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('APPLIED', 'REJECTED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'a proposal of reallocation that is applied, rejected or withdrawn never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN (('DRAFT', 'SUBMITTED'), ('DRAFT', 'WITHDRAWN'), ('SUBMITTED', 'APPROVED'), ('SUBMITTED', 'REJECTED'), ('SUBMITTED', 'DRAFT'), ('SUBMITTED', 'WITHDRAWN'), ('APPROVED', 'APPLIED')) THEN
    RAISE EXCEPTION 'the state transition of the proposal of reallocation is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER reallocation_proposal_guard BEFORE UPDATE ON machvon.reallocation_proposal FOR EACH ROW EXECUTE FUNCTION machvon.guard_reallocation_proposal();

CREATE FUNCTION machvon.guard_reallocation_line() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  held text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.proposal_id IS DISTINCT FROM OLD.proposal_id THEN
    RAISE EXCEPTION 'a line of a proposal of reallocation stays in its proposal' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO held FROM machvon.reallocation_proposal WHERE tenant_id = coalesce(OLD.tenant_id, NEW.tenant_id) AND id = coalesce(OLD.proposal_id, NEW.proposal_id);
  IF held IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the lines of a proposal of reallocation that is not a draft do not change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER reallocation_line_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.reallocation_line FOR EACH ROW EXECUTE FUNCTION machvon.guard_reallocation_line();

-- Proposals are kept for good (retention permanent).
REVOKE DELETE, TRUNCATE ON TABLE machvon.reallocation_proposal FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.reallocation_line FROM machvon_app;

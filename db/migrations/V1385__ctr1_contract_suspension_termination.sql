-- Authored by hand (not generated): the suspension, the resumption and the termination of a contract (ST-CTR-005, CTR 3.2, state machine of section 4).
-- The columns of the status decision (reason, decision document, suspended_from, terminated_on) come from the generated schema (V002); a termination also names who ended the
-- contract, the end of a contract is kept as it was written, and the violation that a termination suggests is suggested once.

ALTER TABLE machvon.contract ADD COLUMN terminated_by uuid;

-- Whoever ends a contract is not whoever drafted it (BR-CTR-15): the proposer and the approver are different people.
ALTER TABLE machvon.contract
  ADD CONSTRAINT contract_terminator_chk CHECK (terminated_by IS NULL OR created_by IS NULL OR terminated_by <> created_by);

-- The end of a contract does not change once it is written; the only move left from TERMINATED is to CLOSED (V1380), which keeps all of it.
CREATE FUNCTION machvon.guard_contract_termination() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.terminated_by IS NOT NULL AND (NEW.terminated_by, NEW.terminated_on, NEW.status_reason, NEW.status_decision_document_version_id)
     IS DISTINCT FROM (OLD.terminated_by, OLD.terminated_on, OLD.status_reason, OLD.status_decision_document_version_id) THEN
    RAISE EXCEPTION 'the termination of a contract does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_termination_guard BEFORE UPDATE ON machvon.contract
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_termination();

-- A termination suggests one violation for the contractor, for a person to confirm with a decision (CTR 3.2): never two for the same contract, unless the first was revoked.
CREATE UNIQUE INDEX contractor_violation_termination_uq ON machvon.contractor_violation (tenant_id, source_ref_id)
  WHERE source_module = 'CTR' AND penalty_kind = 'TERMINATION' AND status <> 'REVOKED';

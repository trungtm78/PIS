-- Authored by hand (not generated): the completion of a contract (ST-CTR-011, CTR 3.2, state machine of section 4).
-- A contract that is being performed is completed on the completion acceptance that was approved: the day it was completed, the acceptance it rests on and the person who completed it are
-- kept on the contract, and do not change once written.

ALTER TABLE machvon.contract
  ADD COLUMN completed_on date,
  ADD COLUMN completion_quality_acceptance_id uuid,
  ADD COLUMN completed_by uuid;

ALTER TABLE machvon.contract
  ADD CONSTRAINT contract_completion_chk CHECK (status <> 'COMPLETED' OR (completed_on IS NOT NULL AND completion_quality_acceptance_id IS NOT NULL AND completed_by IS NOT NULL)),
  ADD CONSTRAINT contract_completion_fields_chk CHECK ((completed_on IS NULL) = (completion_quality_acceptance_id IS NULL) AND (completed_on IS NULL) = (completed_by IS NULL)),
  ADD CONSTRAINT contract_completion_acceptance_fk FOREIGN KEY (tenant_id, completion_quality_acceptance_id) REFERENCES machvon.quality_acceptance (tenant_id, id),
  ADD CONSTRAINT contract_completion_actor_fk FOREIGN KEY (tenant_id, completed_by) REFERENCES machvon.membership (tenant_id, id);

-- The completion of a contract does not change once it is written; from COMPLETED the only move left is to CLOSED (V1380), which keeps all of it.
CREATE FUNCTION machvon.guard_contract_completion() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.completed_on IS NOT NULL AND (NEW.completed_on, NEW.completion_quality_acceptance_id, NEW.completed_by)
     IS DISTINCT FROM (OLD.completed_on, OLD.completion_quality_acceptance_id, OLD.completed_by) THEN
    RAISE EXCEPTION 'the completion of a contract does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_completion_guard BEFORE UPDATE ON machvon.contract
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_completion();

CREATE INDEX contract_completion_acceptance_idx ON machvon.contract (tenant_id, completion_quality_acceptance_id) WHERE completion_quality_acceptance_id IS NOT NULL;

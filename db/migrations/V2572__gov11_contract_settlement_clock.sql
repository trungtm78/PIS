-- Authored by hand (not generated): the settlement clock of a contract (GOV-11a, G1-18, CTR 3.2, PAY 3.5).
-- A contract that is completed has to hand in its settlement file within a number of calendar months that depends on the group of the project (5 for the large groups and 4 for the small one are the
-- starting values of the governance rule `CONTRACT_SETTLEMENT_DEADLINE`, flagged not confirmed). `contract_settlement_clock` keeps one row for each contract: the day it started (the completion of the
-- contract), the months and the day the rule gave then (so a later change of the rule does not move a deadline already given), and how it ended. NEAR and OVERDUE are not stored: they depend on the day it is read.
--   * one clock for a contract: the job `contract-settlement-clock` starts it once and a second pass finds it;
--   * what a clock is (contract, project, group, start, months, due day, policy) never changes; it ends once, MET or MET_LATE, with the day the file was handed in;
--   * the rows are kept for good: the runtime role cannot delete or truncate them.

CREATE TABLE machvon.contract_settlement_clock (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_unit_id uuid NOT NULL,
  project_group text,
  started_on date NOT NULL,
  months_allowed integer NOT NULL,
  due_on date NOT NULL,
  near_days integer NOT NULL,
  policy_version integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'OPEN',
  met_on date,
  settlement_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT contract_settlement_clock_contract_uq UNIQUE (tenant_id, contract_id),
  CONSTRAINT contract_settlement_clock_group_chk CHECK (project_group IS NULL OR project_group IN ('QTQG', 'A', 'B', 'C')),
  CONSTRAINT contract_settlement_clock_months_chk CHECK (months_allowed BETWEEN 1 AND 60 AND near_days BETWEEN 1 AND 120 AND policy_version >= 0 AND due_on > started_on),
  CONSTRAINT contract_settlement_clock_state_chk CHECK (state IN ('OPEN', 'MET', 'MET_LATE') AND ((state = 'OPEN') = (met_on IS NULL)) AND (state <> 'MET' OR met_on <= due_on) AND (state <> 'MET_LATE' OR met_on > due_on)),
  CONSTRAINT contract_settlement_clock_version_chk CHECK (version >= 1)
);

CREATE INDEX contract_settlement_clock_project_idx ON machvon.contract_settlement_clock (tenant_id, project_id, due_on, id);
CREATE INDEX contract_settlement_clock_unit_idx ON machvon.contract_settlement_clock (tenant_id, owner_unit_id, due_on, id);
CREATE INDEX contract_settlement_clock_settlement_idx ON machvon.contract_settlement_clock (tenant_id, settlement_id);
CREATE INDEX contract_settlement_clock_open_idx ON machvon.contract_settlement_clock (tenant_id, due_on, id) WHERE state = 'OPEN';

CREATE FUNCTION machvon.guard_contract_settlement_clock() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a settlement clock is kept' USING ERRCODE = '23514', CONSTRAINT = 'contract_settlement_clock_guard';
  END IF;
  IF NEW.contract_id <> OLD.contract_id OR NEW.project_id <> OLD.project_id OR NEW.owner_unit_id <> OLD.owner_unit_id OR NEW.project_group IS DISTINCT FROM OLD.project_group
     OR NEW.started_on <> OLD.started_on OR NEW.months_allowed <> OLD.months_allowed OR NEW.due_on <> OLD.due_on OR NEW.near_days <> OLD.near_days OR NEW.policy_version <> OLD.policy_version
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what a settlement clock is does not change' USING ERRCODE = '23514', CONSTRAINT = 'contract_settlement_clock_identity_guard';
  END IF;
  IF OLD.state <> 'OPEN' AND (NEW.state <> OLD.state OR NEW.met_on IS DISTINCT FROM OLD.met_on OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id) THEN
    RAISE EXCEPTION 'an ended settlement clock is not changed' USING ERRCODE = '23514', CONSTRAINT = 'contract_settlement_clock_ended_guard';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_settlement_clock_guard BEFORE UPDATE OR DELETE ON machvon.contract_settlement_clock FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_settlement_clock();

ALTER TABLE machvon.contract_settlement_clock ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_settlement_clock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_settlement_clock AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_settlement_clock AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_settlement_clock FROM machvon_app;

COMMENT ON TABLE machvon.contract_settlement_clock IS 'GOV-11a G1-18: one row for each completed contract: the day the clock of the settlement file started, the months and due day the rule gave, how it ended; NEAR and OVERDUE are judged when read.';

-- Authored by hand (not generated): the indexes the separation-of-duties guard (G4-1) reads through. The guard asks, at the commit of a command, whether the person already holds the other duty of a pair on the same record, project, contract or package;
-- the answer is found by the contract or the project of the subject, so these are the keys it filters by. The list of what met a conflict (AUD, ADM) is read by pair and by the day.

CREATE INDEX IF NOT EXISTS sod_exception_use_pair_idx ON machvon.sod_exception_use (tenant_id, action_a, action_b, used_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sod_exception_use_blocked_idx ON machvon.sod_exception_use (tenant_id, used_at DESC, id DESC) WHERE outcome = 'BLOCKED';
CREATE INDEX IF NOT EXISTS sod_exception_subject_idx ON machvon.sod_exception (tenant_id, member_id, scope, subject_id) WHERE status IN ('REQUESTED', 'APPROVED');
CREATE INDEX IF NOT EXISTS payment_request_sod_contract_idx ON machvon.payment_request (tenant_id, contract_id);
CREATE INDEX IF NOT EXISTS measurement_sod_contract_idx ON machvon.measurement (tenant_id, contract_id);
CREATE INDEX IF NOT EXISTS acceptance_sod_contract_idx ON machvon.acceptance (tenant_id, contract_id);
CREATE INDEX IF NOT EXISTS contract_sod_package_idx ON machvon.contract (tenant_id, package_id);
CREATE INDEX IF NOT EXISTS contract_sod_project_idx ON machvon.contract (tenant_id, project_id);

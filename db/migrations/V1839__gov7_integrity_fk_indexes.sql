-- Authored by hand (not generated): indexes under the foreign keys of the payment integrity tables, so that the reads by person and by run, and the checks of the foreign keys themselves, do not scan (G4-2, G4-5, lane D).

CREATE INDEX payment_integrity_run_created_by_idx ON machvon.payment_integrity_run (tenant_id, created_by);
CREATE INDEX payment_integrity_finding_exception_idx ON machvon.payment_integrity_finding (tenant_id, exception_id) WHERE exception_id IS NOT NULL;
CREATE INDEX disbursement_exception_requested_by_idx ON machvon.disbursement_exception (tenant_id, requested_by);
CREATE INDEX disbursement_exception_decided_by_idx ON machvon.disbursement_exception (tenant_id, decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX disbursement_exception_used_run_idx ON machvon.disbursement_exception (tenant_id, used_run_id) WHERE used_run_id IS NOT NULL;

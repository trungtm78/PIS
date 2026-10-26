-- ST-AUD-004, ST-AUD-005: the two reference columns of the recovery ledger and of the follow-up report that no index served, so that a read by unit or by source does not scan the tenant (the RLS catalog asks for a
-- (tenant_id, column) index on every *_id column of a tenant table).

CREATE INDEX audit_follow_up_report_drafting_unit_id_idx ON machvon.audit_follow_up_report (tenant_id, drafting_unit_id);
CREATE INDEX audit_recovery_exception_source_id_idx ON machvon.audit_recovery_exception (tenant_id, source_id);

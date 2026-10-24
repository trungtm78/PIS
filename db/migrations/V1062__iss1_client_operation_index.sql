-- The unique index of the offline create (issue_client_operation_uq, V1061) leads with the reporter, so the operation id is its third column.
-- The rule of the catalogue is that every *_id column leads an index after tenant_id (a lookup of the operation id across reporters, a report on
-- retried creates); this is that index. It is not unique: the uniqueness of an operation id belongs to its reporter.
CREATE INDEX issue_client_operation_id_idx ON machvon.issue (tenant_id, client_operation_id) WHERE client_operation_id IS NOT NULL;

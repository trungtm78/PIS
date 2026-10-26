-- Authored by hand (not generated): the index of the document that approved the exception of a settlement revision (ST-PAY-009, found by the catalogue of indexes of ST-KERNEL-020).
-- V1569 added the column exception_approval_document_version_id with its foreign key and no index that starts with the tenant; every identifier column has one.

CREATE INDEX settlement_revision_exception_document_idx ON machvon.settlement_revision (tenant_id, exception_approval_document_version_id);

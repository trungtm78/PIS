-- Authored by hand (not generated): an import batch is reviewed and published as one (ST-MDM-006, MDM 3.1 F7).
-- Applying a batch creates its records and their change requests together and submits them; the change requests carry the batch, the
-- batch carries who decided it and who published it and on which decision document. Four-eyes is held by the change requests
-- themselves (master_cr_sod_chk, master_cr_publish_sod_chk): the person who applied the batch decides and publishes none of it.

ALTER TABLE machvon.master_import_batch ADD COLUMN reviewed_by uuid;
ALTER TABLE machvon.master_import_batch ADD COLUMN reviewed_at timestamptz;
ALTER TABLE machvon.master_import_batch ADD COLUMN published_by uuid;
ALTER TABLE machvon.master_import_batch ADD COLUMN published_at timestamptz;
ALTER TABLE machvon.master_import_batch ADD COLUMN decision_document_id uuid;
ALTER TABLE machvon.master_import_batch
  ADD CONSTRAINT master_import_decision_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id);
CREATE INDEX master_import_decision_document_id_idx ON machvon.master_import_batch (tenant_id, decision_document_id);
ALTER TABLE machvon.master_import_batch
  ADD CONSTRAINT master_import_publish_chk CHECK ((status = 'APPLIED') = (published_by IS NOT NULL AND published_at IS NOT NULL AND decision_document_id IS NOT NULL));

CREATE INDEX master_import_created_idx ON machvon.master_import_batch (tenant_id, created_at, id);

ALTER TABLE machvon.master_change_request ADD COLUMN import_batch_id uuid;
ALTER TABLE machvon.master_change_request
  ADD CONSTRAINT master_change_request_import_fk FOREIGN KEY (tenant_id, import_batch_id) REFERENCES machvon.master_import_batch (tenant_id, id);
CREATE INDEX master_change_request_import_batch_id_idx ON machvon.master_change_request (tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL;

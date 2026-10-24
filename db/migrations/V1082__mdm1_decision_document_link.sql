-- Authored by hand (not generated): the decision document of a publication is a real document of the tenant, found by index.
ALTER TABLE machvon.master_change_request
  ADD CONSTRAINT master_change_request_decision_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id);
CREATE INDEX master_change_request_decision_document_id_idx ON machvon.master_change_request (tenant_id, decision_document_id);

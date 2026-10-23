-- Authored by hand (not generated): who published a master data change and on what decision (ST-MDM-001, BR-MDM four-eyes).
-- A change request is proposed by one person, decided by a second one and published by a person who is not its proposer; the
-- decision document that authorises the publication is kept with it (the audit row names it too).

ALTER TABLE machvon.master_change_request ADD COLUMN published_by uuid;
ALTER TABLE machvon.master_change_request ADD COLUMN published_at timestamptz;
ALTER TABLE machvon.master_change_request ADD COLUMN decision_document_id uuid;

ALTER TABLE machvon.master_change_request ADD CONSTRAINT master_cr_publish_sod_chk CHECK (published_by IS NULL OR published_by <> created_by);
ALTER TABLE machvon.master_change_request ADD CONSTRAINT master_cr_publish_chk CHECK ((status = 'APPLIED') = (published_by IS NOT NULL AND published_at IS NOT NULL AND decision_document_id IS NOT NULL));
ALTER TABLE machvon.master_change_request ADD CONSTRAINT master_cr_decision_chk CHECK (status IN ('DRAFT', 'IN_REVIEW', 'CANCELLED') OR (reviewed_by IS NOT NULL AND decided_at IS NOT NULL));

-- One open change request per master record: a second one would be decided against a state that the first one is about to change.
CREATE UNIQUE INDEX master_cr_one_open_uq ON machvon.master_change_request (tenant_id, master_record_id)
  WHERE status IN ('DRAFT', 'IN_REVIEW', 'APPROVED') AND master_record_id IS NOT NULL;

CREATE INDEX master_cr_status_idx ON machvon.master_change_request (tenant_id, status, created_at);

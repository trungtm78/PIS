-- Authored by hand (not generated): the documents of a community monitoring pack (GOV-12, G4-8). Each row links a document of DOC by its id (a document of the register, or a file of the project repository of DOC-2), with the
-- title and hash as they were when it was attached; it is withdrawn, never deleted, so that the pack of the day a notice was sent can be told.

CREATE TABLE machvon.monitoring_pack_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL,
  item text NOT NULL CHECK (item IN ('NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE', 'BOARD_LIST', 'MEETING_MINUTES', 'FEEDBACK_REPORT')),
  document_id uuid NOT NULL,
  document_kind text NOT NULL CHECK (document_kind IN ('DOCUMENT', 'PROJECT_DOCUMENT')),
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 300),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_by uuid,
  withdrawn_at timestamptz,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR (withdrawn_reason = btrim(withdrawn_reason) AND char_length(withdrawn_reason) BETWEEN 5 AND 500)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES machvon.monitoring_file (tenant_id, id),
  FOREIGN KEY (tenant_id, added_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, withdrawn_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT monitoring_pack_item_withdrawn_chk CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL) AND (withdrawn_at IS NULL) = (withdrawn_reason IS NULL))
);
CREATE UNIQUE INDEX monitoring_pack_item_live_uq ON machvon.monitoring_pack_item (tenant_id, file_id, item, document_id) WHERE withdrawn_at IS NULL;
CREATE INDEX monitoring_pack_item_file_idx ON machvon.monitoring_pack_item (tenant_id, file_id, item, added_at);
CREATE INDEX monitoring_pack_item_document_idx ON machvon.monitoring_pack_item (tenant_id, document_id);
CREATE INDEX monitoring_pack_item_added_by_idx ON machvon.monitoring_pack_item (tenant_id, added_by);
CREATE INDEX monitoring_pack_item_withdrawn_by_idx ON machvon.monitoring_pack_item (tenant_id, withdrawn_by) WHERE withdrawn_by IS NOT NULL;

ALTER TABLE machvon.monitoring_pack_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.monitoring_pack_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.monitoring_pack_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.monitoring_pack_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE, UPDATE ON TABLE machvon.monitoring_pack_item FROM machvon_app;
GRANT UPDATE (withdrawn_by, withdrawn_at, withdrawn_reason) ON TABLE machvon.monitoring_pack_item TO machvon_app;

COMMENT ON TABLE machvon.monitoring_pack_item IS 'A document of the community monitoring pack, linked by the id of the document in DOC; withdrawn with a reason, never deleted.';

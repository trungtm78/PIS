-- Authored by hand (not generated): the files a contractor puts on the portal (PORTAL-2; docs/plans/portal2.md).
-- A file goes through the shared upload pipeline (judged by its bytes, kept under the tenant prefix) and is registered as a document of the DOC framework (kind ATTACHMENT, subject module VND_PORTAL, subject the
-- contractor). This table is the contractor's own list of those files: the answer to a request, a certificate or the evidence of an action of remediation may name only an attachment of the contractor that sends it, which
-- the portal path policy (V2643) enforces. `linked_kind` and `linked_id` are set once a record takes the file.

CREATE TABLE machvon.portal_attachment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('REQUEST_RESPONSE', 'CERTIFICATE', 'REMEDIATION_EVIDENCE', 'OTHER')),
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200),
  mime text NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  scan_verdict text NOT NULL CHECK (scan_verdict = 'CLEAN'),
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  linked_kind text CHECK (linked_kind IS NULL OR linked_kind IN ('REQUEST', 'QUALIFICATION', 'REMEDIATION_ACTION')),
  linked_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT portal_attachment_link_chk CHECK ((linked_kind IS NULL) = (linked_id IS NULL))
);
CREATE UNIQUE INDEX portal_attachment_document_uq ON machvon.portal_attachment (tenant_id, document_id);
CREATE INDEX portal_attachment_contractor_idx ON machvon.portal_attachment (tenant_id, contractor_id, uploaded_at DESC);
CREATE INDEX portal_attachment_version_idx ON machvon.portal_attachment (tenant_id, document_version_id);
CREATE INDEX portal_attachment_uploader_idx ON machvon.portal_attachment (tenant_id, uploaded_by);
CREATE INDEX portal_attachment_link_idx ON machvon.portal_attachment (tenant_id, linked_id) WHERE linked_id IS NOT NULL;

ALTER TABLE machvon.portal_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.portal_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.portal_attachment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.portal_attachment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.portal_attachment FROM machvon_app;

COMMENT ON TABLE machvon.portal_attachment IS 'PORTAL-2: a file of a contractor on the portal, scanned clean and registered as a document of the DOC framework.';

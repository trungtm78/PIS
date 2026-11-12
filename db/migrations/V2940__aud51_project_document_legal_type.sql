-- Authored by hand (not generated): the legal-document type of a project document in the enterprise edition (MD.02, lane AUD5). A file of the project repository (DOC-24) has a class of the public product
-- (`doc_class`); the enterprise edition also says WHICH legal document it is, by a code of the catalogue ENT_LEGAL_DOC_TYPE (the resolution of the group, the decision approving the feasibility study, ...).
-- That meaning exists in the enterprise edition only, so it lives in a table of its own and the public table `project_document` is not touched:
--   * one row per document at most; a document with no row has no legal type (public edition, or an enterprise file nobody classified);
--   * the application judges the code against the catalogue in force on the day (a tenant adds a code through an approved rule), so the database only holds the shape of the code, never a list;
--   * the row follows its document (it is removed with it, and a document is never deleted by the product), and who set the type and when is kept.
-- Expand only: a new table nothing reads yet, so a rollback of the code needs no rollback of the schema.

CREATE TABLE machvon.project_document_legal_type (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  legal_doc_type text NOT NULL,
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES machvon.project_document (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT project_document_legal_type_code_chk CHECK (legal_doc_type ~ '^[A-Z][A-Z0-9_]{1,39}$')
);
CREATE INDEX project_document_legal_type_code_idx ON machvon.project_document_legal_type (tenant_id, legal_doc_type, document_id);

ALTER TABLE machvon.project_document_legal_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_document_legal_type FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_document_legal_type AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_document_legal_type AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE machvon.project_document_legal_type IS 'AUD5: the type of legal document (a code of the catalogue ENT_LEGAL_DOC_TYPE) of a project document in the enterprise edition; absent for the public edition.';

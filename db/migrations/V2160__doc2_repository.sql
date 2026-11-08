-- Authored by hand (not generated): the project document repository (DOC-2, PD.01 and PD.02, docs/doc-repository.md).
-- A project keeps its files here: a decision, a design, an estimate, a tender file, a contract, an acceptance or a payment record, a report. Each file is a DOCUMENT with a class, an effective period and links to the
-- project, the contract and the package it belongs to; each change of the file is a VERSION. The bytes stay in the tenant's own object storage (`file_object_key`, under `tenants/<tenant id>/`); this table keeps where,
-- the SHA-256 and the format, never the content.
--   * `project_document`: the description; it can be corrected (versioned), archived with a reason and restored. The contract and the package it names must belong to its project (a trigger judges it whoever writes).
--   * `project_document_version`: what a version is made of never changes (key, hash, size, format); its state moves along DRAFT, IN_REVIEW and one of APPROVED, SUPPLEMENT_REQUESTED, REJECTED (or back to DRAFT when a
--     review is withdrawn). An APPROVED version is LOCKED: the database refuses any later change to it, from any role, and no version is ever deleted.

CREATE TABLE machvon.project_document (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  contract_id uuid,
  package_id uuid,
  doc_class text NOT NULL,
  title text NOT NULL,
  reference text,
  security_class text NOT NULL DEFAULT 'INTERNAL',
  effective_from date,
  effective_to date,
  note text,
  status text NOT NULL DEFAULT 'ACTIVE',
  archive_reason text,
  current_version_id uuid,
  approved_version_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  CONSTRAINT project_document_class_chk CHECK (doc_class ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT project_document_title_chk CHECK (title = btrim(title) AND char_length(title) BETWEEN 3 AND 300),
  CONSTRAINT project_document_reference_chk CHECK (reference IS NULL OR (reference = btrim(reference) AND char_length(reference) BETWEEN 1 AND 120)),
  CONSTRAINT project_document_security_chk CHECK (security_class IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL')),
  CONSTRAINT project_document_period_chk CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT project_document_note_chk CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  CONSTRAINT project_document_status_chk CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT project_document_archive_chk CHECK ((status = 'ARCHIVED') = (archive_reason IS NOT NULL) AND (archive_reason IS NULL OR char_length(archive_reason) BETWEEN 10 AND 2000)),
  CONSTRAINT project_document_version_chk CHECK (version >= 1)
);

CREATE INDEX project_document_project_idx ON machvon.project_document (tenant_id, project_id, doc_class, created_at DESC, id DESC);
CREATE INDEX project_document_contract_idx ON machvon.project_document (tenant_id, contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX project_document_package_idx ON machvon.project_document (tenant_id, package_id) WHERE package_id IS NOT NULL;
CREATE INDEX project_document_current_idx ON machvon.project_document (tenant_id, current_version_id) WHERE current_version_id IS NOT NULL;
CREATE INDEX project_document_approved_idx ON machvon.project_document (tenant_id, approved_version_id) WHERE approved_version_id IS NOT NULL;
CREATE INDEX project_document_creator_idx ON machvon.project_document (tenant_id, created_by);
-- One live document per reference in a class of a project: the same decision is not filed twice.
CREATE UNIQUE INDEX project_document_reference_uq ON machvon.project_document (tenant_id, project_id, doc_class, lower(reference)) WHERE reference IS NOT NULL AND status = 'ACTIVE';

CREATE TABLE machvon.project_document_version (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  version_no integer NOT NULL,
  file_object_key text NOT NULL,
  file_sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL,
  format text NOT NULL,
  mime text NOT NULL,
  scan_status text NOT NULL DEFAULT 'CLEAN',
  page_count integer,
  extraction_status text NOT NULL DEFAULT 'PENDING',
  extraction_engine text,
  extraction_engine_version text,
  extracted_at timestamptz,
  unit_count integer NOT NULL DEFAULT 0,
  truncated_units integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'DRAFT',
  change_note text,
  locked_at timestamptz,
  locked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES machvon.project_document (tenant_id, id),
  CONSTRAINT project_document_version_no_uq UNIQUE (tenant_id, document_id, version_no),
  CONSTRAINT project_document_version_file_uq UNIQUE (tenant_id, document_id, file_sha256),
  CONSTRAINT project_document_version_no_chk CHECK (version_no >= 1),
  CONSTRAINT project_document_version_key_chk CHECK (file_object_key ~ '^tenants/[0-9a-f-]{36}/[a-z][a-z0-9_-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  CONSTRAINT project_document_version_sha_chk CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_document_version_size_chk CHECK (size_bytes BETWEEN 1 AND 26214400),
  CONSTRAINT project_document_version_format_chk CHECK ((format, mime) IN (('PDF', 'application/pdf'), ('DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), ('XLSX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))),
  CONSTRAINT project_document_version_scan_chk CHECK (scan_status = 'CLEAN'),
  CONSTRAINT project_document_version_pages_chk CHECK (page_count IS NULL OR page_count >= 0),
  CONSTRAINT project_document_version_extraction_chk CHECK (extraction_status IN ('PENDING', 'EXTRACTED', 'NO_TEXT', 'FAILED')),
  CONSTRAINT project_document_version_units_chk CHECK (unit_count >= 0 AND truncated_units >= 0 AND (extraction_status = 'EXTRACTED') = (unit_count > 0)),
  CONSTRAINT project_document_version_engine_chk CHECK ((extraction_status = 'PENDING') = (extracted_at IS NULL) AND (extraction_engine IS NULL) = (extraction_engine_version IS NULL)),
  CONSTRAINT project_document_version_status_chk CHECK (status IN ('DRAFT', 'IN_REVIEW', 'SUPPLEMENT_REQUESTED', 'REJECTED', 'APPROVED')),
  CONSTRAINT project_document_version_note_chk CHECK (change_note IS NULL OR char_length(change_note) BETWEEN 1 AND 2000),
  CONSTRAINT project_document_version_lock_chk CHECK ((status = 'APPROVED') = (locked_at IS NOT NULL) AND (locked_at IS NULL) = (locked_by IS NULL))
);

CREATE INDEX project_document_version_document_idx ON machvon.project_document_version (tenant_id, document_id, version_no DESC);
CREATE INDEX project_document_version_status_idx ON machvon.project_document_version (tenant_id, status, created_at DESC);
CREATE INDEX project_document_version_creator_idx ON machvon.project_document_version (tenant_id, created_by);

ALTER TABLE machvon.project_document
  ADD CONSTRAINT project_document_current_fk FOREIGN KEY (tenant_id, current_version_id) REFERENCES machvon.project_document_version (tenant_id, id),
  ADD CONSTRAINT project_document_approved_fk FOREIGN KEY (tenant_id, approved_version_id) REFERENCES machvon.project_document_version (tenant_id, id);

-- The description of a document: the project and the origin never change; the contract and the package it names belong to its project; an archived document is read-only until it is restored; the version that is
-- approved only moves forward, and is a version of this document that really is approved.
CREATE FUNCTION machvon.guard_project_document() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.contract_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.contract_id IS DISTINCT FROM OLD.contract_id) AND NOT EXISTS (
    SELECT 1 FROM machvon.contract c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contract_id AND c.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'DOC_LINK_MISMATCH: the contract does not belong to the project' USING ERRCODE = '23514';
  END IF;
  IF NEW.package_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.package_id IS DISTINCT FROM OLD.package_id) AND NOT EXISTS (
    SELECT 1 FROM machvon.procurement_package p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.package_id AND p.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'DOC_LINK_MISMATCH: the package does not belong to the project' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a document keeps its project and its origin' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'ARCHIVED' AND NEW.status = 'ARCHIVED' AND (NEW.contract_id, NEW.package_id, NEW.doc_class, NEW.title, NEW.reference, NEW.security_class, NEW.effective_from, NEW.effective_to, NEW.note, NEW.current_version_id, NEW.approved_version_id)
       IS DISTINCT FROM (OLD.contract_id, OLD.package_id, OLD.doc_class, OLD.title, OLD.reference, OLD.security_class, OLD.effective_from, OLD.effective_to, OLD.note, OLD.current_version_id, OLD.approved_version_id) THEN
      RAISE EXCEPTION 'DOC_ARCHIVED: an archived document is restored before it is changed' USING ERRCODE = '23514';
    END IF;
    IF NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id THEN
      IF NEW.approved_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM machvon.project_document_version v
         WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.approved_version_id AND v.document_id = NEW.id AND v.status = 'APPROVED'
           AND (OLD.approved_version_id IS NULL OR v.version_no > (SELECT o.version_no FROM machvon.project_document_version o WHERE o.tenant_id = OLD.tenant_id AND o.id = OLD.approved_version_id))
      ) THEN
        RAISE EXCEPTION 'the approved version of a document is an approved version of it, and only moves to a later one' USING ERRCODE = '23514';
      END IF;
      IF NEW.approved_version_id IS NULL THEN
        RAISE EXCEPTION 'an approved version is never withdrawn' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_document_guard BEFORE INSERT OR UPDATE ON machvon.project_document FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_document();

-- The version: what it is made of never changes; its text is read once (the extraction columns are set while it is PENDING, or again while nothing was read); its state follows the chain; an approved version is locked.
CREATE FUNCTION machvon.guard_project_document_version() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'DOC_VERSION_LOCKED: an approved version never changes' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.document_id, NEW.version_no, NEW.file_object_key, NEW.file_sha256, NEW.size_bytes, NEW.format, NEW.mime, NEW.scan_status, NEW.page_count, NEW.change_note, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.document_id, OLD.version_no, OLD.file_object_key, OLD.file_sha256, OLD.size_bytes, OLD.format, OLD.mime, OLD.scan_status, OLD.page_count, OLD.change_note, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a version keeps the file it was made of' USING ERRCODE = '23514';
  END IF;
  IF OLD.extraction_status = 'EXTRACTED' AND (NEW.extraction_status, NEW.unit_count, NEW.truncated_units, NEW.extraction_engine, NEW.extraction_engine_version, NEW.extracted_at)
     IS DISTINCT FROM (OLD.extraction_status, OLD.unit_count, OLD.truncated_units, OLD.extraction_engine, OLD.extraction_engine_version, OLD.extracted_at) THEN
    RAISE EXCEPTION 'the text of a version is read once' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'IN_REVIEW'), ('IN_REVIEW', 'APPROVED'), ('IN_REVIEW', 'SUPPLEMENT_REQUESTED'), ('IN_REVIEW', 'REJECTED'), ('IN_REVIEW', 'DRAFT')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'DOC_VERSION_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_document_version_guard BEFORE UPDATE ON machvon.project_document_version FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_document_version();

ALTER TABLE machvon.project_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_document FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_document AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_document AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.project_document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_document_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_document_version AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_document_version AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_document FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_document_version FROM machvon_app;

COMMENT ON TABLE machvon.project_document IS 'DOC-2: a file of a project (class, effective period, links to project, contract and package); its versions are in project_document_version.';
COMMENT ON TABLE machvon.project_document_version IS 'DOC-2: one version of a project document: the file in the tenant storage (key, hash, size), the state of its review, the reading of its text; an APPROVED version is locked.';

-- Authored by hand (not generated): comments on a version of a project document (DOC-2, PD.02, docs/doc-repository.md section 5).
-- A comment belongs to ONE version and may be anchored to a citation of that version (the foreign key keeps the anchor real); a reply points at a comment of the same version (one level deep). A comment is evidence of what
-- a reviewer said about what they saw: its text and its author never change, nothing is deleted; the only thing that moves is whether it is OPEN or RESOLVED (by whom, when, with which note), and a resolved
-- comment can be reopened. Comments are allowed on any version, a locked one included: a comment does not change the file.

CREATE TABLE machvon.document_comment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  version_id uuid NOT NULL,
  citation_id text,
  parent_comment_id uuid,
  review_id uuid,
  body text NOT NULL,
  author_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES machvon.project_document (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES machvon.project_document_version (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id, citation_id) REFERENCES machvon.document_text_unit (tenant_id, version_id, citation_id),
  FOREIGN KEY (tenant_id, parent_comment_id) REFERENCES machvon.document_comment (tenant_id, id),
  CONSTRAINT document_comment_body_chk CHECK (char_length(body) BETWEEN 2 AND 4000),
  CONSTRAINT document_comment_status_chk CHECK (status IN ('OPEN', 'RESOLVED')),
  CONSTRAINT document_comment_resolution_chk CHECK ((status = 'RESOLVED') = (resolved_by IS NOT NULL) AND (resolved_by IS NULL) = (resolved_at IS NULL) AND (resolution_note IS NULL OR (status = 'RESOLVED' AND char_length(resolution_note) BETWEEN 1 AND 2000)))
);

CREATE INDEX document_comment_version_idx ON machvon.document_comment (tenant_id, version_id, created_at, id);
CREATE INDEX document_comment_document_idx ON machvon.document_comment (tenant_id, document_id, created_at DESC);
CREATE INDEX document_comment_anchor_idx ON machvon.document_comment (tenant_id, version_id, citation_id) WHERE citation_id IS NOT NULL;
CREATE INDEX document_comment_parent_idx ON machvon.document_comment (tenant_id, parent_comment_id) WHERE parent_comment_id IS NOT NULL;
CREATE INDEX document_comment_review_idx ON machvon.document_comment (tenant_id, review_id) WHERE review_id IS NOT NULL;
CREATE INDEX document_comment_author_idx ON machvon.document_comment (tenant_id, author_id, created_at DESC);

CREATE FUNCTION machvon.guard_document_comment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent machvon.document_comment%ROWTYPE;
  owner uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT v.document_id INTO owner FROM machvon.project_document_version v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.version_id;
    IF owner IS DISTINCT FROM NEW.document_id THEN
      RAISE EXCEPTION 'the version is not a version of this document' USING ERRCODE = '23514';
    END IF;
    IF NEW.parent_comment_id IS NOT NULL THEN
      SELECT * INTO parent FROM machvon.document_comment c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.parent_comment_id;
      IF parent.version_id IS DISTINCT FROM NEW.version_id OR parent.parent_comment_id IS NOT NULL THEN
        RAISE EXCEPTION 'a reply answers a comment of the same version, and replies are one level deep' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a comment is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.document_id, NEW.version_id, NEW.citation_id, NEW.parent_comment_id, NEW.review_id, NEW.body, NEW.author_id, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.document_id, OLD.version_id, OLD.citation_id, OLD.parent_comment_id, OLD.review_id, OLD.body, OLD.author_id, OLD.created_at) THEN
    RAISE EXCEPTION 'what a comment said, and who said it, does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_comment_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.document_comment FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_comment();

ALTER TABLE machvon.document_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.document_comment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.document_comment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.document_comment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.document_comment FROM machvon_app;

COMMENT ON TABLE machvon.document_comment IS 'DOC-2: a comment on a version of a project document, optionally anchored to a citation; the text never changes, only OPEN or RESOLVED does.';

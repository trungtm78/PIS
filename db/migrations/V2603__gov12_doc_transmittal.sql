-- Authored by hand (not generated): the transmittal of documents (GOV-12, G4-11, the practice of ISO 19650 document control).
--   * doc_container: a document of the project (linked by the id of DOC: the register or the repository of DOC-2) in a state WIP, SHARED, PUBLISHED or ARCHIVE; every move is a row of doc_container_move, appended.
--   * doc_transmittal: the sheet that sends documents to people for information, review or approval. SENT for good: its items and recipients are fixed; the due day of a recipient is fixed by the rule of the day of sending
--     and moves once, forward, with a reason; the answer of a recipient is set once by that recipient. A correction is a new transmittal that supersedes the old one (the old one is marked, not edited).
--   * doc_transmittal_item: the document, its revision label and its hash as they were when sent. The hash is what the recipient reviewed.

CREATE TABLE machvon.doc_container (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_kind text NOT NULL CHECK (document_kind IN ('DOCUMENT', 'PROJECT_DOCUMENT')),
  revision_label text NOT NULL CHECK (revision_label = btrim(revision_label) AND char_length(revision_label) BETWEEN 1 AND 20),
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 300),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'WIP' CHECK (state IN ('WIP', 'SHARED', 'PUBLISHED', 'ARCHIVE')),
  author_membership_id uuid NOT NULL,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, author_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT doc_container_revision_uq UNIQUE (tenant_id, document_id, revision_label)
);
CREATE INDEX doc_container_project_idx ON machvon.doc_container (tenant_id, project_id, state, created_at DESC, id);
CREATE INDEX doc_container_document_idx ON machvon.doc_container (tenant_id, document_id);
CREATE INDEX doc_container_author_idx ON machvon.doc_container (tenant_id, author_membership_id);
ALTER TABLE machvon.doc_container ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.doc_container FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.doc_container AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.doc_container AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE, UPDATE ON TABLE machvon.doc_container FROM machvon_app;
GRANT UPDATE (state, state_changed_at, version) ON TABLE machvon.doc_container TO machvon_app;

CREATE FUNCTION machvon.doc_container_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.state <> OLD.state AND NOT ((OLD.state, NEW.state) IN (('WIP', 'SHARED'), ('WIP', 'ARCHIVE'), ('SHARED', 'PUBLISHED'), ('SHARED', 'WIP'), ('SHARED', 'ARCHIVE'), ('PUBLISHED', 'ARCHIVE'))) THEN
    RAISE EXCEPTION 'a document container does not go from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER doc_container_guard BEFORE UPDATE ON machvon.doc_container FOR EACH ROW EXECUTE FUNCTION machvon.doc_container_guard();

CREATE TABLE machvon.doc_container_move (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  container_id uuid NOT NULL,
  from_state text CHECK (from_state IS NULL OR from_state IN ('WIP', 'SHARED', 'PUBLISHED', 'ARCHIVE')),
  to_state text NOT NULL CHECK (to_state IN ('WIP', 'SHARED', 'PUBLISHED', 'ARCHIVE')),
  actor_membership_id uuid NOT NULL,
  transmittal_id uuid,
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 1000)),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, container_id) REFERENCES machvon.doc_container (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX doc_container_move_container_idx ON machvon.doc_container_move (tenant_id, container_id, at, id);
CREATE INDEX doc_container_move_actor_idx ON machvon.doc_container_move (tenant_id, actor_membership_id);
CREATE INDEX doc_container_move_transmittal_idx ON machvon.doc_container_move (tenant_id, transmittal_id) WHERE transmittal_id IS NOT NULL;
ALTER TABLE machvon.doc_container_move ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.doc_container_move FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.doc_container_move AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.doc_container_move AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.doc_container_move FROM machvon_app;

CREATE TABLE machvon.doc_transmittal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  number text NOT NULL CHECK (number = btrim(number) AND char_length(number) BETWEEN 3 AND 60),
  purpose text NOT NULL CHECK (purpose IN ('FOR_INFORMATION', 'FOR_REVIEW', 'FOR_APPROVAL')),
  subject text NOT NULL CHECK (subject = btrim(subject) AND char_length(subject) BETWEEN 3 AND 300),
  message text CHECK (message IS NULL OR (message = btrim(message) AND char_length(message) BETWEEN 1 AND 4000)),
  sent_on date NOT NULL,
  sent_by uuid NOT NULL,
  review_days integer CHECK (review_days IS NULL OR review_days BETWEEN 1 AND 180),
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  supersedes_id uuid,
  superseded_by_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, sent_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.doc_transmittal (tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by_id) REFERENCES machvon.doc_transmittal (tenant_id, id),
  CONSTRAINT doc_transmittal_number_uq UNIQUE (tenant_id, number),
  CONSTRAINT doc_transmittal_days_chk CHECK ((purpose = 'FOR_INFORMATION') = (review_days IS NULL))
);
CREATE INDEX doc_transmittal_project_idx ON machvon.doc_transmittal (tenant_id, project_id, sent_on DESC, id);
CREATE INDEX doc_transmittal_sent_by_idx ON machvon.doc_transmittal (tenant_id, sent_by);
CREATE INDEX doc_transmittal_supersedes_idx ON machvon.doc_transmittal (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX doc_transmittal_superseded_uq ON machvon.doc_transmittal (tenant_id, superseded_by_id) WHERE superseded_by_id IS NOT NULL;
ALTER TABLE machvon.doc_transmittal ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.doc_transmittal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.doc_transmittal AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.doc_transmittal AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.doc_transmittal FROM machvon_app;
GRANT UPDATE (superseded_by_id, version) ON TABLE machvon.doc_transmittal TO machvon_app;

CREATE TABLE machvon.doc_transmittal_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  transmittal_id uuid NOT NULL,
  container_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_label text NOT NULL,
  title text NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, transmittal_id) REFERENCES machvon.doc_transmittal (tenant_id, id),
  FOREIGN KEY (tenant_id, container_id) REFERENCES machvon.doc_container (tenant_id, id),
  CONSTRAINT doc_transmittal_item_uq UNIQUE (tenant_id, transmittal_id, container_id)
);
CREATE INDEX doc_transmittal_item_container_idx ON machvon.doc_transmittal_item (tenant_id, container_id);
CREATE INDEX doc_transmittal_item_document_idx ON machvon.doc_transmittal_item (tenant_id, document_id);
ALTER TABLE machvon.doc_transmittal_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.doc_transmittal_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.doc_transmittal_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.doc_transmittal_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.doc_transmittal_item FROM machvon_app;

CREATE TABLE machvon.doc_transmittal_recipient (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  transmittal_id uuid NOT NULL,
  recipient_membership_id uuid NOT NULL,
  required boolean NOT NULL,
  due_on date,
  extended_due_on date,
  extension_reason text CHECK (extension_reason IS NULL OR (extension_reason = btrim(extension_reason) AND char_length(extension_reason) BETWEEN 5 AND 1000)),
  answer text CHECK (answer IS NULL OR answer IN ('APPROVED', 'APPROVED_WITH_COMMENTS', 'REJECTED', 'NO_COMMENT')),
  answer_comment text CHECK (answer_comment IS NULL OR (answer_comment = btrim(answer_comment) AND char_length(answer_comment) BETWEEN 1 AND 4000)),
  answered_on date,
  answered_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, transmittal_id) REFERENCES machvon.doc_transmittal (tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT doc_transmittal_recipient_uq UNIQUE (tenant_id, transmittal_id, recipient_membership_id),
  CONSTRAINT doc_transmittal_recipient_answer_chk CHECK ((answer IS NULL) = (answered_on IS NULL) AND (answer IS NULL) = (answered_at IS NULL)),
  CONSTRAINT doc_transmittal_recipient_extension_chk CHECK ((extended_due_on IS NULL) = (extension_reason IS NULL) AND (extended_due_on IS NULL OR (due_on IS NOT NULL AND extended_due_on > due_on)))
);
CREATE INDEX doc_transmittal_recipient_person_idx ON machvon.doc_transmittal_recipient (tenant_id, recipient_membership_id, answered_on);
CREATE INDEX doc_transmittal_recipient_waiting_idx ON machvon.doc_transmittal_recipient (tenant_id, due_on) WHERE answer IS NULL AND required;
ALTER TABLE machvon.doc_transmittal_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.doc_transmittal_recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.doc_transmittal_recipient AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.doc_transmittal_recipient AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.doc_transmittal_recipient FROM machvon_app;
GRANT UPDATE (extended_due_on, extension_reason, answer, answer_comment, answered_on, answered_at) ON TABLE machvon.doc_transmittal_recipient TO machvon_app;

-- An answer is set once and is never taken back; the due day moves once.
CREATE FUNCTION machvon.doc_transmittal_recipient_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.answer IS NOT NULL AND (NEW.answer IS DISTINCT FROM OLD.answer OR NEW.answer_comment IS DISTINCT FROM OLD.answer_comment OR NEW.answered_on IS DISTINCT FROM OLD.answered_on) THEN
    RAISE EXCEPTION 'an answer to a transmittal is given once' USING ERRCODE = '23514';
  END IF;
  IF OLD.extended_due_on IS NOT NULL AND NEW.extended_due_on IS DISTINCT FROM OLD.extended_due_on THEN
    RAISE EXCEPTION 'a due day is moved once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER doc_transmittal_recipient_guard BEFORE UPDATE ON machvon.doc_transmittal_recipient FOR EACH ROW EXECUTE FUNCTION machvon.doc_transmittal_recipient_guard();

COMMENT ON TABLE machvon.doc_container IS 'A document of the project in the state WIP, SHARED, PUBLISHED or ARCHIVE, linked by the id of DOC.';
COMMENT ON TABLE machvon.doc_transmittal IS 'A sent transmittal of documents: immutable; a correction supersedes it.';

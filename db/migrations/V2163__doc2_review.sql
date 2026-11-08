-- Authored by hand (not generated): the review of a project document (DOC-2, PD.01, docs/doc-repository.md section 4).
-- A review is ONE ROUND of the approval of a version: the version is sent, goes through the stages of the published workflow of the business type `document.review` (the ADM approval engine owns the stages, the
-- parallel reviewers and their decisions: `workflow_instance_id` points at the instance), and ends APPROVED (the version is locked), SUPPLEMENT_REQUESTED (the author sends a newer version as the next round) or REJECTED;
-- a review that is still open can be WITHDRAWN. The next round names the one before it.
--   * `document_review`: one row per round; a document has at most one OPEN review (a partial unique index) and its rounds are numbered 1, 2, 3... without a gap (a unique key); a concluded review keeps its
--     conclusion (the trigger refuses any later change to its version, its round and its submitter, and to its end once it has one).
--   * `document_review_event`: what happened, in order, append-only for every role: sent, resent, withdrawn, approved, supplement requested, rejected, version locked.

CREATE TABLE machvon.document_review (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  version_id uuid NOT NULL,
  round_no integer NOT NULL,
  previous_review_id uuid,
  status text NOT NULL DEFAULT 'IN_REVIEW',
  workflow_instance_id uuid,
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  submit_note text,
  concluded_at timestamptz,
  conclusion_note text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES machvon.project_document (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES machvon.project_document_version (tenant_id, id),
  FOREIGN KEY (tenant_id, previous_review_id) REFERENCES machvon.document_review (tenant_id, id),
  CONSTRAINT document_review_round_uq UNIQUE (tenant_id, document_id, round_no),
  CONSTRAINT document_review_round_chk CHECK (round_no >= 1 AND (round_no = 1) = (previous_review_id IS NULL)),
  CONSTRAINT document_review_status_chk CHECK (status IN ('IN_REVIEW', 'APPROVED', 'SUPPLEMENT_REQUESTED', 'REJECTED', 'WITHDRAWN')),
  CONSTRAINT document_review_note_chk CHECK ((submit_note IS NULL OR char_length(submit_note) BETWEEN 1 AND 2000) AND (conclusion_note IS NULL OR char_length(conclusion_note) BETWEEN 1 AND 2000)),
  CONSTRAINT document_review_conclusion_chk CHECK ((status = 'IN_REVIEW') = (concluded_at IS NULL)),
  CONSTRAINT document_review_version_chk CHECK (version >= 1)
);

CREATE UNIQUE INDEX document_review_open_uq ON machvon.document_review (tenant_id, document_id) WHERE status = 'IN_REVIEW';
CREATE INDEX document_review_version_idx ON machvon.document_review (tenant_id, version_id);
CREATE INDEX document_review_status_idx ON machvon.document_review (tenant_id, status, submitted_at DESC, id DESC);
CREATE INDEX document_review_instance_idx ON machvon.document_review (tenant_id, workflow_instance_id) WHERE workflow_instance_id IS NOT NULL;
CREATE INDEX document_review_previous_idx ON machvon.document_review (tenant_id, previous_review_id) WHERE previous_review_id IS NOT NULL;
CREATE INDEX document_review_submitter_idx ON machvon.document_review (tenant_id, submitted_by, submitted_at DESC);

CREATE FUNCTION machvon.guard_document_review() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  owner uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT v.document_id INTO owner FROM machvon.project_document_version v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.version_id;
    IF owner IS DISTINCT FROM NEW.document_id THEN
      RAISE EXCEPTION 'the version is not a version of this document' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.document_id, NEW.version_id, NEW.round_no, NEW.previous_review_id, NEW.submitted_by, NEW.submitted_at, NEW.submit_note)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.document_id, OLD.version_id, OLD.round_no, OLD.previous_review_id, OLD.submitted_by, OLD.submitted_at, OLD.submit_note) THEN
    RAISE EXCEPTION 'a review keeps what was sent, by whom and when' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'IN_REVIEW' AND (NEW.status, NEW.concluded_at, NEW.conclusion_note, NEW.workflow_instance_id) IS DISTINCT FROM (OLD.status, OLD.concluded_at, OLD.conclusion_note, OLD.workflow_instance_id) THEN
    RAISE EXCEPTION 'DOC_REVIEW_NOT_OPEN: a concluded review keeps its conclusion' USING ERRCODE = '23514';
  END IF;
  IF OLD.workflow_instance_id IS NOT NULL AND NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id THEN
    RAISE EXCEPTION 'a review runs on one workflow instance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_review_guard BEFORE INSERT OR UPDATE ON machvon.document_review FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_review();

CREATE TABLE machvon.document_review_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL,
  actor_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, review_id) REFERENCES machvon.document_review (tenant_id, id),
  CONSTRAINT document_review_event_seq_uq UNIQUE (tenant_id, review_id, seq),
  CONSTRAINT document_review_event_seq_chk CHECK (seq >= 1),
  CONSTRAINT document_review_event_kind_chk CHECK (kind IN ('SUBMITTED', 'RESUBMITTED', 'WITHDRAWN', 'APPROVED', 'SUPPLEMENT_REQUESTED', 'REJECTED', 'VERSION_LOCKED')),
  CONSTRAINT document_review_event_detail_chk CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX document_review_event_actor_idx ON machvon.document_review_event (tenant_id, actor_id, occurred_at DESC) WHERE actor_id IS NOT NULL;

CREATE FUNCTION machvon.document_review_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of a review is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER document_review_event_append_only BEFORE UPDATE OR DELETE ON machvon.document_review_event FOR EACH ROW EXECUTE FUNCTION machvon.document_review_event_append_only();

ALTER TABLE machvon.document_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.document_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.document_review AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.document_review AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.document_review_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.document_review_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.document_review_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.document_review_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.document_review FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.document_review_event FROM machvon_app;

COMMENT ON TABLE machvon.document_review IS 'DOC-2: one round of the review of a version, running on an ADM approval instance of the business type document.review; at most one is open per document.';
COMMENT ON TABLE machvon.document_review_event IS 'DOC-2: the history of a review (sent, resent, withdrawn, approved, supplement requested, rejected, version locked); append-only.';

-- A comment made during a review names it.
ALTER TABLE machvon.document_comment ADD CONSTRAINT document_comment_review_fk FOREIGN KEY (tenant_id, review_id) REFERENCES machvon.document_review (tenant_id, id);

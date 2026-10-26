-- ST-DIS-004: the volumes, the narrative and the files of a weekly report draft (DIS 3 F1 steps 3, 5, 6; BR-DIS-07).
--
-- V002 gave `progress_snapshot` its four amounts, its basis, its money and percent checks and one row per revision, and `report_narrative` its four texts and the issues it speaks about. This
-- migration finishes them for the draft and makes the database say what the command relies on:
--   * the date of a volume is the last day of the period it was reported for (the command always writes it); the basis of the volumes is the basis of the report;
--   * the narrative of a weekly report is optional in every section (the monthly report asks for more, a later story): a section is empty or has words, at most 4000 characters, and a narrative
--     with nothing in it is not kept; it names at most 50 issues, each once;
--   * the files of a report are kept as the upload door of the report answered them (object id, hash, name, type, size): the same file once per report, at most 20, and the file name is a name;
--   * what was handed in is not edited: the volumes, the narrative and the files change only while the report is a live DRAFT, and the report they belong to is fixed for good.

ALTER TABLE machvon.report_narrative ALTER COLUMN results_text DROP NOT NULL;
ALTER TABLE machvon.report_narrative ALTER COLUMN causes_text DROP NOT NULL;
ALTER TABLE machvon.report_narrative ALTER COLUMN solutions_text DROP NOT NULL;
ALTER TABLE machvon.report_narrative
  ADD CONSTRAINT report_narrative_text_chk CHECK (
    (results_text IS NULL OR (results_text = btrim(results_text) AND char_length(results_text) BETWEEN 1 AND 4000))
    AND (causes_text IS NULL OR (causes_text = btrim(causes_text) AND char_length(causes_text) BETWEEN 1 AND 4000))
    AND (solutions_text IS NULL OR (solutions_text = btrim(solutions_text) AND char_length(solutions_text) BETWEEN 1 AND 4000))
    AND (proposals_text IS NULL OR (proposals_text = btrim(proposals_text) AND char_length(proposals_text) BETWEEN 1 AND 4000))
  ),
  ADD CONSTRAINT report_narrative_issues_chk CHECK (linked_issue_ids IS NULL OR cardinality(linked_issue_ids) <= 50),
  ADD CONSTRAINT report_narrative_not_empty_chk CHECK (
    results_text IS NOT NULL OR causes_text IS NOT NULL OR solutions_text IS NOT NULL OR proposals_text IS NOT NULL OR coalesce(cardinality(linked_issue_ids), 0) > 0
  );

CREATE TABLE machvon.report_attachment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  report_revision_id uuid NOT NULL,
  file_object_id uuid NOT NULL,
  file_sha256 char(64) NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text NOT NULL CHECK (file_name = btrim(file_name) AND char_length(file_name) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 3 AND 127),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT report_attachment_report_fk FOREIGN KEY (tenant_id, report_revision_id) REFERENCES machvon.report_revision (tenant_id, id),
  CONSTRAINT report_attachment_file_uq UNIQUE (tenant_id, report_revision_id, file_object_id),
  CONSTRAINT report_attachment_position_uq UNIQUE (tenant_id, report_revision_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX report_attachment_file_idx ON machvon.report_attachment (tenant_id, file_object_id);

ALTER TABLE machvon.report_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_attachment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_attachment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The volumes, the narrative and the files belong to one report and follow its life: they are written and removed only while it is a live draft, and never move to another report.
CREATE FUNCTION machvon.report_child_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
  parent_deleted timestamptz;
  parent_basis text;
  owner_tenant uuid;
  owner_report uuid;
BEGIN
  owner_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  owner_report := CASE WHEN TG_OP = 'DELETE' THEN OLD.report_revision_id ELSE NEW.report_revision_id END;
  SELECT r.status, r.deleted_at, r.measurement_basis INTO parent_status, parent_deleted, parent_basis
    FROM machvon.report_revision r WHERE r.tenant_id = owner_tenant AND r.id = owner_report;
  IF parent_status IS DISTINCT FROM 'DRAFT' OR parent_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'what belongs to a report that was handed in is not edited' USING ERRCODE = '23514', CONSTRAINT = 'report_child_immutable_guard';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.report_revision_id <> OLD.report_revision_id THEN
    RAISE EXCEPTION 'the volumes, the narrative and the files stay with their report' USING ERRCODE = '23514', CONSTRAINT = 'report_child_identity_guard';
  END IF;
  IF TG_TABLE_NAME = 'progress_snapshot' THEN
    IF TG_OP <> 'DELETE' THEN
      IF NEW.measurement_basis <> parent_basis THEN
        RAISE EXCEPTION 'the volumes are read on the basis of the report' USING ERRCODE = '23514', CONSTRAINT = 'progress_snapshot_basis_guard';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER progress_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.progress_snapshot FOR EACH ROW EXECUTE FUNCTION machvon.report_child_guard();
CREATE TRIGGER report_narrative_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.report_narrative FOR EACH ROW EXECUTE FUNCTION machvon.report_child_guard();
CREATE TRIGGER report_attachment_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.report_attachment FOR EACH ROW EXECUTE FUNCTION machvon.report_child_guard();

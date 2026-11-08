-- Authored by hand (not generated): the life of a report copy before and after it is issued (RPT-1 part 2, eng-review R17, docs/report-engine.md "Issued copies").
--   * `report_draft`: the working copy of one generation (layout version, period, the files by sha256). It walks DRAFT, CHECKED, APPROVED, ISSUED once, forward, by three different people
--     (preparer, checker, approver); a trigger keeps the steps in order and the three people distinct, and an ISSUED draft never changes again. A new generation is a new draft.
--   * `report_issue`: the issued copy, INSERT-ONLY (triggers refuse UPDATE and DELETE and the application role has no right to them). One row per (tenant, layout, period, revision); revision n+1 names
--     revision n it replaces and carries the reason; the hash of the package, the hashes of the files, the people, the snapshot revision and the marks of the form (R18) are part of the row.
--     "Replaced" is not a column: the newest revision of a series is its head and every earlier one is superseded by derivation, so nothing has to be updated.

CREATE TABLE machvon.report_draft (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  layout_id uuid NOT NULL,
  layout_code text NOT NULL,
  layout_version text NOT NULL,
  period_code text NOT NULL,
  period jsonb NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT',
  base_revision integer NOT NULL,
  reason text,
  xlsx_sha256 char(64) NOT NULL,
  docx_sha256 char(64),
  package_sha256 char(64) NOT NULL,
  data_source text NOT NULL,
  snapshot_ref jsonb,
  marks jsonb NOT NULL,
  grid_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  preview jsonb NOT NULL,
  prepared_by uuid NOT NULL,
  checked_by uuid,
  checked_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  issue_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, layout_id) REFERENCES machvon.report_layout (tenant_id, id),
  FOREIGN KEY (tenant_id, xlsx_sha256) REFERENCES machvon.report_output_file (tenant_id, sha256),
  FOREIGN KEY (tenant_id, docx_sha256) REFERENCES machvon.report_output_file (tenant_id, sha256),
  CONSTRAINT report_draft_state_chk CHECK (state IN ('DRAFT', 'CHECKED', 'APPROVED', 'ISSUED')),
  CONSTRAINT report_draft_period_chk CHECK (period_code = btrim(period_code) AND period_code <> '' AND char_length(period_code) <= 20 AND jsonb_typeof(period) = 'object'),
  CONSTRAINT report_draft_base_chk CHECK (base_revision >= 0),
  CONSTRAINT report_draft_reason_chk CHECK ((base_revision = 0) = (reason IS NULL) AND (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000))),
  CONSTRAINT report_draft_hash_chk CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_draft_source_chk CHECK (data_source IN ('LIVE', 'ILLUSTRATIVE')),
  CONSTRAINT report_draft_marks_chk CHECK (jsonb_typeof(marks) = 'object' AND jsonb_typeof(grid_issues) = 'array' AND jsonb_typeof(preview) = 'object'),
  CONSTRAINT report_draft_checker_chk CHECK ((state = 'DRAFT') = (checked_by IS NULL) AND (checked_by IS NULL) = (checked_at IS NULL) AND (checked_by IS NULL OR checked_by <> prepared_by)),
  CONSTRAINT report_draft_approver_chk CHECK ((state IN ('DRAFT', 'CHECKED')) = (approved_by IS NULL) AND (approved_by IS NULL) = (approved_at IS NULL) AND (approved_by IS NULL OR (approved_by <> prepared_by AND approved_by <> checked_by))),
  CONSTRAINT report_draft_issue_chk CHECK ((state = 'ISSUED') = (issue_id IS NOT NULL)),
  CONSTRAINT report_draft_version_chk CHECK (version >= 1)
);
CREATE INDEX report_draft_layout_idx ON machvon.report_draft (tenant_id, layout_id, created_at DESC);
CREATE INDEX report_draft_series_idx ON machvon.report_draft (tenant_id, layout_code, period_code, created_at DESC);
CREATE INDEX report_draft_issue_idx ON machvon.report_draft (tenant_id, issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX report_draft_state_idx ON machvon.report_draft (tenant_id, state, created_at DESC);

CREATE TABLE machvon.report_issue (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  layout_id uuid NOT NULL,
  layout_code text NOT NULL,
  layout_version text NOT NULL,
  period_code text NOT NULL,
  period jsonb NOT NULL,
  revision integer NOT NULL,
  supersedes_id uuid,
  reason text,
  draft_id uuid NOT NULL,
  sha256 char(64) NOT NULL,
  xlsx_sha256 char(64) NOT NULL,
  docx_sha256 char(64),
  xlsx_name text NOT NULL,
  docx_name text,
  data_source text NOT NULL,
  snapshot_ref jsonb,
  form_status text NOT NULL,
  demo_mark text,
  counts_as_accepted boolean NOT NULL,
  grid_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  prepared_by uuid NOT NULL,
  checked_by uuid NOT NULL,
  approved_by uuid NOT NULL,
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, layout_id) REFERENCES machvon.report_layout (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.report_issue (tenant_id, id),
  FOREIGN KEY (tenant_id, xlsx_sha256) REFERENCES machvon.report_output_file (tenant_id, sha256),
  FOREIGN KEY (tenant_id, docx_sha256) REFERENCES machvon.report_output_file (tenant_id, sha256),
  CONSTRAINT report_issue_revision_chk CHECK (revision >= 1 AND (revision = 1) = (supersedes_id IS NULL) AND (revision = 1) = (reason IS NULL)),
  CONSTRAINT report_issue_reason_chk CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000)),
  CONSTRAINT report_issue_hash_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_issue_source_chk CHECK (data_source IN ('LIVE', 'ILLUSTRATIVE')),
  CONSTRAINT report_issue_status_chk CHECK (form_status IN ('PENDING_EXTERNAL', 'DEMO', 'DRAFT', 'READY')),
  CONSTRAINT report_issue_demo_chk CHECK ((form_status = 'DEMO') = (demo_mark IS NOT NULL) AND counts_as_accepted = (form_status <> 'DEMO')),
  CONSTRAINT report_issue_people_chk CHECK (prepared_by <> checked_by AND checked_by <> approved_by AND prepared_by <> approved_by AND issued_by = approved_by),
  CONSTRAINT report_issue_names_chk CHECK ((docx_sha256 IS NULL) = (docx_name IS NULL)),
  CONSTRAINT report_issue_grid_chk CHECK (jsonb_typeof(grid_issues) = 'array' AND jsonb_typeof(period) = 'object'),
  CONSTRAINT report_issue_series_revision_uq UNIQUE (tenant_id, layout_code, period_code, revision),
  CONSTRAINT report_issue_draft_uq UNIQUE (tenant_id, draft_id)
);
CREATE INDEX report_issue_layout_idx ON machvon.report_issue (tenant_id, layout_id, issued_at DESC);
CREATE INDEX report_issue_supersedes_idx ON machvon.report_issue (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX report_issue_recent_idx ON machvon.report_issue (tenant_id, issued_at DESC, id DESC);
CREATE INDEX report_issue_hash_idx ON machvon.report_issue (tenant_id, sha256);

ALTER TABLE machvon.report_draft ADD CONSTRAINT report_draft_issue_fk FOREIGN KEY (tenant_id, issue_id) REFERENCES machvon.report_issue (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE machvon.report_issue ADD CONSTRAINT report_issue_draft_fk FOREIGN KEY (tenant_id, draft_id) REFERENCES machvon.report_draft (tenant_id, id);

CREATE FUNCTION machvon.report_issue_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'an issued report copy never changes: a correction is a new revision that replaces it' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER report_issue_immutable BEFORE UPDATE OR DELETE ON machvon.report_issue FOR EACH ROW EXECUTE FUNCTION machvon.report_issue_immutable();

-- The chain of a series is unbroken at the database too: revision n+1 replaces exactly revision n of the same layout and period, and the files are the ones of the draft that was approved.
CREATE FUNCTION machvon.report_issue_lineage() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  previous machvon.report_issue%ROWTYPE;
  source machvon.report_draft%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previous FROM machvon.report_issue WHERE tenant_id = NEW.tenant_id AND id = NEW.supersedes_id;
    IF NOT FOUND OR previous.layout_code <> NEW.layout_code OR previous.period_code <> NEW.period_code OR previous.revision <> NEW.revision - 1 THEN
      RAISE EXCEPTION 'a revision replaces the one before it in the same series' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO source FROM machvon.report_draft WHERE tenant_id = NEW.tenant_id AND id = NEW.draft_id;
  IF NOT FOUND OR source.state <> 'APPROVED' OR source.package_sha256 <> NEW.sha256 OR source.xlsx_sha256 <> NEW.xlsx_sha256
     OR source.docx_sha256 IS DISTINCT FROM NEW.docx_sha256 OR source.prepared_by <> NEW.prepared_by OR source.checked_by <> NEW.checked_by OR source.approved_by <> NEW.approved_by THEN
    RAISE EXCEPTION 'a copy is issued only from the approved draft, with its files and its three people' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER report_issue_lineage BEFORE INSERT ON machvon.report_issue FOR EACH ROW EXECUTE FUNCTION machvon.report_issue_lineage();

-- A draft moves forward one step at a time and keeps what it was made from; an issued draft is frozen.
CREATE FUNCTION machvon.report_draft_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.state = 'ISSUED' THEN
    RAISE EXCEPTION 'an issued draft never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.layout_id <> OLD.layout_id OR NEW.layout_code <> OLD.layout_code OR NEW.layout_version <> OLD.layout_version OR NEW.period_code <> OLD.period_code OR NEW.period <> OLD.period
     OR NEW.xlsx_sha256 <> OLD.xlsx_sha256 OR NEW.docx_sha256 IS DISTINCT FROM OLD.docx_sha256 OR NEW.package_sha256 <> OLD.package_sha256 OR NEW.prepared_by <> OLD.prepared_by
     OR NEW.base_revision <> OLD.base_revision OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.marks <> OLD.marks OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a draft keeps what it was made from' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state = 'DRAFT' AND NEW.state = 'CHECKED') OR (OLD.state = 'CHECKED' AND NEW.state = 'APPROVED') OR (OLD.state = 'APPROVED' AND NEW.state = 'ISSUED')) OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a draft is checked, then approved, then issued, one step at a time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER report_draft_guard BEFORE UPDATE ON machvon.report_draft FOR EACH ROW EXECUTE FUNCTION machvon.report_draft_guard();

ALTER TABLE machvon.report_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_draft FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_draft AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_draft AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.report_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_issue AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_issue AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.report_draft FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_issue FROM machvon_app;

COMMENT ON TABLE machvon.report_draft IS 'RPT-1: the working copy of a report generation; walks DRAFT, CHECKED, APPROVED, ISSUED forward by three different people.';
COMMENT ON TABLE machvon.report_issue IS 'RPT-1: the issued copy of a report; insert-only, one row per (layout, period, revision), the head of a series is its newest revision (R17).';

-- ST-DIS-003: the weekly report draft and its six cells of cumulative disbursement (DIS 3 F1, BR-DIS-01, BR-DIS-07).
--
-- V002 gave `report_revision` and `funding_snapshot_line` their governance columns, the status, type and source checks, the subset and money checks, the unit cell per revision and the one current
-- revision of a project in a period. This migration adds what the draft needs and makes the database say what the command relies on:
--   * the basis the cumulative cells are read on (BR-DIS-12) and the explanation of a fall (BR-DIS-03) belong to the revision;
--   * a project has one live draft in a period; the second is refused by the table, not only by the command (409 DRAFT_EXISTS);
--   * what was submitted is never edited: the cells of a revision change only while it is a live DRAFT, and neither a cell nor a revision is deleted (409 REVISION_IMMUTABLE);
--   * the identity of a revision (project, period, plan version, number, type, who made it) is fixed for good.

ALTER TABLE machvon.report_revision ADD COLUMN measurement_basis text NOT NULL DEFAULT 'YTD';
ALTER TABLE machvon.report_revision ADD COLUMN negative_delta_explanation text;
ALTER TABLE machvon.report_revision ADD CONSTRAINT report_revision_basis_chk CHECK (measurement_basis IN ('PERIOD', 'YTD', 'PROJECT_TO_DATE'));
ALTER TABLE machvon.report_revision ADD CONSTRAINT report_revision_explanation_chk CHECK (negative_delta_explanation IS NULL OR length(trim(negative_delta_explanation)) BETWEEN 10 AND 2000);
ALTER TABLE machvon.report_revision ADD CONSTRAINT report_revision_delete_pair_chk CHECK ((deleted_at IS NULL) = (deleted_reason IS NULL));

-- One live draft of a project in a period (a draft that was deleted does not count; DIS-007 owns the deletion).
CREATE UNIQUE INDEX report_revision_draft_uq ON machvon.report_revision (tenant_id, project_id, period_id) WHERE status = 'DRAFT' AND deleted_at IS NULL;

-- The reads: the list by period and by project, newest first.
CREATE INDEX report_revision_period_idx ON machvon.report_revision (tenant_id, period_id, created_at DESC, id DESC);
CREATE INDEX report_revision_project_idx ON machvon.report_revision (tenant_id, project_id, created_at DESC, id DESC);

CREATE FUNCTION machvon.report_revision_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a report revision is kept: a draft is deleted softly, a submitted one is never deleted' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_guard';
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.period_id <> OLD.period_id OR NEW.plan_version_id <> OLD.plan_version_id OR NEW.revision <> OLD.revision
     OR NEW.report_type <> OLD.report_type OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'a report revision keeps its project, period, plan version, number and type for good' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_identity_guard';
  END IF;
  -- What was handed in is not edited: only the transitions of the review (status, who decided, the current mark) move a revision that is no longer a draft.
  IF OLD.status <> 'DRAFT' AND (NEW.measurement_basis <> OLD.measurement_basis OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.negative_delta_explanation IS DISTINCT FROM OLD.negative_delta_explanation OR NEW.source_kind <> OLD.source_kind) THEN
    RAISE EXCEPTION 'a submitted report revision is not edited' USING ERRCODE = '23514', CONSTRAINT = 'report_revision_immutable_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER report_revision_guard
  BEFORE UPDATE OR DELETE ON machvon.report_revision
  FOR EACH ROW EXECUTE FUNCTION machvon.report_revision_guard();

CREATE FUNCTION machvon.funding_snapshot_line_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
  parent_deleted timestamptz;
  parent_id uuid;
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.report_revision_id ELSE NEW.report_revision_id END;
  SELECT r.status, r.deleted_at INTO parent_status, parent_deleted
    FROM machvon.report_revision r
   WHERE r.tenant_id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END) AND r.id = parent_id;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the cells of a report are kept with it' USING ERRCODE = '23514', CONSTRAINT = 'funding_snapshot_line_guard';
  END IF;
  IF parent_status IS DISTINCT FROM 'DRAFT' OR parent_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'the cells of a report that was handed in are not edited' USING ERRCODE = '23514', CONSTRAINT = 'funding_snapshot_line_immutable_guard';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.report_revision_id <> OLD.report_revision_id OR NEW.bucket <> OLD.bucket OR NEW.budget_level <> OLD.budget_level OR NEW.allocated_vnd IS DISTINCT FROM OLD.allocated_vnd) THEN
    RAISE EXCEPTION 'a cell keeps its place in the report and the amount allocated to it' USING ERRCODE = '23514', CONSTRAINT = 'funding_snapshot_line_identity_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER funding_snapshot_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON machvon.funding_snapshot_line
  FOR EACH ROW EXECUTE FUNCTION machvon.funding_snapshot_line_guard();

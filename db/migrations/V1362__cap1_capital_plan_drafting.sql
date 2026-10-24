-- Authored by hand (not generated): drafting of the capital plan (ST-CAP-002, CAP 3.1 F2, BR-CAP-02, BR-CAP-03, BR-CAP-04).
-- V002 gave `capital_plan`, `plan_version` and `allocation_line` their columns, the unique revision of a plan code, the single PUBLISHED revision,
-- the line key (plan version, appropriation, bucket, source year) and the subset CHECK. A plan is drafted before it has a decision, so this
-- migration lets the version of a project be a draft without a decision document and a date, backfills what the legacy shape left empty, and
-- puts into the database what the drafting command relies on:
--   * the text and years of a plan are well formed and the decision document is a document of the tenant;
--   * a plan keeps its identity for good (code, kind, years, unit, revision), moves along the state machine of CAP 3.1 section 4 only, and a
--     REJECTED or SUPERSEDED plan never changes;
--   * a line is edited or removed only while its plan is a DRAFT (the one exception is the move of a line to the revision of its
--     appropriation, which ST-CAP-001 does when a revision of the appropriation is published);
--   * a line that draws on an appropriation is complete (project, budget level, origin);
--   * plans are kept for good: the runtime role cannot delete or truncate them, nor truncate their versions and lines.
-- The columns of the legacy shape stay nullable (`plan_version.capital_plan_id`, `created_by`, `updated_by`, `allocation_line.appropriation_id`,
-- `budget_level`, `origin`): rows written before the register of appropriations cannot be given an appropriation that did not exist, and the
-- fixtures of other modules still write that shape. The drafting command always writes the complete row; TODOS.md (ST-CAP-002) lists the
-- SET NOT NULL that follows once the legacy rows are gone.

-- A draft has no decision and no effective date yet.
ALTER TABLE machvon.plan_version ALTER COLUMN decision_id DROP NOT NULL;
ALTER TABLE machvon.plan_version ALTER COLUMN effective_at DROP NOT NULL;

-- Backfill: every legacy version of a project (no capital plan) joins the capital plan of its (fiscal year, decision, revision), and a legacy
-- line takes the project of its version. The plan is ANNUAL, belongs to the root unit of the tenant, and is only as advanced as the decision
-- allows: a decision that is no document of the tenant cannot make a plan PUBLISHED or SUPERSEDED, so such a plan is APPROVED; versions of
-- one plan that disagree on their status make a DRAFT. A year that holds several published revisions of one decision keeps the newest
-- PUBLISHED and supersedes the older ones, because a plan code has one published revision. The rows of the old shape name the system as their
-- author. The appropriation, the budget level and the origin of a legacy line stay empty: they come from the decision documents of D04, which
-- this migration must not invent. The migration runs as the owner role, to which row-level security applies, so it works one tenant at a time
-- (the setting is local to this transaction and is cleared at the end); a tenant without an organisation unit has no unit to give a plan to,
-- and its versions are left as they were. The id of a plan is derived from its key, so the two statements agree on it without a work table.
DO $backfill$
DECLARE
  one_tenant uuid;
BEGIN
  FOR one_tenant IN SELECT id FROM machvon.tenant ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', one_tenant::text, true);

    INSERT INTO machvon.capital_plan
      (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
    SELECT g.tenant_id,
           md5(g.tenant_id::text || '|' || g.fiscal_year::text || '|' || g.decision_id::text || '|' || g.revision::text)::uuid,
           'LEGACY-' || g.fiscal_year::text || '-' || g.decision_id::text,
           'ANNUAL', g.fiscal_year, g.fiscal_year, g.fiscal_year,
           (SELECT u.id FROM machvon.organization_unit u WHERE u.tenant_id = g.tenant_id ORDER BY char_length(u.path), u.path LIMIT 1),
           g.revision,
           CASE
             WHEN g.statuses = 1 AND g.status IN ('PUBLISHED', 'SUPERSEDED') AND g.has_document AND g.effective_at IS NOT NULL
               THEN CASE WHEN g.status = 'PUBLISHED' AND g.revision < max(g.revision) FILTER (WHERE g.status = 'PUBLISHED') OVER (PARTITION BY g.fiscal_year, g.decision_id) THEN 'SUPERSEDED' ELSE g.status END
             WHEN g.statuses = 1 AND g.status IN ('PUBLISHED', 'SUPERSEDED') THEN 'APPROVED'
             WHEN g.statuses = 1 THEN g.status
             ELSE 'DRAFT'
           END,
           CASE WHEN g.has_document THEN g.decision_id END,
           g.effective_at,
           coalesce(g.created_by, '00000000-0000-4000-8000-000000000000'::uuid),
           coalesce(g.created_by, '00000000-0000-4000-8000-000000000000'::uuid)
      FROM (
        SELECT pv.tenant_id,
               pv.fiscal_year,
               pv.decision_id,
               pv.revision,
               count(DISTINCT pv.status) AS statuses,
               min(pv.status) AS status,
               min(pv.effective_at) AS effective_at,
               (array_agg(pv.created_by) FILTER (WHERE pv.created_by IS NOT NULL))[1] AS created_by,
               EXISTS (SELECT 1 FROM machvon.document d WHERE d.tenant_id = pv.tenant_id AND d.id = pv.decision_id) AS has_document
          FROM machvon.plan_version pv
         WHERE pv.tenant_id = one_tenant AND pv.capital_plan_id IS NULL AND pv.decision_id IS NOT NULL
         GROUP BY pv.tenant_id, pv.fiscal_year, pv.decision_id, pv.revision
      ) g
     WHERE EXISTS (SELECT 1 FROM machvon.organization_unit u WHERE u.tenant_id = g.tenant_id);

    UPDATE machvon.plan_version pv
       SET capital_plan_id = md5(pv.tenant_id::text || '|' || pv.fiscal_year::text || '|' || pv.decision_id::text || '|' || pv.revision::text)::uuid,
           created_by = coalesce(pv.created_by, '00000000-0000-4000-8000-000000000000'::uuid),
           updated_by = coalesce(pv.updated_by, '00000000-0000-4000-8000-000000000000'::uuid)
     WHERE pv.tenant_id = one_tenant AND pv.capital_plan_id IS NULL AND pv.decision_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM machvon.capital_plan cp
          WHERE cp.tenant_id = pv.tenant_id AND cp.id = md5(pv.tenant_id::text || '|' || pv.fiscal_year::text || '|' || pv.decision_id::text || '|' || pv.revision::text)::uuid
       );

    UPDATE machvon.allocation_line al
       SET project_id = coalesce(al.project_id, pv.project_id),
           created_by = coalesce(al.created_by, '00000000-0000-4000-8000-000000000000'::uuid),
           updated_by = coalesce(al.updated_by, '00000000-0000-4000-8000-000000000000'::uuid)
      FROM machvon.plan_version pv
     WHERE al.tenant_id = one_tenant AND pv.tenant_id = al.tenant_id AND pv.id = al.plan_version_id
       AND (al.project_id IS NULL OR al.created_by IS NULL OR al.updated_by IS NULL);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;


-- The plan header.
ALTER TABLE machvon.capital_plan
  ADD CONSTRAINT capital_plan_code_text_chk CHECK (plan_code = btrim(plan_code) AND char_length(plan_code) BETWEEN 1 AND 50),
  ADD CONSTRAINT capital_plan_year_range_chk CHECK (
    period_from_year BETWEEN 1990 AND 2100 AND period_to_year BETWEEN 1990 AND 2100 AND (plan_year IS NULL OR plan_year BETWEEN 1990 AND 2100)
  ),
  ADD CONSTRAINT capital_plan_decision_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id);

-- The version of a project: a published or superseded one rests on a decision and has an effective date.
ALTER TABLE machvon.plan_version
  ADD CONSTRAINT plan_version_publish_chk CHECK (status NOT IN ('PUBLISHED', 'SUPERSEDED') OR (decision_id IS NOT NULL AND effective_at IS NOT NULL));

-- The line: a line that draws on an appropriation is complete, its origin is one of the five, and the document that allows an extension is a
-- document of the tenant.
ALTER TABLE machvon.allocation_line
  ADD CONSTRAINT allocation_line_origin_chk CHECK (origin IS NULL OR origin IN ('PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE')),
  ADD CONSTRAINT allocation_line_year_chk CHECK (source_year BETWEEN 1990 AND 2100),
  ADD CONSTRAINT allocation_line_complete_chk CHECK (
    appropriation_id IS NULL OR (project_id IS NOT NULL AND budget_level IS NOT NULL AND origin IS NOT NULL AND created_by IS NOT NULL AND updated_by IS NOT NULL)
  ),
  ADD CONSTRAINT allocation_line_extension_document_fk FOREIGN KEY (tenant_id, extension_document_id) REFERENCES machvon.document (tenant_id, id);

-- A plan keeps its identity, moves along the state machine and is final once rejected or superseded.
CREATE FUNCTION machvon.guard_capital_plan_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.plan_code IS DISTINCT FROM OLD.plan_code
     OR NEW.plan_kind IS DISTINCT FROM OLD.plan_kind
     OR NEW.plan_year IS DISTINCT FROM OLD.plan_year
     OR NEW.period_from_year IS DISTINCT FROM OLD.period_from_year
     OR NEW.period_to_year IS DISTINCT FROM OLD.period_to_year
     OR NEW.scope_unit_id IS DISTINCT FROM OLD.scope_unit_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a capital plan keeps its code, kind, years, unit and revision for good' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REJECTED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'a rejected or superseded capital plan never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN (('DRAFT', 'IN_REVIEW'), ('IN_REVIEW', 'DRAFT'), ('IN_REVIEW', 'APPROVED'), ('IN_REVIEW', 'REJECTED'), ('APPROVED', 'PUBLISHED'), ('PUBLISHED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'the state transition of the capital plan is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER capital_plan_guard BEFORE UPDATE ON machvon.capital_plan
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_capital_plan_update();

-- The version of a project belongs to its project and plan for good, and only a draft is removed (when its last line is).
CREATE FUNCTION machvon.guard_plan_version() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only the version of a draft plan is removed' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR (OLD.capital_plan_id IS NOT NULL AND (NEW.capital_plan_id IS DISTINCT FROM OLD.capital_plan_id OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year OR NEW.revision IS DISTINCT FROM OLD.revision)) THEN
    RAISE EXCEPTION 'the version of a project keeps its project, plan, year and revision for good' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER plan_version_guard BEFORE UPDATE OR DELETE ON machvon.plan_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_plan_version();

-- A line is edited or removed only while its plan version is a draft. Moving a line to the revision of its appropriation (the only change
-- of a line outside a draft) leaves everything else as it was.
CREATE FUNCTION machvon.guard_allocation_line() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  plan_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.plan_version_id IS NOT DISTINCT FROM OLD.plan_version_id AND NEW.fund_source_version_id IS NOT DISTINCT FROM OLD.fund_source_version_id
       AND NEW.bucket IS NOT DISTINCT FROM OLD.bucket AND NEW.source_year IS NOT DISTINCT FROM OLD.source_year
       AND NEW.amount_vnd IS NOT DISTINCT FROM OLD.amount_vnd AND NEW.ctmtqg_subset_vnd IS NOT DISTINCT FROM OLD.ctmtqg_subset_vnd
       AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id AND NEW.budget_level IS NOT DISTINCT FROM OLD.budget_level AND NEW.origin IS NOT DISTINCT FROM OLD.origin
       AND NEW.is_extended IS NOT DISTINCT FROM OLD.is_extended AND NEW.extended_to IS NOT DISTINCT FROM OLD.extended_to
       AND NEW.extension_document_id IS NOT DISTINCT FROM OLD.extension_document_id AND NEW.program_master_version_id IS NOT DISTINCT FROM OLD.program_master_version_id
       AND NEW.previous_line_id IS NOT DISTINCT FROM OLD.previous_line_id AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT status INTO plan_status FROM machvon.plan_version WHERE tenant_id = OLD.tenant_id AND id = OLD.plan_version_id;
  IF plan_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'a line of a plan that is not a draft is neither edited nor removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER allocation_line_guard BEFORE UPDATE OR DELETE ON machvon.allocation_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_allocation_line();

-- Plans are kept for good (retention permanent); a draft line is removed by the command and the guard above.
REVOKE DELETE, TRUNCATE ON TABLE machvon.capital_plan FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.plan_version FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.allocation_line FROM machvon_app;

-- Reading the plans of a year and a kind goes by index (the foreign key indexes come from V002).
CREATE INDEX capital_plan_year_kind_idx ON machvon.capital_plan (tenant_id, plan_kind, period_from_year, status);

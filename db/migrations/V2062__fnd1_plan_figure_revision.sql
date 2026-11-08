-- Authored by hand (not generated): FND-1 step 3 (docs/fnd-funding-model.md sections 7.3, 6.5, 8). The stored figures that CAP does not already own, in one append-only table of revisions:
--   * `plan_figure_revision`: the quarter and month phasing of the year plan, the estimates of a period, the actuals (by the basis they come from: the report of the owner, the books, a correction, an opening balance), and for a
--     measure other than DISBURSED the year plan and its adjustments. A row is a revision: an amount never changes, a correction is a new row that supersedes the old one, and a row is never deleted. The status moves
--     DRAFT -> SUBMITTED -> ACCEPTED -> SUPERSEDED only (a submitted row may be returned or withdrawn). The person who accepts is not the person who prepared (CHECK, maker is not checker). `batch_id` holds the rows that were
--     submitted and accepted together (the four quarters of a phasing). Accepting an actual converts the estimate it replaces: the guard lets the link to the estimate be written once, at the acceptance.
--   * `funding_line_tag`: a descriptive label on a plan line (lender, instrument); a tag with an amount is a subset, one without is a label; tags never change a total.
--   * `period_snapshot_figure`: the long format of the figures of a snapshot, written once while it is BUILDING and never touched again (the same guard as the lines).
-- The year plan of DISBURSED stays in CAP (`allocation_line`); the table refuses it.

CREATE TABLE machvon.plan_figure_revision (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  project_id uuid NOT NULL,
  taxonomy_pack text NOT NULL,
  taxonomy_rule_id uuid,
  taxonomy_version integer NOT NULL DEFAULT 1,
  bucket text NOT NULL,
  budget_level text NOT NULL,
  measure text NOT NULL,
  figure_kind text NOT NULL,
  period_grain text NOT NULL,
  plan_year integer NOT NULL,
  period_ordinal smallint NOT NULL,
  reporting_period_id uuid,
  amount_vnd numeric(24, 0) NOT NULL,
  basis text NOT NULL,
  flash boolean NOT NULL DEFAULT false,
  as_of_date date NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  supersedes_id uuid,
  status text NOT NULL DEFAULT 'DRAFT',
  converted_from_id uuid,
  estimate_amount_vnd numeric(24, 0),
  conversion_reason text,
  adjusts_plan_year integer,
  adjusts_ordinal smallint,
  adjusts_period_id uuid,
  source_report_revision_id uuid,
  erp_batch_id uuid,
  decision_document_id uuid,
  explanation text,
  prepared_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, taxonomy_rule_id) REFERENCES machvon.governance_rule (tenant_id, id),
  FOREIGN KEY (tenant_id, reporting_period_id) REFERENCES machvon.reporting_period (tenant_id, id),
  FOREIGN KEY (tenant_id, adjusts_period_id) REFERENCES machvon.reporting_period (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.plan_figure_revision (tenant_id, id),
  FOREIGN KEY (tenant_id, converted_from_id) REFERENCES machvon.plan_figure_revision (tenant_id, id),
  FOREIGN KEY (tenant_id, source_report_revision_id) REFERENCES machvon.report_revision (tenant_id, id),
  FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id),
  CONSTRAINT plan_figure_pack_chk CHECK (taxonomy_pack IN ('PUBLIC', 'ENTERPRISE')),
  CONSTRAINT plan_figure_class_pack_chk CHECK (
    (taxonomy_pack = 'PUBLIC' AND bucket IN ('CURRENT_YEAR', 'CARRYOVER', 'OTHER') AND budget_level IN ('CENTRAL', 'LOCAL'))
    OR (taxonomy_pack = 'ENTERPRISE' AND bucket IN ('EQUITY', 'LOAN', 'OTHER') AND budget_level = 'ALL')),
  CONSTRAINT plan_figure_measure_chk CHECK (measure IN ('DISBURSED', 'EXECUTED')),
  CONSTRAINT plan_figure_kind_chk CHECK (figure_kind IN ('PLAN_YEAR', 'PLAN_ADJUSTED', 'PLAN_QUARTER', 'PLAN_MONTH', 'ESTIMATE', 'ACTUAL')),
  CONSTRAINT plan_figure_basis_chk CHECK (basis IN ('REPORTED', 'ERP', 'TREASURY', 'ADJUSTMENT', 'OPENING_BALANCE', 'PLAN_DECISION', 'OWNER_ESTIMATE')),
  CONSTRAINT plan_figure_status_chk CHECK (status IN ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'SUPERSEDED', 'WITHDRAWN')),
  CONSTRAINT plan_figure_grain_chk CHECK (period_grain IN ('MONTH', 'QUARTER', 'YEAR')),
  CONSTRAINT plan_figure_year_chk CHECK (plan_year BETWEEN 1990 AND 2100),
  CONSTRAINT plan_figure_ordinal_chk CHECK ((period_grain = 'YEAR' AND period_ordinal = 0) OR (period_grain = 'QUARTER' AND period_ordinal BETWEEN 1 AND 4) OR (period_grain = 'MONTH' AND period_ordinal BETWEEN 1 AND 12)),
  -- The year plan of DISBURSED is owned by CAP (allocation_line); the year grain holds plans, estimates of a year and the opening balances only.
  CONSTRAINT plan_figure_cap_owns_chk CHECK (NOT (figure_kind IN ('PLAN_YEAR', 'PLAN_ADJUSTED') AND measure = 'DISBURSED')),
  CONSTRAINT plan_figure_kind_grain_chk CHECK (
    (figure_kind IN ('PLAN_YEAR', 'PLAN_ADJUSTED') AND period_grain = 'YEAR')
    OR (figure_kind = 'PLAN_QUARTER' AND period_grain = 'QUARTER')
    OR (figure_kind = 'PLAN_MONTH' AND period_grain = 'MONTH')
    OR (figure_kind = 'ESTIMATE')
    OR (figure_kind = 'ACTUAL' AND ((period_grain = 'YEAR' AND basis = 'OPENING_BALANCE') OR (period_grain IN ('MONTH', 'QUARTER') AND basis <> 'OPENING_BALANCE')))),
  CONSTRAINT plan_figure_kind_basis_chk CHECK (
    (figure_kind = 'ACTUAL' AND basis IN ('REPORTED', 'ERP', 'TREASURY', 'ADJUSTMENT', 'OPENING_BALANCE'))
    OR (figure_kind = 'ESTIMATE' AND basis = 'OWNER_ESTIMATE')
    OR (figure_kind IN ('PLAN_YEAR', 'PLAN_ADJUSTED', 'PLAN_QUARTER', 'PLAN_MONTH') AND basis = 'PLAN_DECISION')),
  CONSTRAINT plan_figure_adjustment_chk CHECK (
    (basis = 'ADJUSTMENT') = (adjusts_plan_year IS NOT NULL AND adjusts_ordinal IS NOT NULL)
    AND (adjusts_plan_year IS NULL) = (adjusts_ordinal IS NULL)
    AND (basis <> 'ADJUSTMENT' OR (period_grain = 'MONTH' AND explanation IS NOT NULL AND adjusts_ordinal BETWEEN 1 AND 12))
    AND (adjusts_period_id IS NULL OR basis = 'ADJUSTMENT')),
  CONSTRAINT plan_figure_decision_chk CHECK (figure_kind <> 'PLAN_ADJUSTED' OR decision_document_id IS NOT NULL),
  CONSTRAINT plan_figure_amount_chk CHECK (amount_vnd >= 0 OR (figure_kind = 'ACTUAL' AND basis <> 'OPENING_BALANCE' AND explanation IS NOT NULL)),
  CONSTRAINT plan_figure_explanation_chk CHECK (explanation IS NULL OR (explanation = btrim(explanation) AND char_length(explanation) BETWEEN 20 AND 2000)),
  CONSTRAINT plan_figure_revision_chk CHECK (revision >= 1 AND (supersedes_id IS NULL OR revision > 1) AND version >= 1),
  CONSTRAINT plan_figure_conversion_chk CHECK (
    (converted_from_id IS NULL) = (estimate_amount_vnd IS NULL)
    AND (converted_from_id IS NULL OR figure_kind = 'ACTUAL')
    AND (conversion_reason IS NULL OR (converted_from_id IS NOT NULL AND conversion_reason IN ('PERIOD_ACTUAL_IN', 'CORRECTION_IN_OPEN_PERIOD', 'LATE_ADJUSTMENT', 'RESTATEMENT')))),
  CONSTRAINT plan_figure_flash_chk CHECK (NOT flash OR basis = 'ERP'),
  CONSTRAINT plan_figure_erp_chk CHECK (erp_batch_id IS NULL OR basis = 'ERP'),
  -- Maker is not checker: whoever accepts a figure did not prepare it, and a figure that was accepted names who accepted it and when.
  CONSTRAINT plan_figure_sod_chk CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT plan_figure_approval_chk CHECK ((status IN ('ACCEPTED', 'SUPERSEDED')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

-- One current figure for each key: the accepted one. `adjusts_*` is in the key so that one booking period can carry the corrections of several earlier periods.
CREATE UNIQUE INDEX plan_figure_current_uq ON machvon.plan_figure_revision
  (tenant_id, project_id, taxonomy_pack, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, basis, adjusts_plan_year, adjusts_ordinal) NULLS NOT DISTINCT WHERE status = 'ACCEPTED';
CREATE UNIQUE INDEX plan_figure_revision_uq ON machvon.plan_figure_revision
  (tenant_id, project_id, taxonomy_pack, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, basis, adjusts_plan_year, adjusts_ordinal, revision) NULLS NOT DISTINCT;
CREATE INDEX plan_figure_project_idx ON machvon.plan_figure_revision (tenant_id, project_id, plan_year, figure_kind, period_ordinal);
CREATE INDEX plan_figure_batch_idx ON machvon.plan_figure_revision (tenant_id, batch_id);
CREATE INDEX plan_figure_status_idx ON machvon.plan_figure_revision (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX plan_figure_rule_idx ON machvon.plan_figure_revision (tenant_id, taxonomy_rule_id) WHERE taxonomy_rule_id IS NOT NULL;
CREATE INDEX plan_figure_period_idx ON machvon.plan_figure_revision (tenant_id, reporting_period_id) WHERE reporting_period_id IS NOT NULL;
CREATE INDEX plan_figure_adjusts_period_idx ON machvon.plan_figure_revision (tenant_id, adjusts_period_id) WHERE adjusts_period_id IS NOT NULL;
CREATE INDEX plan_figure_supersedes_idx ON machvon.plan_figure_revision (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX plan_figure_converted_idx ON machvon.plan_figure_revision (tenant_id, converted_from_id) WHERE converted_from_id IS NOT NULL;
CREATE INDEX plan_figure_report_idx ON machvon.plan_figure_revision (tenant_id, source_report_revision_id) WHERE source_report_revision_id IS NOT NULL;
CREATE INDEX plan_figure_erp_idx ON machvon.plan_figure_revision (tenant_id, erp_batch_id) WHERE erp_batch_id IS NOT NULL;
CREATE INDEX plan_figure_document_idx ON machvon.plan_figure_revision (tenant_id, decision_document_id) WHERE decision_document_id IS NOT NULL;

CREATE FUNCTION machvon.plan_figure_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a figure is kept for good: a correction is a new revision' USING ERRCODE = '23514', CONSTRAINT = 'plan_figure_delete_guard';
  END IF;
  IF NEW.id <> OLD.id OR NEW.batch_id <> OLD.batch_id OR NEW.project_id <> OLD.project_id OR NEW.taxonomy_pack <> OLD.taxonomy_pack OR NEW.taxonomy_rule_id IS DISTINCT FROM OLD.taxonomy_rule_id
     OR NEW.taxonomy_version <> OLD.taxonomy_version OR NEW.bucket <> OLD.bucket OR NEW.budget_level <> OLD.budget_level OR NEW.measure <> OLD.measure OR NEW.figure_kind <> OLD.figure_kind
     OR NEW.period_grain <> OLD.period_grain OR NEW.plan_year <> OLD.plan_year OR NEW.period_ordinal <> OLD.period_ordinal OR NEW.reporting_period_id IS DISTINCT FROM OLD.reporting_period_id
     OR NEW.amount_vnd <> OLD.amount_vnd OR NEW.basis <> OLD.basis OR NEW.flash <> OLD.flash OR NEW.as_of_date <> OLD.as_of_date OR NEW.revision <> OLD.revision OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.adjusts_plan_year IS DISTINCT FROM OLD.adjusts_plan_year OR NEW.adjusts_ordinal IS DISTINCT FROM OLD.adjusts_ordinal OR NEW.adjusts_period_id IS DISTINCT FROM OLD.adjusts_period_id
     OR NEW.source_report_revision_id IS DISTINCT FROM OLD.source_report_revision_id OR NEW.erp_batch_id IS DISTINCT FROM OLD.erp_batch_id OR NEW.decision_document_id IS DISTINCT FROM OLD.decision_document_id
     OR NEW.explanation IS DISTINCT FROM OLD.explanation OR NEW.prepared_by <> OLD.prepared_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what a figure says does not change: a correction is a new revision' USING ERRCODE = '23514', CONSTRAINT = 'plan_figure_identity_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED', 'WITHDRAWN'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('DRAFT', 'ACCEPTED', 'WITHDRAWN'))
    OR (OLD.status = 'ACCEPTED' AND NEW.status = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'a figure does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'plan_figure_transition_guard';
  END IF;
  IF OLD.status IN ('ACCEPTED', 'SUPERSEDED') AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'who accepted a figure does not change' USING ERRCODE = '23514', CONSTRAINT = 'plan_figure_approval_guard';
  END IF;
  -- The link to the estimate an actual replaces is written once, at the acceptance (the conversion), and never changed.
  IF (NEW.converted_from_id IS DISTINCT FROM OLD.converted_from_id OR NEW.estimate_amount_vnd IS DISTINCT FROM OLD.estimate_amount_vnd OR NEW.conversion_reason IS DISTINCT FROM OLD.conversion_reason)
     AND NOT (OLD.converted_from_id IS NULL AND OLD.status = 'SUBMITTED' AND NEW.status = 'ACCEPTED') THEN
    RAISE EXCEPTION 'the conversion of an estimate is written once, at the acceptance of the actual' USING ERRCODE = '23514', CONSTRAINT = 'plan_figure_conversion_guard';
  END IF;
  -- I3: an estimate is not accepted for a key that has an accepted actual.
  IF NEW.status = 'ACCEPTED' AND OLD.status <> 'ACCEPTED' AND NEW.figure_kind = 'ESTIMATE' AND EXISTS (
       SELECT 1 FROM machvon.plan_figure_revision a
        WHERE a.tenant_id = NEW.tenant_id AND a.project_id = NEW.project_id AND a.taxonomy_pack = NEW.taxonomy_pack AND a.bucket = NEW.bucket AND a.budget_level = NEW.budget_level
          AND a.measure = NEW.measure AND a.figure_kind = 'ACTUAL' AND a.period_grain = NEW.period_grain AND a.plan_year = NEW.plan_year AND a.period_ordinal = NEW.period_ordinal
          AND a.basis <> 'ADJUSTMENT' AND a.status IN ('ACCEPTED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'an estimate is not accepted after the actual' USING ERRCODE = '23514', CONSTRAINT = 'plan_figure_estimate_after_actual_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER plan_figure_guard BEFORE UPDATE OR DELETE ON machvon.plan_figure_revision FOR EACH ROW EXECUTE FUNCTION machvon.plan_figure_guard();

ALTER TABLE machvon.plan_figure_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.plan_figure_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.plan_figure_revision AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.plan_figure_revision AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.plan_figure_revision FROM machvon_app;

-- Tags on a plan line.
CREATE TABLE machvon.funding_line_tag (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  allocation_line_id uuid NOT NULL,
  project_id uuid NOT NULL,
  taxonomy_pack text NOT NULL,
  tag_code text NOT NULL CHECK (tag_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  amount_vnd numeric(24, 0) CHECK (amount_vnd IS NULL OR amount_vnd >= 0),
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 500)),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, allocation_line_id) REFERENCES machvon.allocation_line (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT funding_line_tag_pack_chk CHECK (taxonomy_pack IN ('PUBLIC', 'ENTERPRISE')),
  CONSTRAINT funding_line_tag_uq UNIQUE (tenant_id, allocation_line_id, tag_code)
);
CREATE INDEX funding_line_tag_project_idx ON machvon.funding_line_tag (tenant_id, project_id, tag_code);

ALTER TABLE machvon.funding_line_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.funding_line_tag FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.funding_line_tag AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.funding_line_tag AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE TRUNCATE ON TABLE machvon.funding_line_tag FROM machvon_app;

-- The figures of a snapshot, in the long format: one row for each (project, unit, class, tier, measure, figure kind, grain, ordinal).
CREATE TABLE machvon.period_snapshot_figure (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  project_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  bucket text NOT NULL,
  budget_level text NOT NULL,
  measure text NOT NULL,
  figure_kind text NOT NULL,
  grain text NOT NULL,
  plan_year integer NOT NULL,
  ordinal smallint NOT NULL,
  amount_vnd numeric(24, 0),
  null_reason text,
  basis text,
  source_figure_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  CONSTRAINT snapshot_figure_measure_chk CHECK (measure IN ('DISBURSED', 'EXECUTED')),
  CONSTRAINT snapshot_figure_grain_chk CHECK (grain IN ('MONTH', 'QUARTER', 'YEAR')),
  CONSTRAINT snapshot_figure_null_chk CHECK ((amount_vnd IS NULL) = (null_reason IS NOT NULL) AND (null_reason IS NULL OR null_reason IN ('NO_DATA', 'ZERO_DENOMINATOR', 'ESTIMATE_GAP'))),
  CONSTRAINT snapshot_figure_cell_uq UNIQUE (tenant_id, snapshot_id, project_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal)
);
CREATE INDEX snapshot_figure_project_idx ON machvon.period_snapshot_figure (tenant_id, project_id);
CREATE INDEX snapshot_figure_unit_idx ON machvon.period_snapshot_figure (tenant_id, unit_id);
CREATE INDEX snapshot_figure_source_idx ON machvon.period_snapshot_figure (tenant_id, source_figure_id) WHERE source_figure_id IS NOT NULL;

CREATE FUNCTION machvon.period_snapshot_figure_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
  owner_tenant uuid;
  owner_snapshot uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'the figures of a snapshot are not changed' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_figure_immutable_guard';
  END IF;
  owner_tenant := NEW.tenant_id;
  owner_snapshot := NEW.snapshot_id;
  SELECT s.status INTO parent_status FROM machvon.period_snapshot s WHERE s.tenant_id = owner_tenant AND s.id = owner_snapshot;
  IF parent_status IS DISTINCT FROM 'BUILDING' THEN
    RAISE EXCEPTION 'the figures of a snapshot are written while it is being built' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_figure_building_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER period_snapshot_figure_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.period_snapshot_figure FOR EACH ROW EXECUTE FUNCTION machvon.period_snapshot_figure_guard();

ALTER TABLE machvon.period_snapshot_figure ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.period_snapshot_figure FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.period_snapshot_figure AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.period_snapshot_figure AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.period_snapshot_figure FROM machvon_app;

COMMENT ON TABLE machvon.plan_figure_revision IS 'FND-1: append-only revisions of the phased plan, estimates and actuals (and the enterprise year plan); the status moves forward only; maker is not checker.';
COMMENT ON TABLE machvon.period_snapshot_figure IS 'FND-1: the long-format figures of a period snapshot, written once while it is being built.';

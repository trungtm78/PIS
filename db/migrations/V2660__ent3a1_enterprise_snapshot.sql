-- Authored by hand (not generated): ENT-3a (docs/ent-snapshot.md, docs/plans/ent3a.md). The enterprise period snapshot.
--   * A new snapshot kind `ENTERPRISE_CLOSE`: the frozen figures of an enterprise period. Every reader of the public edition that looks for `PERIOD_CLOSE` never sees it, so a public figure cannot be replaced by an
--     enterprise one. The kind belongs to the ENTERPRISE pack and to hash schema 2, and whoever froze it is not the person who built it (maker is not checker, judged here as well as in the command).
--   * `period_snapshot_indicator`: the figures of the indicator dictionary (`ind_figure`) in force at the freeze, written once while the snapshot is being built, covered by the same hash. Funding figures stay in
--     `period_snapshot_figure` (FND-1); the dictionary figures are not funding figures (their unit is a percent, a count or a number of days), so they have a table of their own.

ALTER TABLE machvon.period_snapshot
  DROP CONSTRAINT period_snapshot_kind_chk,
  ADD CONSTRAINT period_snapshot_kind_chk CHECK (snapshot_kind IN ('PERIOD_CLOSE', 'ADHOC', 'MNE', 'RESTATED', 'ENTERPRISE_CLOSE')),
  ADD CONSTRAINT period_snapshot_enterprise_chk CHECK (snapshot_kind <> 'ENTERPRISE_CLOSE' OR (taxonomy_pack = 'ENTERPRISE' AND hash_schema = 2)),
  ADD CONSTRAINT period_snapshot_enterprise_sod_chk CHECK (snapshot_kind <> 'ENTERPRISE_CLOSE' OR frozen_by IS NULL OR frozen_by <> created_by);

-- One enterprise snapshot of a period at each revision: a revision number is never used twice, so the lineage (revision, supersedes_id) is a chain.
CREATE UNIQUE INDEX period_snapshot_enterprise_revision_uq ON machvon.period_snapshot (tenant_id, period_id, revision) WHERE snapshot_kind = 'ENTERPRISE_CLOSE' AND status IN ('FROZEN', 'SUPERSEDED');

CREATE TABLE machvon.period_snapshot_indicator (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  project_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  indicator_code text NOT NULL,
  value numeric(30, 6) NOT NULL,
  unit text NOT NULL,
  definition_version integer NOT NULL,
  revision integer NOT NULL,
  source_figure_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, source_figure_id) REFERENCES machvon.ind_figure (tenant_id, id),
  CONSTRAINT snapshot_indicator_code_chk CHECK (indicator_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT snapshot_indicator_unit_chk CHECK (unit IN ('PERCENT', 'VND', 'COUNT', 'DAYS', 'RATIO')),
  CONSTRAINT snapshot_indicator_revision_chk CHECK (revision >= 1 AND definition_version >= 0),
  CONSTRAINT snapshot_indicator_cell_uq UNIQUE (tenant_id, snapshot_id, project_id, indicator_code)
);
CREATE INDEX snapshot_indicator_project_idx ON machvon.period_snapshot_indicator (tenant_id, project_id);
CREATE INDEX snapshot_indicator_unit_idx ON machvon.period_snapshot_indicator (tenant_id, unit_id);
CREATE INDEX snapshot_indicator_source_idx ON machvon.period_snapshot_indicator (tenant_id, source_figure_id);

CREATE FUNCTION machvon.period_snapshot_indicator_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'the indicator figures of a snapshot are not changed' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_indicator_immutable_guard';
  END IF;
  SELECT s.status INTO parent_status FROM machvon.period_snapshot s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.snapshot_id;
  IF parent_status IS DISTINCT FROM 'BUILDING' THEN
    RAISE EXCEPTION 'the indicator figures of a snapshot are written while it is being built' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_indicator_building_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER period_snapshot_indicator_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.period_snapshot_indicator FOR EACH ROW EXECUTE FUNCTION machvon.period_snapshot_indicator_guard();

ALTER TABLE machvon.period_snapshot_indicator ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.period_snapshot_indicator FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.period_snapshot_indicator AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.period_snapshot_indicator AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.period_snapshot_indicator FROM machvon_app;

COMMENT ON TABLE machvon.period_snapshot_indicator IS 'ENT-3a: the figures of the indicator dictionary in force when an enterprise snapshot was built, written once and covered by the hash of the snapshot.';

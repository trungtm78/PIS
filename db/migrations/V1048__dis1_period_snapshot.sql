-- ST-DIS-009: the period snapshot, built from the accepted reports, the plan in force and the Treasury, frozen with a hash, replaced only by a newer one (DIS 3 F6, BR-DIS-02, BR-DIS-05, BR-DIS-06).
--
-- V002 gave `period_snapshot` and `period_snapshot_line` their columns, the frozen check (a frozen snapshot has its hash and its instant), one FROZEN snapshot for a period and a kind, the plan check
-- of a line (the total is the two parts) and the rule that a rate that is null says why. This migration makes the database say what the commands rely on:
--   * a snapshot that is not frozen has no hash and no one who froze it; one that is frozen or superseded has both; one that replaced another says so only once it is frozen;
--   * what a snapshot is (its period, kind, day, cutoff and formulas) never changes; it moves from BUILDING to FROZEN or FAILED, from FROZEN to SUPERSEDED, and no other way; a frozen snapshot keeps
--     its hash and its figures for good, and none is deleted;
--   * the lines of a snapshot are written while it is being built and are never touched again; a rate is a percent, not a negative one; the plan is not negative.

ALTER TABLE machvon.period_snapshot
  ADD CONSTRAINT period_snapshot_rows_chk CHECK (row_count >= 0),
  ADD CONSTRAINT period_snapshot_building_chk CHECK (status NOT IN ('BUILDING', 'FAILED') OR (frozen_at IS NULL AND frozen_by IS NULL AND payload_sha256 IS NULL)),
  ADD CONSTRAINT period_snapshot_frozen_by_chk CHECK ((status IN ('FROZEN', 'SUPERSEDED')) = (frozen_by IS NOT NULL)),
  ADD CONSTRAINT period_snapshot_supersedes_chk CHECK (supersedes_id IS NULL OR status IN ('FROZEN', 'SUPERSEDED')),
  ADD CONSTRAINT period_snapshot_hash_chk CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE machvon.period_snapshot_line
  ADD CONSTRAINT snapshot_line_plan_nonneg_chk CHECK (plan_pm_assigned_vnd >= 0 AND plan_local_added_vnd >= 0),
  ADD CONSTRAINT snapshot_line_rate_nonneg_chk CHECK ((rate_pm_pct IS NULL OR rate_pm_pct >= 0) AND (rate_total_pct IS NULL OR rate_total_pct >= 0)),
  ADD CONSTRAINT snapshot_line_ctmtqg_chk CHECK (ctmtqg_subset_vnd IS NULL OR (ctmtqg_subset_vnd >= 0 AND (disbursed_reported_vnd IS NULL OR ctmtqg_subset_vnd <= disbursed_reported_vnd)));

CREATE INDEX period_snapshot_kind_idx ON machvon.period_snapshot (tenant_id, period_id, snapshot_kind, created_at DESC, id DESC);

CREATE FUNCTION machvon.period_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a period snapshot is kept' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_guard';
  END IF;
  IF NEW.period_id <> OLD.period_id OR NEW.snapshot_kind <> OLD.snapshot_kind OR NEW.as_of_at <> OLD.as_of_at OR NEW.as_of_date <> OLD.as_of_date OR NEW.treasury_cutoff_date <> OLD.treasury_cutoff_date
     OR NEW.metric_set_version <> OLD.metric_set_version OR NEW.definition_status <> OLD.definition_status OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'what a period snapshot is does not change' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_identity_guard';
  END IF;
  IF OLD.status IN ('FROZEN', 'SUPERSEDED') AND (NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256 OR NEW.frozen_by IS DISTINCT FROM OLD.frozen_by OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at
     OR NEW.row_count <> OLD.row_count OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id) THEN
    RAISE EXCEPTION 'a frozen snapshot is not changed: a correction is a newer snapshot' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_frozen_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'BUILDING' AND NEW.status IN ('FROZEN', 'FAILED'))
    OR (OLD.status = 'FROZEN' AND NEW.status = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'a period snapshot does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_transition_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER period_snapshot_guard BEFORE UPDATE OR DELETE ON machvon.period_snapshot FOR EACH ROW EXECUTE FUNCTION machvon.period_snapshot_guard();

-- The lines are written while the snapshot is being built and never touched or deleted again.
CREATE FUNCTION machvon.period_snapshot_line_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
  owner_tenant uuid;
  owner_snapshot uuid;
BEGIN
  owner_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  owner_snapshot := CASE WHEN TG_OP = 'DELETE' THEN OLD.snapshot_id ELSE NEW.snapshot_id END;
  SELECT s.status INTO parent_status FROM machvon.period_snapshot s WHERE s.tenant_id = owner_tenant AND s.id = owner_snapshot;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'the lines of a snapshot are not changed' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_line_immutable_guard';
  END IF;
  IF parent_status IS DISTINCT FROM 'BUILDING' THEN
    RAISE EXCEPTION 'the lines of a snapshot are written while it is being built' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_line_building_guard';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER period_snapshot_line_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.period_snapshot_line FOR EACH ROW EXECUTE FUNCTION machvon.period_snapshot_line_guard();

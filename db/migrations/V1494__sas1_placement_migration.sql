-- ST-SAS-018 (SAS.md 3.3, BR-SAS-05): the promotion of a tenant from the shared placement to a database of its own, with a cutover that is verified.
-- V002 gave `tenant_placement_migration` its status, its freeze limit (5..240 minutes), one open migration for a tenant and the four-eyes check (the approver is not the one who started it). What a cutover needs to stay
-- trustworthy is put into the database here, whatever the application checked first:
--   * the migration remembers why it was asked for, from when, who approved and with what words, the comparison of the copy with the original (kept whole, with a reference to it), when it was switched and completed,
--     how it ended and who ended it (nobody: the system), what the worker last failed on, and when the copy and the old data were destroyed;
--   * what was asked for never changes, an approval is not taken back, a migration moves only forward along the states of the workflow, and one that ended changes only in the bookkeeping of what was destroyed;
--   * a migration cannot be frozen, switched or completed without an approval by someone else, and cannot be switched without a comparison that agreed;
--   * the routing of the tenant (its placement and its isolation) changes only with a migration that was switched, and goes back only with one that was rolled back;
--   * the tenant plane may read its migration and nothing else; the control plane writes it, acting as the tenant, and finds a migration by its id alone through a directory that no tenant can read.

ALTER TABLE machvon.tenant_placement_migration ADD COLUMN reason text NOT NULL DEFAULT '';
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN planned_window_start timestamptz NOT NULL DEFAULT now();
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN cutover_approved_at timestamptz;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN approval_reason text;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN verified_at timestamptz;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN verification_report jsonb;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN switched_at timestamptz;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN completed_at timestamptz;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN ended_at timestamptz;
-- Nobody when the system ended the migration by itself (the freeze ran out, the last comparison disagreed).
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN ended_by uuid;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN end_reason text;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN last_error_code text;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN target_discarded_at timestamptz;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN source_purge_due_at timestamptz;
ALTER TABLE machvon.tenant_placement_migration ADD COLUMN source_purged_at timestamptz;

-- The table holds no migration yet (the feature is new), so the checks below are validated against nothing.
ALTER TABLE machvon.tenant_placement_migration ADD CONSTRAINT tenant_placement_migration_reason_ck CHECK (length(btrim(reason)) BETWEEN 10 AND 2000);
-- A comparison is kept whole, with its time, its reference and its verdict, or not at all; from the wait for the cutover on there is one.
ALTER TABLE machvon.tenant_placement_migration ADD CONSTRAINT tenant_placement_migration_report_ck CHECK (
  (verification_report IS NULL) = (verified_at IS NULL) AND (verification_report IS NULL) = (verification_report_ref IS NULL) AND (verification_report IS NULL) = (checksum_match IS NULL)
);
ALTER TABLE machvon.tenant_placement_migration ADD CONSTRAINT tenant_placement_migration_verified_ck CHECK (
  status NOT IN ('AwaitingCutover', 'CutoverFrozen', 'Switched', 'Completed') OR verification_report IS NOT NULL
);
-- Writes are frozen, and the routing switched, only after somebody other than the one who started approved; the freeze has a start.
ALTER TABLE machvon.tenant_placement_migration ADD CONSTRAINT tenant_placement_migration_approved_ck CHECK (
  status NOT IN ('CutoverFrozen', 'Switched', 'Completed') OR (cutover_approved_by IS NOT NULL AND cutover_approved_at IS NOT NULL AND approval_reason IS NOT NULL AND write_freeze_started_at IS NOT NULL)
);
ALTER TABLE machvon.tenant_placement_migration ADD CONSTRAINT tenant_placement_migration_switched_ck CHECK (
  (status IN ('Switched', 'Completed')) <= (switched_at IS NOT NULL AND checksum_match IS TRUE)
);
ALTER TABLE machvon.tenant_placement_migration ADD CONSTRAINT tenant_placement_migration_completed_ck CHECK (
  (status = 'Completed') = (completed_at IS NOT NULL) AND (source_purge_due_at IS NULL OR status = 'Completed') AND (source_purged_at IS NULL OR source_purge_due_at IS NOT NULL)
);
ALTER TABLE machvon.tenant_placement_migration ADD CONSTRAINT tenant_placement_migration_ended_ck CHECK (
  (status IN ('Aborted', 'RolledBack')) = (ended_at IS NOT NULL) AND (ended_at IS NULL OR length(btrim(end_reason)) > 0) AND (ended_by IS NULL OR ended_at IS NOT NULL)
  AND (target_discarded_at IS NULL OR ended_at IS NOT NULL)
);

CREATE FUNCTION machvon.guard_tenant_placement_migration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PLACEMENT_MIGRATION_IMMUTABLE: a migration is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.from_placement_id, NEW.to_placement_id, NEW.write_freeze_max_minutes, NEW.reason, NEW.planned_window_start, NEW.requested_by, NEW.temporal_workflow_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.from_placement_id, OLD.to_placement_id, OLD.write_freeze_max_minutes, OLD.reason, OLD.planned_window_start, OLD.requested_by, OLD.temporal_workflow_id, OLD.created_at) THEN
    RAISE EXCEPTION 'PLACEMENT_MIGRATION_IMMUTABLE: what was asked for does not change' USING ERRCODE = '23514';
  END IF;
  -- A migration that ended changes only in what the worker records of the data it destroyed (and of the failure it met).
  IF OLD.status IN ('Completed', 'Aborted', 'RolledBack') THEN
    IF NEW.status <> OLD.status
       OR (to_jsonb(NEW) - 'target_discarded_at' - 'source_purged_at' - 'last_error_code' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'target_discarded_at' - 'source_purged_at' - 'last_error_code' - 'version') THEN
      RAISE EXCEPTION 'PLACEMENT_MIGRATION_IMMUTABLE: a migration that ended does not change' USING ERRCODE = '23514';
    END IF;
    IF (OLD.target_discarded_at IS NOT NULL AND NEW.target_discarded_at IS DISTINCT FROM OLD.target_discarded_at) OR (OLD.source_purged_at IS NOT NULL AND NEW.source_purged_at IS DISTINCT FROM OLD.source_purged_at) THEN
      RAISE EXCEPTION 'PLACEMENT_MIGRATION_IMMUTABLE: what was destroyed is recorded once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('Planned', 'Copying'), ('Copying', 'Verifying'), ('Verifying', 'AwaitingCutover'), ('AwaitingCutover', 'CutoverFrozen'), ('CutoverFrozen', 'Switched'), ('Switched', 'Completed'),
       ('Planned', 'Aborted'), ('Copying', 'Aborted'), ('Verifying', 'Aborted'), ('AwaitingCutover', 'Aborted'), ('CutoverFrozen', 'RolledBack'), ('Switched', 'RolledBack'))) THEN
    RAISE EXCEPTION 'PLACEMENT_MIGRATION_IMMUTABLE: a migration does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- An approval is not taken back and not handed to somebody else; the freeze and the switch are recorded once.
  IF (OLD.cutover_approved_by IS NOT NULL AND (NEW.cutover_approved_by IS DISTINCT FROM OLD.cutover_approved_by OR NEW.cutover_approved_at IS DISTINCT FROM OLD.cutover_approved_at OR NEW.approval_reason IS DISTINCT FROM OLD.approval_reason))
     OR (OLD.write_freeze_started_at IS NOT NULL AND NEW.write_freeze_started_at IS DISTINCT FROM OLD.write_freeze_started_at)
     OR (OLD.switched_at IS NOT NULL AND NEW.switched_at IS DISTINCT FROM OLD.switched_at) THEN
    RAISE EXCEPTION 'PLACEMENT_MIGRATION_IMMUTABLE: an approval, a freeze and a switch are recorded once' USING ERRCODE = '23514';
  END IF;
  -- The comparison that let the cutover go ahead is not replaced once the cutover began, except by the comparison that precedes the switch.
  IF OLD.status IN ('Switched') AND (NEW.verification_report IS DISTINCT FROM OLD.verification_report OR NEW.checksum_match IS DISTINCT FROM OLD.checksum_match) THEN
    RAISE EXCEPTION 'PLACEMENT_MIGRATION_IMMUTABLE: the comparison of a switched migration does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_placement_migration_guard BEFORE UPDATE OR DELETE ON machvon.tenant_placement_migration FOR EACH ROW EXECUTE FUNCTION machvon.guard_tenant_placement_migration();

-- The tenant plane reads its migration (the Tenant Owner sees it) and cannot start, approve, change or abort one; the control plane writes it acting as the tenant.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE machvon.tenant_placement_migration FROM machvon_app;
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.tenant_placement_migration TO machvon_control;
REVOKE DELETE, TRUNCATE ON TABLE machvon.tenant_placement_migration FROM machvon_control;
CREATE INDEX tenant_placement_migration_ended_by_idx ON machvon.tenant_placement_migration (tenant_id, ended_by);
CREATE INDEX tenant_placement_migration_approved_by_idx ON machvon.tenant_placement_migration (tenant_id, cutover_approved_by);

-- Row-level security hides the migrations of other tenants, and the platform has to find the tenant of a migration that is named by its id alone, and to count the migrations on their way to a placement (a silo is one tenant's own).
-- The directory has one row for each migration, no row-level security, is read by the control plane alone, and is kept by the trigger below, not by the application.
CREATE TABLE machvon.tenant_placement_migration_directory (
  migration_id uuid PRIMARY KEY,
  holder_tenant_id uuid NOT NULL REFERENCES machvon.tenant (id),
  to_placement_id uuid NOT NULL REFERENCES machvon.placement (id),
  open boolean NOT NULL
);
CREATE INDEX tenant_placement_migration_directory_tenant_idx ON machvon.tenant_placement_migration_directory (holder_tenant_id);
CREATE INDEX tenant_placement_migration_directory_placement_idx ON machvon.tenant_placement_migration_directory (to_placement_id) WHERE open;
REVOKE ALL ON TABLE machvon.tenant_placement_migration_directory FROM PUBLIC, machvon_app, machvon_outbox_relay, machvon_reporting, machvon_sync;
GRANT SELECT ON TABLE machvon.tenant_placement_migration_directory TO machvon_control;

CREATE FUNCTION machvon.keep_tenant_placement_migration_directory() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
BEGIN
  INSERT INTO machvon.tenant_placement_migration_directory (migration_id, holder_tenant_id, to_placement_id, open)
  VALUES (NEW.id, NEW.tenant_id, NEW.to_placement_id, NEW.status NOT IN ('Completed', 'Aborted', 'RolledBack'))
  ON CONFLICT (migration_id) DO UPDATE SET open = EXCLUDED.open;
  RETURN NEW;
END $fn$;
CREATE TRIGGER tenant_placement_migration_directory_tg AFTER INSERT OR UPDATE ON machvon.tenant_placement_migration FOR EACH ROW EXECUTE FUNCTION machvon.keep_tenant_placement_migration_directory();

CREATE FUNCTION machvon.placement_migration_tenant_of(p_migration uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT d.holder_tenant_id FROM machvon.tenant_placement_migration_directory d WHERE d.migration_id = p_migration;
$fn$;
-- The migrations on their way to a placement, of every tenant, that are not over.
CREATE FUNCTION machvon.placement_incoming_migrations(p_placement uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT count(*)::integer FROM machvon.tenant_placement_migration_directory d WHERE d.to_placement_id = p_placement AND d.open;
$fn$;
REVOKE ALL ON FUNCTION machvon.placement_migration_tenant_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.placement_incoming_migrations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.placement_migration_tenant_of(uuid) TO machvon_control;
GRANT EXECUTE ON FUNCTION machvon.placement_incoming_migrations(uuid) TO machvon_control;

-- The routing of a tenant (its placement and its isolation) is changed by a promotion that was switched, and put back by one that was rolled back: no command and no hand edit moves a tenant to another database on its own.
-- The migrations of the tenant are asked while the transaction acts as that tenant (row-level security).
CREATE FUNCTION machvon.guard_tenant_routing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM machvon.tenant_placement_migration m
     WHERE m.tenant_id = NEW.id AND m.switched_at IS NOT NULL
       AND ((m.status = 'Switched' AND m.checksum_match IS TRUE AND OLD.placement_id = m.from_placement_id AND NEW.placement_id = m.to_placement_id AND NEW.isolation_mode = 'SILO')
         OR (m.status = 'RolledBack' AND OLD.placement_id = m.to_placement_id AND NEW.placement_id = m.from_placement_id AND NEW.isolation_mode = 'POOL'))
  ) THEN
    RAISE EXCEPTION 'TENANT_ROUTING_GUARDED: the placement of a tenant changes only with a switched promotion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_routing_guard BEFORE UPDATE OF placement_id, isolation_mode ON machvon.tenant FOR EACH ROW WHEN (NEW.placement_id IS DISTINCT FROM OLD.placement_id OR NEW.isolation_mode IS DISTINCT FROM OLD.isolation_mode) EXECUTE FUNCTION machvon.guard_tenant_routing();

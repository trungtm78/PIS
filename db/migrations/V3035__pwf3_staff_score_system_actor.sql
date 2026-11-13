-- Authored by hand (not generated): the system turn of the maintenance job on a scoring period (PWF-3, docs PWF 9, R43).
-- The job `pwf-score-maintenance` makes a locked period official as the worker of the platform (WORKER_MEMBERSHIP_ID, the zero uuid): there is no membership row for it, so the foreign keys of `official_by` and
-- `updated_by` to `membership` (V3031) made every such transaction fail and roll back with it the KPI results of the same pass. The foreign keys stay, declarative and scoped to the tenant, so that a membership
-- that is named as the one who made a period official (or who last updated it) can be neither deleted nor have its key changed. The worker is recorded the other way round: `official_by` and `updated_by` are NULL
-- and a discriminator (`official_by_system`, `updated_by_system`) says that the system itself acted. A human actor and the system are told apart by the database, with no value in a column that points at nothing.
-- The system may only be recorded as the one who made a LOCKED period official (and as the last updater of that step), never on a draft or a lock; the existing rows are all human, so the discriminators start false.

ALTER TABLE machvon.staff_score_period
  ALTER COLUMN updated_by DROP NOT NULL,
  ADD COLUMN official_by_system boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_by_system boolean NOT NULL DEFAULT false;

-- Backfill: a row that names the worker of the platform (only a database that applied an earlier form of this step can hold one) becomes a row of the system.
UPDATE machvon.staff_score_period
   SET official_by_system = (official_by = '00000000-0000-4000-8000-000000000000'),
       official_by = CASE WHEN official_by = '00000000-0000-4000-8000-000000000000' THEN NULL ELSE official_by END,
       updated_by_system = (updated_by = '00000000-0000-4000-8000-000000000000'),
       updated_by = CASE WHEN updated_by = '00000000-0000-4000-8000-000000000000' THEN NULL ELSE updated_by END
 WHERE official_by = '00000000-0000-4000-8000-000000000000' OR updated_by = '00000000-0000-4000-8000-000000000000';

ALTER TABLE machvon.staff_score_period DROP CONSTRAINT staff_score_period_official_chk;
ALTER TABLE machvon.staff_score_period
  -- An official period says who made it official: one membership of the tenant or the system, never both and never neither; any other period says nobody.
  ADD CONSTRAINT staff_score_period_official_chk CHECK (
    (status = 'OFFICIAL') = (official_at IS NOT NULL)
    AND (official_at IS NULL) = (official_by IS NULL AND NOT official_by_system)
    AND NOT (official_by IS NOT NULL AND official_by_system)
  ),
  ADD CONSTRAINT staff_score_period_updated_actor_chk CHECK ((updated_by IS NULL) = updated_by_system);

CREATE FUNCTION machvon.check_staff_score_period_system_actor() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- The system acts only when a locked period becomes official on its own, never on a draft or a lock. A row that already carries the mark (an erasure at the end of the retention touches other columns) is not judged again.
  IF (NEW.official_by_system AND NOT (TG_OP = 'UPDATE' AND OLD.official_by_system)) OR (NEW.updated_by_system AND NOT (TG_OP = 'UPDATE' AND OLD.updated_by_system)) THEN
    IF TG_OP <> 'UPDATE' OR OLD.status <> 'LOCKED' OR NEW.status <> 'OFFICIAL' THEN
      RAISE EXCEPTION 'the system may only make a locked scoring period official' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER staff_score_period_system_actor BEFORE INSERT OR UPDATE ON machvon.staff_score_period
  FOR EACH ROW EXECUTE FUNCTION machvon.check_staff_score_period_system_actor();

COMMENT ON COLUMN machvon.staff_score_period.official_by_system IS 'The system (the maintenance job of PWF 9) made the locked period official: official_by is NULL then.';
COMMENT ON COLUMN machvon.staff_score_period.updated_by_system IS 'The system made the last update of the period (the step to official): updated_by is NULL then.';
COMMENT ON FUNCTION machvon.check_staff_score_period_system_actor() IS 'The system may be recorded only as the one who made a locked scoring period official (the job of PWF 9); membership actors keep their declarative foreign keys.';

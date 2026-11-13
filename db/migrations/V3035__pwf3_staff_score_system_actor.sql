-- Authored by hand (not generated): the system turn of the maintenance job on a scoring period (PWF-3, docs PWF 9, R43).
-- The job `pwf-score-maintenance` makes a locked period official as the worker of the platform (WORKER_MEMBERSHIP_ID, the zero uuid): there is no membership row for it, so the foreign keys of `official_by` and
-- `updated_by` to `membership` (V3031) made every such transaction fail and roll back with it the KPI results of the same pass. Those two columns may now hold the worker of the platform; every other value
-- still has to be a membership of the tenant, checked by a trigger as the foreign keys did. `locked_by`, `computed_by` and `created_by` keep their foreign keys: locking stays a human act. The worker may only
-- be recorded as the one who made a LOCKED period official (and as the last updater of that step), never on a draft or a lock.

DO $do$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_constraint c
     WHERE c.conrelid = 'machvon.staff_score_period'::regclass AND c.contype = 'f'
       AND c.confrelid = 'machvon.membership'::regclass
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) IN (ARRAY['official_by', 'tenant_id'], ARRAY['tenant_id', 'updated_by'])
  LOOP
    EXECUTE format('ALTER TABLE machvon.staff_score_period DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$do$;

CREATE FUNCTION machvon.check_staff_score_period_actors() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  c_worker CONSTANT uuid := '00000000-0000-4000-8000-000000000000';
  v_actor uuid;
BEGIN
  FOR v_actor IN
    SELECT a FROM unnest(ARRAY[NEW.official_by, NEW.updated_by]) AS a
  LOOP
    -- An actor that is already on the row (an erasure at the end of the retention touches other columns) is not judged again.
    IF v_actor IS NULL OR (TG_OP = 'UPDATE' AND v_actor IN (OLD.official_by, OLD.updated_by)) THEN
      CONTINUE;
    END IF;
    IF v_actor = c_worker THEN
      -- The worker of the platform acts only when a locked period becomes official on its own, never on a draft or a lock.
      IF NEW.status <> 'OFFICIAL' OR TG_OP <> 'UPDATE' OR OLD.status <> 'LOCKED' THEN
        RAISE EXCEPTION 'the worker of the platform may only make a locked scoring period official' USING ERRCODE = '23503';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM machvon.membership m WHERE m.tenant_id = NEW.tenant_id AND m.id = v_actor) THEN
      RAISE EXCEPTION 'the actor of a scoring period is not a membership of the tenant' USING ERRCODE = '23503';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER staff_score_period_actors BEFORE INSERT OR UPDATE ON machvon.staff_score_period
  FOR EACH ROW EXECUTE FUNCTION machvon.check_staff_score_period_actors();

COMMENT ON FUNCTION machvon.check_staff_score_period_actors() IS 'Replaces the foreign keys of official_by and updated_by of a scoring period to membership: the worker of the platform may make a locked period official (the job of PWF 9), anyone else must be a membership of the tenant.';

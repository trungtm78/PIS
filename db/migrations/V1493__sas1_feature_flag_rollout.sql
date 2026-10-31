-- Authored by hand (not generated): the release flags of the platform (ST-SAS-020, SAS 3.11, SAS-20).
-- V002 gave the control-plane table `feature_flag` its columns and V008 let the control role read it. A flag decides which code path a tenant runs while a release is staged and never grants an entitlement; its key is
-- declared in the code (DECLARED_FLAGS of the kernel), so this writes the declared flags as Off and lets the control role change a flag, never add or delete one. It adds the shape of a flag, the rule that a
-- flag in rollout names whom it is on for and one that is not names no one, a guard that keeps a retired flag, the key and the description as they are, and the loss of the right to delete.

GRANT UPDATE ON TABLE machvon.feature_flag TO machvon_control;
REVOKE DELETE, TRUNCATE ON TABLE machvon.feature_flag FROM machvon_control;

ALTER TABLE machvon.feature_flag
  ADD CONSTRAINT feature_flag_key_chk CHECK (flag_key ~ '^[a-z][a-z0-9_.]{2,63}$'),
  ADD CONSTRAINT feature_flag_rollout_chk CHECK (
    (
      jsonb_typeof(rollout_json) = 'object'
      AND jsonb_typeof(rollout_json -> 'tenant_cohorts') = 'array'
      AND jsonb_typeof(rollout_json -> 'tenant_ids') = 'array'
      AND jsonb_typeof(rollout_json -> 'percentage') = 'number'
      AND (rollout_json ->> 'percentage')::numeric BETWEEN 0 AND 100
    ) IS TRUE
  ),
  ADD CONSTRAINT feature_flag_names_chk CHECK (
    (status = 'Rollout') = (
      jsonb_array_length(rollout_json -> 'tenant_cohorts') > 0 OR jsonb_array_length(rollout_json -> 'tenant_ids') > 0 OR (rollout_json ->> 'percentage')::numeric > 0
    )
  );

CREATE FUNCTION machvon.guard_feature_flag_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status = 'Retired' THEN
    RAISE EXCEPTION 'a retired flag is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.flag_key IS DISTINCT FROM OLD.flag_key OR NEW.description IS DISTINCT FROM OLD.description OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'a flag keeps its key and its description' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'a flag moves one revision at a time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER feature_flag_update_guard BEFORE UPDATE ON machvon.feature_flag
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_feature_flag_update();

-- The flags the code declares, all Off. The platform (the same actor id as the platform tenant) wrote them.
INSERT INTO machvon.feature_flag (id, flag_key, description, rollout_json, status, revision, updated_by)
VALUES
  (gen_random_uuid(), 'sas.silo_promotion', 'Promotion of a tenant from the shared placement to a silo of its own (SAS-23)', '{"tenant_cohorts": [], "tenant_ids": [], "percentage": 0}'::jsonb, 'Off', 1, '00000000-0000-4000-8000-0000000000aa'),
  (gen_random_uuid(), 'sas.tenant_restore_in_place', 'Restore of a tenant in place at a recovery point, for a Suspended tenant (SAS-21)', '{"tenant_cohorts": [], "tenant_ids": [], "percentage": 0}'::jsonb, 'Off', 1, '00000000-0000-4000-8000-0000000000aa');

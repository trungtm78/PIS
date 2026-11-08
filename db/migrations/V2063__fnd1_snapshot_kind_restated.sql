-- Authored by hand (not generated): FND-1 step 3 (docs/fnd-funding-model.md sections 6.5, 8 I6). A snapshot of a closed period is the "as reported" evidence and is never rewritten; a restatement is a NEW snapshot of
-- the kind RESTATED that names the snapshot it restates and is read in the restated view. This migration adds the kind, makes the guard of a snapshot keep what the snapshot was built with (pack, version, hash schema,
-- revision), and holds a restatement to the rules: it names what it restates, the restated snapshot is of the same period and the same pack, and only a restatement names one.

DO $fnd1$
DECLARE
  old_check text;
BEGIN
  SELECT c.conname INTO old_check
    FROM pg_constraint c
   WHERE c.conrelid = 'machvon.period_snapshot'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%snapshot_kind%' AND pg_get_constraintdef(c.oid) LIKE '%PERIOD_CLOSE%';
  IF old_check IS NULL THEN
    RAISE EXCEPTION 'the check on period_snapshot.snapshot_kind was not found';
  END IF;
  EXECUTE format('ALTER TABLE machvon.period_snapshot DROP CONSTRAINT %I', old_check);
END
$fnd1$;

ALTER TABLE machvon.period_snapshot
  ADD CONSTRAINT period_snapshot_kind_chk CHECK (snapshot_kind IN ('PERIOD_CLOSE', 'ADHOC', 'MNE', 'RESTATED')),
  ADD CONSTRAINT period_snapshot_restates_chk CHECK ((snapshot_kind = 'RESTATED') = (restates_snapshot_id IS NOT NULL)),
  ADD CONSTRAINT period_snapshot_hash_pack_chk CHECK (hash_schema = 2 OR (taxonomy_pack = 'PUBLIC' AND taxonomy_version = 1));

CREATE OR REPLACE FUNCTION machvon.period_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a period snapshot is kept' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_guard';
  END IF;
  IF NEW.period_id <> OLD.period_id OR NEW.snapshot_kind <> OLD.snapshot_kind OR NEW.as_of_at <> OLD.as_of_at OR NEW.as_of_date <> OLD.as_of_date OR NEW.treasury_cutoff_date <> OLD.treasury_cutoff_date
     OR NEW.metric_set_version <> OLD.metric_set_version OR NEW.definition_status <> OLD.definition_status OR NEW.created_by <> OLD.created_by
     OR NEW.taxonomy_pack <> OLD.taxonomy_pack OR NEW.taxonomy_rule_id IS DISTINCT FROM OLD.taxonomy_rule_id OR NEW.taxonomy_version <> OLD.taxonomy_version OR NEW.hash_schema <> OLD.hash_schema
     OR NEW.restates_snapshot_id IS DISTINCT FROM OLD.restates_snapshot_id OR NEW.revision <> OLD.revision THEN
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

-- A restatement names a snapshot of the same period and the same pack; the as-reported evidence it restates is a frozen or superseded snapshot, never one being built.
CREATE FUNCTION machvon.period_snapshot_restates_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  restated record;
BEGIN
  IF NEW.restates_snapshot_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.period_id, s.taxonomy_pack, s.status, s.snapshot_kind INTO restated FROM machvon.period_snapshot s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.restates_snapshot_id;
  IF NOT FOUND OR restated.period_id <> NEW.period_id OR restated.taxonomy_pack <> NEW.taxonomy_pack OR restated.status NOT IN ('FROZEN', 'SUPERSEDED') OR restated.snapshot_kind = 'ADHOC' THEN
    RAISE EXCEPTION 'a restatement restates a closed snapshot of the same period and pack' USING ERRCODE = '23514', CONSTRAINT = 'period_snapshot_restates_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER period_snapshot_restates_guard BEFORE INSERT ON machvon.period_snapshot FOR EACH ROW EXECUTE FUNCTION machvon.period_snapshot_restates_guard();

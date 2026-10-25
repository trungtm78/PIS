-- Authored by hand (not generated): the milestones of a package, the batches of the files of the national bidding system and the links between a package and its code on that
-- network (ST-BID-005, BID 3 F8). The tables procurement_milestone, procurement_import_batch and procurement_external_link come from the generated schema (V002) with their unique
-- indexes and foreign keys; this adds what the commands rely on: a milestone has the source it was written by and at least one date, a batch is a record that is not changed once
-- applied, a link carries its difference with an owner, and none of the three is deleted by the runtime role.

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A milestone: written by hand (MANUAL, no batch) or by a file (IMPORT, with the batch that brought it and the date it carries).
-- ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.procurement_milestone
  ADD CONSTRAINT procurement_milestone_source_chk CHECK ((source = 'IMPORT') = (import_batch_id IS NOT NULL)),
  ADD CONSTRAINT procurement_milestone_dated_chk CHECK (planned_at IS NOT NULL OR actual_at IS NOT NULL),
  ADD CONSTRAINT procurement_milestone_import_actual_chk CHECK (source <> 'IMPORT' OR actual_at IS NOT NULL);

CREATE FUNCTION machvon.guard_procurement_milestone() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.package_id IS DISTINCT FROM OLD.package_id OR NEW.milestone_kind IS DISTINCT FROM OLD.milestone_kind THEN
    RAISE EXCEPTION 'a milestone keeps its package and its kind' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER procurement_milestone_guard BEFORE UPDATE ON machvon.procurement_milestone
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_procurement_milestone();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A batch: the counts add up, the errors are a list, a dry run is never applied, and a batch that is applied is a record that is not changed again.
-- ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.procurement_import_batch
  ADD CONSTRAINT procurement_import_batch_counts_chk CHECK (rows_ok >= 0 AND rows_error >= 0 AND rows_total >= rows_ok + rows_error),
  ADD CONSTRAINT procurement_import_batch_errors_chk CHECK (jsonb_typeof(errors_json) = 'array'),
  ADD CONSTRAINT procurement_import_batch_mode_chk CHECK (mode = 'APPLY' OR status IN ('STAGED', 'VALIDATED')),
  ADD CONSTRAINT procurement_import_batch_key_chk CHECK (file_object_key = btrim(file_object_key) AND file_object_key <> '' AND char_length(file_object_key) <= 500);

CREATE FUNCTION machvon.guard_procurement_import_batch() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status = 'APPLIED' THEN
    RAISE EXCEPTION 'an applied import batch is a record and is not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256 OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.file_object_key IS DISTINCT FROM OLD.file_object_key THEN
    RAISE EXCEPTION 'a batch keeps its file and its mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER procurement_import_batch_guard BEFORE UPDATE ON machvon.procurement_import_batch
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_procurement_import_batch();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A link: one code on the national network to a package (the code to one package is unique already), a difference that has an owner, and a package and a system that never change.
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX procurement_external_link_package_uq ON machvon.procurement_external_link (tenant_id, package_id, external_system);

ALTER TABLE machvon.procurement_external_link
  ADD CONSTRAINT procurement_external_link_code_chk CHECK (external_code = btrim(external_code) AND external_code <> '' AND char_length(external_code) <= 100),
  ADD CONSTRAINT procurement_external_link_diff_chk CHECK (
    jsonb_typeof(diff_json) = 'object'
    AND (diff_status <> 'IN_SYNC' OR diff_json = '{}'::jsonb)
    AND (diff_status <> 'DIFFERENT' OR diff_json <> '{}'::jsonb)
    AND (diff_status = 'IN_SYNC' OR diff_owner_user_id IS NOT NULL)
  );

CREATE FUNCTION machvon.guard_procurement_external_link() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.package_id IS DISTINCT FROM OLD.package_id OR NEW.external_system IS DISTINCT FROM OLD.external_system THEN
    RAISE EXCEPTION 'a link keeps its package and its system' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER procurement_external_link_guard BEFORE UPDATE ON machvon.procurement_external_link
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_procurement_external_link();

-- The milestones, the batches and the links of a package are part of the procurement dossier, kept under the retention of the project: no command deletes one.
REVOKE DELETE, TRUNCATE ON TABLE machvon.procurement_milestone FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.procurement_import_batch FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.procurement_external_link FROM machvon_app;

-- ST-DIS-008: the bulk import of weekly reports, with a dry run, the error of every row, and a file that is never applied twice (DIS 3 F1, NFR-OPERABILITY-06).
--
-- V002 gave `report_import_batch` its file hash, its layout (`mapping_version`), its counts, the errors of the rows and the rule that an applied file has no error and is applied once for a
-- period. This migration makes the database say the rest of what the commands rely on:
--   * the counts add up (valid rows and error rows are the rows of the file), the errors are a list, and a file that is ready to be applied has no error;
--   * a batch that was applied says who applied it and when, and the two go with the status; how many drafts it made and how many it brought up to date are kept with it;
--   * what identifies a batch (the period, the file, the layout) is never changed; an applied batch is never changed at all and none is deleted; a batch moves along DRY_RUN or VALIDATED to
--     APPLIED, FAILED or CANCELLED and no other way.

ALTER TABLE machvon.report_import_batch
  ADD COLUMN applied_by uuid,
  ADD COLUMN drafts_created integer NOT NULL DEFAULT 0,
  ADD COLUMN drafts_updated integer NOT NULL DEFAULT 0;

ALTER TABLE machvon.report_import_batch
  ADD CONSTRAINT report_import_counts_chk CHECK (total_rows >= 0 AND valid_rows >= 0 AND error_rows >= 0 AND valid_rows + error_rows = total_rows),
  ADD CONSTRAINT report_import_errors_chk CHECK (jsonb_typeof(errors_json) = 'array'),
  ADD CONSTRAINT report_import_validated_chk CHECK (status <> 'VALIDATED' OR error_rows = 0),
  ADD CONSTRAINT report_import_applied_by_chk CHECK ((status = 'APPLIED') = (applied_at IS NOT NULL AND applied_by IS NOT NULL)),
  ADD CONSTRAINT report_import_drafts_chk CHECK (drafts_created >= 0 AND drafts_updated >= 0 AND drafts_created + drafts_updated <= valid_rows),
  ADD CONSTRAINT report_import_file_chk CHECK (char_length(file_object_key) BETWEEN 1 AND 2000 AND char_length(mapping_version) BETWEEN 1 AND 50);

CREATE FUNCTION machvon.report_import_batch_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an import batch is kept' USING ERRCODE = '23514', CONSTRAINT = 'report_import_batch_guard';
  END IF;
  IF NEW.period_id <> OLD.period_id OR NEW.file_sha256 <> OLD.file_sha256 OR NEW.file_object_key <> OLD.file_object_key OR NEW.mapping_version <> OLD.mapping_version
     OR NEW.created_by <> OLD.created_by OR NEW.total_rows <> OLD.total_rows OR NEW.valid_rows <> OLD.valid_rows OR NEW.error_rows <> OLD.error_rows OR NEW.errors_json <> OLD.errors_json THEN
    RAISE EXCEPTION 'what an import batch is, and what was found in the file, are not changed' USING ERRCODE = '23514', CONSTRAINT = 'report_import_identity_guard';
  END IF;
  IF OLD.status = 'APPLIED' THEN
    RAISE EXCEPTION 'an applied import batch is not changed' USING ERRCODE = '23514', CONSTRAINT = 'report_import_applied_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'VALIDATED' AND NEW.status IN ('APPLIED', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'DRY_RUN' AND NEW.status IN ('CANCELLED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'an import batch does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'report_import_transition_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER report_import_batch_guard BEFORE UPDATE OR DELETE ON machvon.report_import_batch FOR EACH ROW EXECUTE FUNCTION machvon.report_import_batch_guard();

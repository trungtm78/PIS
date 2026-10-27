-- ST-MNE-004: the export package of an issued monitoring report and the receipt of its manual filing (MNE 3.1 F3, BR-MNE-05, CXN-05).
--
-- V002 gave `mne_export_package` its columns, the check that a confirmed filing has its receipt, and the unique key of a file (report, target, format, hash). This migration keeps what the commands
-- rely on: the day the person filed, the size of the file, when it was downloaded and when it expired, and rules the table keeps whoever writes to it:
--   * the key of a file (report, target, format, hash) is held by a package until it expires; then the same content may be made again;
--   * a package never changes what it is (report, target, format, file and hash) and is kept for good (nothing deletes it);
--   * it moves GENERATED -> DOWNLOADED -> SUBMISSION_CONFIRMED, or to REJECTED or EXPIRED, and a confirmed, rejected or expired one is final;
--   * the receipt is written once, together with the confirmation, by someone who is recorded, and the filing day is not in the future of the record.

ALTER TABLE machvon.mne_export_package
  ADD COLUMN file_size_bytes bigint,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN downloaded_at timestamptz,
  ADD COLUMN expired_at timestamptz;

-- A package that was confirmed before this migration has no day of filing: the day its receipt was recorded stands for it, and the person who recorded it is the one who made it when the table does not say.
UPDATE machvon.mne_export_package SET submitted_at = coalesce(receipt_recorded_at, updated_at), receipt_recorded_by = coalesce(receipt_recorded_by, created_by), receipt_recorded_at = coalesce(receipt_recorded_at, updated_at) WHERE status = 'SUBMISSION_CONFIRMED' AND submitted_at IS NULL;

ALTER TABLE machvon.mne_export_package
  ADD CONSTRAINT mne_export_package_size_chk CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  ADD CONSTRAINT mne_export_package_hash_chk CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT mne_export_package_confirmed_chk CHECK (status <> 'SUBMISSION_CONFIRMED' OR (submitted_at IS NOT NULL AND receipt_recorded_by IS NOT NULL)),
  ADD CONSTRAINT mne_export_package_receipt_text_chk CHECK (receipt_reference IS NULL OR char_length(receipt_reference) BETWEEN 3 AND 100);

-- A package that expired no longer holds the key of its file: the same content is made again as a new package (the expired one stays as the record of what it was).
DROP INDEX machvon.mne_export_file_uq;
CREATE UNIQUE INDEX mne_export_file_uq ON machvon.mne_export_package (tenant_id, mne_report_id, target_system, format, file_sha256) WHERE status <> 'EXPIRED';

CREATE INDEX mne_export_package_report_idx ON machvon.mne_export_package (tenant_id, mne_report_id, created_at DESC);
CREATE INDEX mne_export_package_receipt_document_idx ON machvon.mne_export_package (tenant_id, receipt_document_id) WHERE receipt_document_id IS NOT NULL;
CREATE INDEX mne_export_package_expiry_idx ON machvon.mne_export_package (tenant_id, created_at) WHERE status IN ('GENERATED', 'DOWNLOADED');

CREATE FUNCTION machvon.guard_mne_export_package() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.mne_report_id IS DISTINCT FROM OLD.mne_report_id OR NEW.target_system IS DISTINCT FROM OLD.target_system
     OR NEW.format IS DISTINCT FROM OLD.format OR NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
     OR NEW.adapter_status IS DISTINCT FROM OLD.adapter_status OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'an export package keeps its report, target, format, file and hash for good' USING ERRCODE = '23514';
  END IF;
  IF OLD.receipt_reference IS NOT NULL AND (NEW.receipt_reference IS DISTINCT FROM OLD.receipt_reference OR NEW.receipt_document_id IS DISTINCT FROM OLD.receipt_document_id
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.receipt_recorded_by IS DISTINCT FROM OLD.receipt_recorded_by) THEN
    RAISE EXCEPTION 'the receipt of a filing is written once' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN (('GENERATED', 'DOWNLOADED'), ('GENERATED', 'SUBMISSION_CONFIRMED'), ('DOWNLOADED', 'SUBMISSION_CONFIRMED'), ('GENERATED', 'REJECTED'), ('DOWNLOADED', 'REJECTED'),
       ('GENERATED', 'EXPIRED'), ('DOWNLOADED', 'EXPIRED')) THEN
    RAISE EXCEPTION 'the state transition of the export package is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER mne_export_package_guard BEFORE UPDATE ON machvon.mne_export_package FOR EACH ROW EXECUTE FUNCTION machvon.guard_mne_export_package();

-- A package is kept for good, as the record of what was filed (retention permanent).
REVOKE DELETE, TRUNCATE ON TABLE machvon.mne_export_package FROM machvon_app;

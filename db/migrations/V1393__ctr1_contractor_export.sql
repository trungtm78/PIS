-- Authored by hand (not generated): the export of the records of the contractors for the national database (ST-CTR-015, CTR 3.6, UAT-AC315, UAT-PLAN-18, CXN-EXE-01).
-- The table contractor_export_batch with its period that does not run backwards and its unique file (scope, period, hash) is in V002. This adds the version a command answers with, who wrote down the
-- manual submission and when, that a batch that was submitted has its receipt, that what a batch is never changes (the file is named by its hash) and moves only from generated to submitted, and that
-- a batch is never deleted.

ALTER TABLE machvon.contractor_export_batch
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  -- The contracts whose records are in the file: a batch is read only by someone whose scope, as it is today, covers every one of them.
  ADD COLUMN contract_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz;

ALTER TABLE machvon.contractor_export_batch
  ADD CONSTRAINT contractor_export_submitted_by_fk FOREIGN KEY (tenant_id, submitted_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT contractor_export_creator_fk FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  -- A batch that was submitted by hand has the receipt, the day, who wrote it down and when; one that was not has none of them.
  ADD CONSTRAINT contractor_export_submission_chk CHECK (
    (status IN ('SUBMITTED_EXTERNALLY', 'CONFIRMED')) = (submitted_ref IS NOT NULL)
    AND (submitted_ref IS NULL) = (submitted_on IS NULL)
    AND (submitted_ref IS NULL) = (submitted_by IS NULL)
    AND (submitted_ref IS NULL) = (submitted_at IS NULL)
  ),
  ADD CONSTRAINT contractor_export_receipt_chk CHECK (submitted_ref IS NULL OR (submitted_ref = btrim(submitted_ref) AND submitted_ref <> '' AND char_length(submitted_ref) <= 100));

CREATE INDEX contractor_export_listing_idx ON machvon.contractor_export_batch (tenant_id, created_at DESC, id);

CREATE FUNCTION machvon.guard_contractor_export_batch() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.scope, NEW.period_from, NEW.period_to, NEW.format, NEW.file_sha256, NEW.file_object_key, NEW.row_count, NEW.contract_ids, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.scope, OLD.period_from, OLD.period_to, OLD.format, OLD.file_sha256, OLD.file_object_key, OLD.row_count, OLD.contract_ids, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an export batch is never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.submitted_ref IS NOT NULL AND (NEW.submitted_ref, NEW.submitted_on, NEW.submitted_by, NEW.submitted_at) IS DISTINCT FROM (OLD.submitted_ref, OLD.submitted_on, OLD.submitted_by, OLD.submitted_at) THEN
    RAISE EXCEPTION 'the receipt of a submission does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'GENERATED' AND NEW.status = 'SUBMITTED_EXTERNALLY') THEN
    RAISE EXCEPTION 'this move of the status of an export batch is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contractor_export_batch_guard BEFORE UPDATE ON machvon.contractor_export_batch
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_export_batch();

REVOKE DELETE, TRUNCATE ON machvon.contractor_export_batch FROM machvon_app;

-- A file holds what the person who asked for it was allowed to read, and the same records give the same file whoever asks (the hash names the batch). So the batch is read by the people who asked for its file, once each,
-- and by whoever holds the permission over the whole tenant; this is the list of the first kind.
CREATE TABLE machvon.contractor_export_access (
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id, membership_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES machvon.contractor_export_batch (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX contractor_export_access_member_idx ON machvon.contractor_export_access (tenant_id, membership_id);

ALTER TABLE machvon.contractor_export_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_export_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_export_access AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_export_access AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The people who made a batch before this table existed are the ones who asked for it.
INSERT INTO machvon.contractor_export_access (tenant_id, batch_id, membership_id, granted_at)
SELECT tenant_id, id, created_by, created_at FROM machvon.contractor_export_batch;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contractor_export_access FROM machvon_app;

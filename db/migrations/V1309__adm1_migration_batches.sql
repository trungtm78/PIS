-- ST-ADM-020 (ADM.md 3.10, BR-ADM-01, BR-ADM-12, ADM-13): conversion files loaded in batches, a dry run that writes nothing, an apply by somebody other than who registered, and a rollback.
-- V002 gave migration_batch its columns and the unique (tenant, entity, sha256). What the lifecycle stands on is put into the database here, whatever the application checked first.

ALTER TABLE machvon.migration_batch
  ADD COLUMN rows_applied integer NOT NULL DEFAULT 0,
  ADD COLUMN failure_code text,
  ADD COLUMN rolled_back_by uuid,
  ADD COLUMN rolled_back_at timestamptz,
  ADD COLUMN rollback_reason text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE machvon.migration_batch
  ADD CONSTRAINT migration_batch_sha_chk CHECK (file_sha256 ~ '^[0-9a-f]{64}$') NOT VALID,
  ADD CONSTRAINT migration_batch_entity_chk CHECK (target_entity ~ '^[A-Z][A-Z0-9_]{1,49}$') NOT VALID,
  ADD CONSTRAINT migration_batch_applied_chk CHECK (status NOT IN ('Applying', 'Applied', 'RolledBack') OR approved_by IS NOT NULL) NOT VALID,
  ADD CONSTRAINT migration_batch_applied_at_chk CHECK ((status IN ('Applied', 'RolledBack')) = (applied_at IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT migration_batch_rollback_chk CHECK ((status = 'RolledBack') = (rolled_back_by IS NOT NULL AND rolled_back_at IS NOT NULL AND rollback_reason IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT migration_batch_totals_chk CHECK (status <> 'Applied' OR control_totals ? 'actual') NOT VALID;

-- The lifecycle (ADM.md 3.10): Uploaded -> Validating -> DryRunPassed | DryRunFailed; DryRunPassed -> Applying -> Applied | Failed; Applied -> RolledBack. A dry run can be asked again for a batch that failed it or failed
-- to apply. What the batch was registered with never changes.
CREATE FUNCTION machvon.guard_migration_batch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a migration batch is kept for good' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.target_entity IS DISTINCT FROM OLD.target_entity
     OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256 OR NEW.file_storage_key IS DISTINCT FROM OLD.file_storage_key OR NEW.mapping_version IS DISTINCT FROM OLD.mapping_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what a migration batch was registered with does not change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'Uploaded' AND NEW.status = 'Validating')
    OR (OLD.status IN ('DryRunFailed', 'Failed') AND NEW.status = 'Validating')
    OR (OLD.status = 'Validating' AND NEW.status IN ('DryRunPassed', 'DryRunFailed'))
    OR (OLD.status = 'DryRunPassed' AND NEW.status = 'Applying')
    OR (OLD.status = 'Applying' AND NEW.status IN ('Applied', 'Failed'))
    OR (OLD.status = 'Applied' AND NEW.status = 'RolledBack')) THEN
    RAISE EXCEPTION 'a migration batch does not go from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('Applied', 'RolledBack') AND (NEW.control_totals IS DISTINCT FROM OLD.control_totals OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.row_count IS DISTINCT FROM OLD.row_count) THEN
    RAISE EXCEPTION 'the figures of an applied migration batch do not change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER migration_batch_guard BEFORE UPDATE OR DELETE ON machvon.migration_batch
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_migration_batch();
CREATE TRIGGER migration_batch_no_truncate BEFORE TRUNCATE ON machvon.migration_batch
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_migration_batch();

-- What a dry run found, row by row: the errors that the screen lists and offers as a file.
CREATE TABLE machvon.migration_batch_error (
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  line_number integer NOT NULL CHECK (line_number > 0),
  field text NOT NULL,
  code text NOT NULL,
  message text NOT NULL,
  PRIMARY KEY (tenant_id, batch_id, row_number, field, code),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES machvon.migration_batch (tenant_id, id)
);
ALTER TABLE machvon.migration_batch_error ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.migration_batch_error FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.migration_batch_error AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.migration_batch_error AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- What an apply wrote (BR-ADM-12): one row for each business key of the source, so that running a batch again upserts and does not double. A rollback marks the rows of the batch INVALID, it does not delete them.
CREATE TABLE machvon.migration_row (
  tenant_id uuid NOT NULL,
  target_entity text NOT NULL CHECK (target_entity ~ '^[A-Z][A-Z0-9_]{1,49}$'),
  business_key text NOT NULL CHECK (char_length(business_key) BETWEEN 1 AND 200),
  payload jsonb NOT NULL,
  amount numeric(24, 0),
  refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  migrated_batch_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'VALID' CHECK (state IN ('VALID', 'INVALID')),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, target_entity, business_key),
  FOREIGN KEY (tenant_id, migrated_batch_id) REFERENCES machvon.migration_batch (tenant_id, id)
);
CREATE INDEX migration_row_batch_idx ON machvon.migration_row (tenant_id, migrated_batch_id);
ALTER TABLE machvon.migration_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.migration_row FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.migration_row AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.migration_row AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION machvon.guard_migration_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a migrated row is marked invalid, it is not deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.target_entity IS DISTINCT FROM OLD.target_entity OR NEW.business_key IS DISTINCT FROM OLD.business_key THEN
    RAISE EXCEPTION 'the key of a migrated row does not change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER migration_row_guard BEFORE UPDATE OR DELETE ON machvon.migration_row
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_migration_row();
CREATE TRIGGER migration_row_no_truncate BEFORE TRUNCATE ON machvon.migration_row
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_migration_row();

REVOKE DELETE, TRUNCATE ON TABLE machvon.migration_batch FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.migration_row FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.migration_batch_error FROM machvon_app;

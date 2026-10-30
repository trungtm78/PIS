-- Authored by hand (not generated), ST-MOB-009 (MOB 5 BR-MOB-03, MOB 6): the attachment a phone uploads in chunks. V002 gave the table the checksum, the size, the status and the key of the file; the upload also needs
-- who started it (the member, whose device it is), the type the phone declared, the size of the chunks, which chunks have arrived (so an interrupted upload goes on from where it stopped), and why a file was refused.
-- What an attachment is never changes; its status goes UPLOADING -> SCANNING -> CLEAN or INFECTED and no other way, and only a file that is CLEAN is linked to a record (the application checks it; the database keeps
-- the moves).
ALTER TABLE machvon.sync_attachment
  ADD COLUMN membership_id uuid,
  ADD COLUMN mime text,
  ADD COLUMN chunk_bytes integer,
  ADD COLUMN received integer[] NOT NULL DEFAULT '{}',
  -- The generation of the chunks: it goes up when they are dropped to be sent again, and a chunk is kept under the generation it was sent for, so cleaning up the old ones never touches a new one.
  ADD COLUMN epoch integer NOT NULL DEFAULT 0,
  ADD COLUMN reason text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT sync_attachment_chunk_bytes_chk CHECK (chunk_bytes IS NULL OR chunk_bytes > 0),
  ADD CONSTRAINT sync_attachment_reason_chk CHECK (reason IS NULL OR reason ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  ADD CONSTRAINT sync_attachment_key_prefix_chk CHECK (storage_key LIKE 'tenants/' || tenant_id::text || '/%'),
  ADD CONSTRAINT sync_attachment_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id);

CREATE INDEX sync_attachment_membership_id_idx ON machvon.sync_attachment (tenant_id, membership_id);

CREATE FUNCTION machvon.guard_sync_attachment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.device_id, NEW.membership_id, NEW.sha256, NEW.size_bytes, NEW.storage_key, NEW.mime, NEW.chunk_bytes, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.device_id, OLD.membership_id, OLD.sha256, OLD.size_bytes, OLD.storage_key, OLD.mime, OLD.chunk_bytes, OLD.created_at) THEN
    RAISE EXCEPTION 'what an attachment is is not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'UPLOADING' AND NEW.status = 'SCANNING')
    OR (OLD.status = 'SCANNING' AND NEW.status IN ('CLEAN', 'INFECTED'))) THEN
    RAISE EXCEPTION 'an attachment does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- Chunks arrive while the file is being uploaded, and only then.
  IF OLD.status <> 'UPLOADING' AND (NEW.received IS DISTINCT FROM OLD.received OR NEW.epoch IS DISTINCT FROM OLD.epoch) THEN
    RAISE EXCEPTION 'the chunks of a file that is no longer being uploaded are not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER sync_attachment_guard BEFORE UPDATE ON machvon.sync_attachment FOR EACH ROW EXECUTE FUNCTION machvon.guard_sync_attachment();

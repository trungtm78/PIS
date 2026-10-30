-- Authored by hand (not generated), ST-MOB-005 (MOB 6, 7): the receipt of a command that a phone queued offline (`POST /sync/batches`). V002 gave the table the key of the command and its final status; the lookup of an UNKNOWN
-- command (`GET /sync/commands/{key}`) and the answer to a key sent again also need who sent it, a hash of what was sent (the same key with another body is an IDEMPOTENCY_CONFLICT, never a second command), and what
-- the module answered (its code, and the version of the record, or for a conflict the version the server holds). A receipt is written once with the final answer and never changed (an accepted command is not "un-accepted");
-- it is kept 7 days, as the idempotency records of the offline queue (CR-04-37), and the idempotency purge removes it.
ALTER TABLE machvon.sync_command_receipt
  ADD COLUMN membership_id uuid,
  ADD COLUMN request_hash char(64),
  ADD COLUMN code text,
  ADD COLUMN server_version bigint,
  ADD CONSTRAINT sync_command_receipt_code_chk CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  ADD CONSTRAINT sync_command_receipt_hash_chk CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT sync_command_receipt_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id);

CREATE INDEX sync_command_receipt_lookup_idx ON machvon.sync_command_receipt (tenant_id, membership_id, idempotency_key);

CREATE FUNCTION machvon.guard_sync_command_receipt() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a sync command receipt is written once and not changed' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER sync_command_receipt_guard BEFORE UPDATE ON machvon.sync_command_receipt FOR EACH ROW EXECUTE FUNCTION machvon.guard_sync_command_receipt();

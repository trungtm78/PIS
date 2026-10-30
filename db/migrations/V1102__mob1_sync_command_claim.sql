-- Authored by hand (not generated), ST-MOB-005: the claim of a command key. A batch carries a command out through another request, which commits on its own; if the answer is lost (a timeout, a crash) there is no receipt yet,
-- and the key has to stay bound to what was sent with it, or a later batch could use the same key for another command and have both carried out (the idempotency of an operation is per operation). The claim is written in its own
-- transaction before the command is forwarded and says which command (by hash) the key stands for; it is written once and not changed, and kept 7 days with the receipts.
CREATE TABLE machvon.sync_command_claim (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  request_hash char(64) NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id, idempotency_key),
  FOREIGN KEY (tenant_id, device_id) REFERENCES machvon.device_registration (tenant_id, id),
  CONSTRAINT sync_command_claim_key_chk CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT sync_command_claim_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE machvon.sync_command_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.sync_command_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.sync_command_claim AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.sync_command_claim AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION machvon.guard_sync_command_claim() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a sync command claim is written once and not changed' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER sync_command_claim_guard BEFORE UPDATE ON machvon.sync_command_claim FOR EACH ROW EXECUTE FUNCTION machvon.guard_sync_command_claim();

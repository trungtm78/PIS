-- Authored by hand (not generated), FIXAE-1: the device registration no longer depends on push. The registration of the installation (`POST /devices`) is also what gives the phone the id that its offline command queue names as the device
-- (`sync_command_receipt.device_id`, the idempotency scope of the commands it sends), so a build without a push provider (a demo build, an emulator, a customer that switches push off) must be able to register with no token.
-- Three rules of the table change and nothing else: a live device may have no token (no reference in the vault and no fingerprint), the permission state may say `unavailable` (no push provider on this build or device), and the
-- reference of a token and its fingerprint go together. A revoked device still has no reference (IAM-1) and stays revoked (V1242, V1445); the push targets already read `push_secret_ref is not null`, so a device without a token is never
-- one of them. Existing rows keep their values: every live row has both, every revoked row has neither.
ALTER TABLE machvon.device_registration ALTER COLUMN token_fingerprint DROP NOT NULL;

ALTER TABLE machvon.device_registration DROP CONSTRAINT device_registration_permission_state_check;
ALTER TABLE machvon.device_registration ADD CONSTRAINT device_registration_permission_state_check CHECK (permission_state IN ('granted', 'denied', 'provisional', 'unknown', 'unavailable'));

ALTER TABLE machvon.device_registration DROP CONSTRAINT device_registration_push_chk;
ALTER TABLE machvon.device_registration ADD CONSTRAINT device_registration_push_chk CHECK ((revoked_at IS NULL OR push_secret_ref IS NULL) AND (push_secret_ref IS NULL OR token_fingerprint IS NOT NULL)) NOT VALID;

-- Authored by hand (not generated): a key that is being rotated keeps its alias for the day it goes on working (ST-LLM-002, LLM F5).
-- The baseline index let one alias be held by any key that was not revoked, so the new key of a rotation could not take the alias of the old one.
-- Now only the ACTIVE key holds an alias; the ROTATING one is the old key of the same alias for its last day.
-- A revoked key whose secret could not be removed from the vault at once is marked so, and the sweep tries again: `secret_removed_at` is null until the vault has let go of it.

DROP INDEX machvon.ai_virtual_key_alias_uq;
CREATE UNIQUE INDEX ai_virtual_key_alias_uq ON machvon.ai_virtual_key (tenant_id, key_alias) WHERE status = 'ACTIVE';

ALTER TABLE machvon.ai_virtual_key ADD COLUMN secret_removed_at timestamptz;

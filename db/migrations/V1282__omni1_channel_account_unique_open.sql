-- Authored by hand (not generated), ST-OMNI-001: a Disabled channel account is final (V1280), and the screen tells the supervisor to connect a new account to use the channel again. The unique index of the account at its
-- provider (tenant, channel, external id) also counted the Disabled rows, so the same provider account could never be connected again after it was closed. The identity is unique among the accounts that are not closed.
DROP INDEX machvon.channel_account_external_uq;
CREATE UNIQUE INDEX channel_account_external_uq ON machvon.channel_account (tenant_id, channel, external_account_id) WHERE status <> 'Disabled';

-- The provider event id of a treasury transaction is looked up by the callback and the reconciliation (ST-PAY-006); the catalogue wants every *_id column of a
-- tenant table to lead an index after tenant_id.
CREATE INDEX IF NOT EXISTS treasury_transaction_provider_event_id_idx ON machvon.treasury_transaction (tenant_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

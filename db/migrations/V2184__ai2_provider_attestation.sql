-- Authored by hand (not generated): where a provider keeps the data it is sent and whether it trains on it, as registry fields (lane AI-2, eng-review R5, requirement AI.07 and HT.01).
-- The registry of providers (`ai_provider`) already says the country of the region, the route and the data agreement; it did not say where the data rests or whether the provider trains models on what it receives.
-- These fields do, and they carry who attested them and when and under which paper:
--   * `data_location_country` is the country where the data is processed and stored (it can differ from the region of the endpoint) and `data_location_detail` names the site or the cloud region;
--   * `no_training_attested` is true only with a reference of the paper that says so (`attestation_ref`, and the document when it is in the store), the person and the moment; the database refuses a true flag without them;
--   * the attestation is a fact a person stakes their name on, so it is set by a command with a version (`attestAiProvider`) and every change is in the audit trail; whether an edition requires it before a provider can be
--     activated or used outside the customer servers is the policy of the edition (the kernel module `ai-edition-policy`), not a column.

ALTER TABLE machvon.ai_provider
  ADD COLUMN data_location_country char(2),
  ADD COLUMN data_location_detail text,
  ADD COLUMN no_training_attested boolean NOT NULL DEFAULT false,
  ADD COLUMN attestation_ref text,
  ADD COLUMN attestation_document_id uuid,
  ADD COLUMN attested_by uuid,
  ADD COLUMN attested_at timestamptz;

ALTER TABLE machvon.ai_provider ADD CONSTRAINT ai_provider_location_chk CHECK (data_location_country IS NULL OR data_location_country ~ '^[A-Z]{2}$');
ALTER TABLE machvon.ai_provider ADD CONSTRAINT ai_provider_location_detail_chk CHECK (data_location_detail IS NULL OR (data_location_detail = btrim(data_location_detail) AND char_length(data_location_detail) BETWEEN 2 AND 300));
ALTER TABLE machvon.ai_provider ADD CONSTRAINT ai_provider_attestation_ref_chk CHECK (attestation_ref IS NULL OR (attestation_ref = btrim(attestation_ref) AND char_length(attestation_ref) BETWEEN 3 AND 300));
ALTER TABLE machvon.ai_provider ADD CONSTRAINT ai_provider_attested_chk CHECK ((attested_by IS NULL) = (attested_at IS NULL));
ALTER TABLE machvon.ai_provider ADD CONSTRAINT ai_provider_no_training_chk CHECK (NOT no_training_attested OR (data_location_country IS NOT NULL AND attestation_ref IS NOT NULL AND attested_by IS NOT NULL));

CREATE INDEX ai_provider_attestation_document_idx ON machvon.ai_provider (tenant_id, attestation_document_id) WHERE attestation_document_id IS NOT NULL;

COMMENT ON COLUMN machvon.ai_provider.data_location_country IS 'AI-2 (R5): the country where the provider processes and stores the data it is sent; attested by a person.';
COMMENT ON COLUMN machvon.ai_provider.no_training_attested IS 'AI-2 (R5): the provider attests it does not train models on what it receives; true only with a reference, a person and a time.';

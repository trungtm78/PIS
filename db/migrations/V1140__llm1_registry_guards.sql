-- Authored by hand (not generated): the guards under the provider, model and policy registry of the AI gateway (ST-LLM-001, LLM F2, BR-LLM-01).
-- A model without a version was not unique: NULLs are distinct for a unique index, so the same model could be registered twice.
-- A policy that is PUBLISHED may never be wider than the baseline matrix, whatever wrote it: confidential, important and personal data have no route to an international model.

CREATE UNIQUE INDEX ai_model_unversioned_uq ON machvon.ai_model (tenant_id, provider_id, model_id) WHERE model_version IS NULL;

ALTER TABLE machvon.ai_classification_policy_version ADD CONSTRAINT ai_classification_policy_version_baseline_chk CHECK (
  status <> 'PUBLISHED' OR coalesce(
    jsonb_typeof(matrix_json -> 'PUBLIC') = 'array' AND matrix_json -> 'PUBLIC' <@ '["DOMESTIC_HOSTED","SELF_HOSTED","INTERNATIONAL"]'::jsonb
    AND jsonb_typeof(matrix_json -> 'INTERNAL') = 'array' AND matrix_json -> 'INTERNAL' <@ '["DOMESTIC_HOSTED","SELF_HOSTED"]'::jsonb
    AND jsonb_typeof(matrix_json -> 'CONFIDENTIAL') = 'array' AND matrix_json -> 'CONFIDENTIAL' <@ '["DOMESTIC_HOSTED","SELF_HOSTED"]'::jsonb
    AND jsonb_typeof(matrix_json -> 'PERSONAL') = 'array' AND matrix_json -> 'PERSONAL' <@ '["DOMESTIC_HOSTED","SELF_HOSTED"]'::jsonb
    AND matrix_json -> 'IMPORTANT_CORE' = '["SELF_HOSTED"]'::jsonb
    AND (international_enabled OR NOT jsonb_exists(matrix_json -> 'PUBLIC', 'INTERNATIONAL')),
    false
  )
);

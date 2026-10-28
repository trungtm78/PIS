-- Authored by hand (not generated): the guards under prompts, evaluations, profiles and the approval of models (ST-LLM-004, LLM F4, BR-LLM-08).
-- A prompt that was approved is the one that was evaluated and signed: its template, its schemas and its place do not change (the database says it as well as the service).
-- A model is approved by someone other than the person who registered it. An evaluation is signed by someone other than the person who started it. One profile of a task is PUBLISHED at a time.

CREATE OR REPLACE FUNCTION machvon.ai_prompt_version_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status <> 'DRAFT' AND (NEW.template_object_key <> OLD.template_object_key OR NEW.template_sha256 <> OLD.template_sha256 OR NEW.input_schema <> OLD.input_schema
     OR NEW.output_schema <> OLD.output_schema OR NEW.task_type <> OLD.task_type OR NEW.name <> OLD.name OR NEW.revision <> OLD.revision) THEN
    RAISE EXCEPTION 'a prompt version that was approved is not edited: a new revision is made' USING ERRCODE = '23514', CONSTRAINT = 'ai_prompt_version_immutable_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ai_prompt_version_guard BEFORE UPDATE ON machvon.ai_prompt_version FOR EACH ROW EXECUTE FUNCTION machvon.ai_prompt_version_guard();

ALTER TABLE machvon.ai_model ADD COLUMN approved_by uuid;
ALTER TABLE machvon.ai_model ADD CONSTRAINT ai_model_sod_chk CHECK (approved_by IS NULL OR approved_by <> created_by);

ALTER TABLE machvon.ai_eval_run ADD COLUMN started_by uuid;
ALTER TABLE machvon.ai_eval_run ADD CONSTRAINT ai_eval_run_sod_chk CHECK (signed_by IS NULL OR started_by IS NULL OR signed_by <> started_by);

CREATE UNIQUE INDEX model_profile_version_published_uq ON machvon.model_profile_version (tenant_id, task_type) WHERE status = 'PUBLISHED';
CREATE UNIQUE INDEX ai_eval_run_route_uq ON machvon.ai_eval_run (tenant_id, profile_version_id, dataset_version_id, route_class) WHERE review_status <> 'SUPERSEDED';

-- An evaluation is signed against the version it was read at, like every record that is changed by a decision.
ALTER TABLE machvon.ai_eval_run ADD COLUMN version bigint NOT NULL DEFAULT 1;

-- A profile is published, returned or superseded against the version it was read at.
ALTER TABLE machvon.model_profile_version ADD COLUMN version bigint NOT NULL DEFAULT 1;

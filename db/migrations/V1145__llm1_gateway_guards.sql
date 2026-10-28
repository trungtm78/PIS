-- Authored by hand (not generated): the guards under the request path of the AI gateway (ST-LLM-005, LLM F1, BR-LLM-01, BR-LLM-02).
-- A request is recorded with the class it was given and the sources that gave it; neither changes afterwards, and no attempt of a request that is not public goes to the international route (the database says it as well as the service).
-- A request made when no policy has been published is judged by the baseline and has no policy version to name.

ALTER TABLE machvon.ai_request ALTER COLUMN policy_version_id DROP NOT NULL;

-- An answer that was paid for and then not used because it cited nothing says so on its attempt.
ALTER TABLE machvon.llm_attempt DROP CONSTRAINT llm_attempt_outcome_check;
ALTER TABLE machvon.llm_attempt ADD CONSTRAINT llm_attempt_outcome_chk CHECK (outcome IN ('SUCCESS','TIMEOUT','REFUSAL','INVALID_JSON','NO_CITATION','PROVIDER_ERROR','CANCELLED','USAGE_MISSING'));

CREATE OR REPLACE FUNCTION machvon.ai_request_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.data_classification <> OLD.data_classification OR NEW.classification_basis <> OLD.classification_basis OR NEW.input_sha256 <> OLD.input_sha256 OR NEW.task_type <> OLD.task_type
     OR NEW.profile_version_id <> OLD.profile_version_id OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'the class, the sources and the input of an AI request do not change after it was admitted' USING ERRCODE = '23514', CONSTRAINT = 'ai_request_immutable_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ai_request_guard BEFORE UPDATE ON machvon.ai_request FOR EACH ROW EXECUTE FUNCTION machvon.ai_request_guard();

CREATE OR REPLACE FUNCTION machvon.llm_attempt_route_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  class text;
BEGIN
  IF NEW.route_class = 'INTERNATIONAL' AND NEW.ai_request_id IS NOT NULL THEN
    SELECT data_classification INTO class FROM machvon.ai_request WHERE id = NEW.ai_request_id;
    IF class IS DISTINCT FROM 'PUBLIC' THEN
      RAISE EXCEPTION 'only public data goes over the international route' USING ERRCODE = '23514', CONSTRAINT = 'llm_attempt_intl_chk';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER llm_attempt_route_guard BEFORE INSERT ON machvon.llm_attempt FOR EACH ROW EXECUTE FUNCTION machvon.llm_attempt_route_guard();

CREATE INDEX IF NOT EXISTS ai_request_created_idx ON machvon.ai_request (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS llm_attempt_created_idx ON machvon.llm_attempt (tenant_id, created_at DESC, id DESC);

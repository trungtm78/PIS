-- Authored by hand (not generated): the runs of the AI assistant (lane AI-2, requirements AI.01, AI.02, AI.04, AI.05, AI.07; LLM F9, screens LLM-22 to LLM-27).
-- A run is one question answered, one summary, one explanatory note drafted, one feasibility analysis, one review of a file against a checklist or one proposal of a contract evaluation. It goes through the AI gateway
-- (`ai_request`: the class, the route, the budget and the attempts are the gateway's); this table keeps what the assistant made of the answer: the statements, each labelled SOURCE, ASSUMPTION or INFERENCE and each
-- carrying the citations that the server verified against the records the asker may read. What is kept is the answer as verified, never the raw answer of the model: a citation that does not exist or that the asker
-- cannot read is not kept, only counted.
--   * a run is a record of what the assistant proposed and never changes (an update or a delete is refused for every role); it is advisory by construction (`advisory` can only be true);
--   * the human decision about a run is another row (`ai_assist_decision`, V2181): the assistant decides nothing, and nothing outside these tables reads a run.

CREATE TABLE machvon.ai_assist_run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  subject_module text,
  subject_id uuid,
  checklist_id uuid,
  criteria_set_id uuid,
  request_text text NOT NULL,
  source_refs jsonb NOT NULL,
  status text NOT NULL,
  refusal_code text,
  ai_request_id uuid,
  data_classification text,
  route_class text,
  output_sha256 char(64),
  statements jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  statement_count integer NOT NULL DEFAULT 0,
  verified_count integer NOT NULL DEFAULT 0,
  unsupported_count integer NOT NULL DEFAULT 0,
  withheld_citation_count integer NOT NULL DEFAULT 0,
  injection_signal_count integer NOT NULL DEFAULT 0,
  completeness text NOT NULL DEFAULT 'NONE',
  advisory boolean NOT NULL DEFAULT true,
  asked_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ai_request_id) REFERENCES machvon.ai_request (tenant_id, id),
  CONSTRAINT ai_assist_run_kind_chk CHECK (kind IN ('QA', 'SUMMARY', 'DRAFT_NOTE', 'FEASIBILITY', 'DOC_REVIEW', 'CONTRACT_EVAL')),
  CONSTRAINT ai_assist_run_status_chk CHECK (status IN ('COMPLETED', 'REFUSED', 'FAILED')),
  CONSTRAINT ai_assist_run_text_chk CHECK (request_text = btrim(request_text) AND char_length(request_text) <= 4000),
  CONSTRAINT ai_assist_run_sources_chk CHECK (jsonb_typeof(source_refs) = 'array' AND jsonb_array_length(source_refs) BETWEEN 1 AND 20),
  CONSTRAINT ai_assist_run_statements_chk CHECK (jsonb_typeof(statements) = 'array' AND jsonb_typeof(result) = 'object'),
  CONSTRAINT ai_assist_run_class_chk CHECK (data_classification IS NULL OR data_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE')),
  CONSTRAINT ai_assist_run_route_chk CHECK (route_class IS NULL OR route_class IN ('DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL')),
  CONSTRAINT ai_assist_run_completeness_chk CHECK (completeness IN ('FULL', 'PARTIAL', 'NONE')),
  CONSTRAINT ai_assist_run_counts_chk CHECK (statement_count >= 0 AND verified_count BETWEEN 0 AND statement_count AND unsupported_count BETWEEN 0 AND statement_count AND withheld_citation_count >= 0 AND injection_signal_count >= 0),
  CONSTRAINT ai_assist_run_refusal_chk CHECK ((status = 'COMPLETED') = (refusal_code IS NULL)),
  CONSTRAINT ai_assist_run_advisory_chk CHECK (advisory),
  CONSTRAINT ai_assist_run_hash_chk CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_assist_run_kind_input_chk CHECK ((kind = 'DOC_REVIEW') = (checklist_id IS NOT NULL) AND (kind = 'CONTRACT_EVAL') = (criteria_set_id IS NOT NULL))
);

CREATE INDEX ai_assist_run_asker_idx ON machvon.ai_assist_run (tenant_id, asked_by, created_at DESC, id DESC);
CREATE INDEX ai_assist_run_request_idx ON machvon.ai_assist_run (tenant_id, ai_request_id);
CREATE INDEX ai_assist_run_subject_idx ON machvon.ai_assist_run (tenant_id, subject_id);
CREATE INDEX ai_assist_run_checklist_idx ON machvon.ai_assist_run (tenant_id, checklist_id);
CREATE INDEX ai_assist_run_criteria_idx ON machvon.ai_assist_run (tenant_id, criteria_set_id);

CREATE FUNCTION machvon.ai_assist_run_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a run of the assistant is a record of what it proposed and is not changed or deleted' USING ERRCODE = '23514', CONSTRAINT = 'ai_assist_run_immutable';
END;
$fn$;

CREATE TRIGGER ai_assist_run_immutable BEFORE UPDATE OR DELETE ON machvon.ai_assist_run FOR EACH ROW EXECUTE FUNCTION machvon.ai_assist_run_immutable();

ALTER TABLE machvon.ai_assist_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_assist_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_assist_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_assist_run AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.ai_assist_run FROM machvon_app;

COMMENT ON TABLE machvon.ai_assist_run IS 'AI-2: one run of the AI assistant with its verified statements (SOURCE, ASSUMPTION, INFERENCE) and the citations the asker could read; advisory, immutable.';

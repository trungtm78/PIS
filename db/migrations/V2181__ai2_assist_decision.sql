-- Authored by hand (not generated): what a person decided about a run of the AI assistant (lane AI-2, AI.04 "a human accepts", LLM F8 and OWASP LLM06).
-- The assistant proposes; a person with the right to decide accepts, accepts with a change or rejects, once per run, with a rationale. For the evaluation of a contract the decision carries the scores the person accepted
-- (`accepted_result`), and the total is computed from those, never from the proposal. The decision is also written to the record of human decisions of the gateway (`ai_decision_record`, the row it points at), which is
-- what ties the answer of the AI to the person that answered for it. Nothing here moves a payment, an approval or a score of another module: the row is read by people.
--   * one decision per run (a unique constraint), append-only for every role (a trigger and no UPDATE, DELETE or TRUNCATE for the application role).

CREATE TABLE machvon.ai_assist_decision (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  decision text NOT NULL,
  rationale text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  accepted_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_decision_record_id uuid NOT NULL,
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES machvon.ai_assist_run (tenant_id, id),
  FOREIGN KEY (tenant_id, ai_decision_record_id) REFERENCES machvon.ai_decision_record (tenant_id, id),
  CONSTRAINT ai_assist_decision_value_chk CHECK (decision IN ('ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED')),
  CONSTRAINT ai_assist_decision_rationale_chk CHECK (rationale = btrim(rationale) AND char_length(rationale) BETWEEN 20 AND 2000),
  CONSTRAINT ai_assist_decision_shape_chk CHECK (jsonb_typeof(items) = 'array' AND jsonb_typeof(accepted_result) = 'object'),
  CONSTRAINT ai_assist_decision_run_uq UNIQUE (tenant_id, run_id)
);

CREATE INDEX ai_assist_decision_record_idx ON machvon.ai_assist_decision (tenant_id, ai_decision_record_id);
CREATE INDEX ai_assist_decision_person_idx ON machvon.ai_assist_decision (tenant_id, decided_by, decided_at DESC);

CREATE FUNCTION machvon.ai_assist_decision_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the decision about a run of the assistant is append-only' USING ERRCODE = '23514', CONSTRAINT = 'ai_assist_decision_append_only';
END;
$fn$;

CREATE TRIGGER ai_assist_decision_append_only BEFORE UPDATE OR DELETE ON machvon.ai_assist_decision FOR EACH ROW EXECUTE FUNCTION machvon.ai_assist_decision_append_only();

ALTER TABLE machvon.ai_assist_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_assist_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_assist_decision AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_assist_decision AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.ai_assist_decision FROM machvon_app;

COMMENT ON TABLE machvon.ai_assist_decision IS 'AI-2: the human decision about a run of the AI assistant (accepted scores of a contract evaluation included); one per run; append-only.';

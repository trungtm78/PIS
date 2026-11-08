-- Authored by hand (not generated): the proposal of a rating of the performance of a contractor on a contract (CA-3, plan "Dot 3 item 2", vendor research V4, docs/ctr-analytics-registers.md).
-- The score is PROPOSED from the data the system holds, by the rule CONTRACT_PERFORMANCE_RATING (the version and the source of the rule are kept, and the digest of the inputs, so the figures can be explained later). The
-- proposal is then told to the contractor by a second person, who has a window to answer (the response day is fixed when the contractor is told, from the e-GP rule CONTRACTOR_RESPONSE), and a person other than the
-- proposer adopts it into the evaluation of CTR-23 (`contractor_performance`), which keeps its own approval by a second person.
--   * a criterion with no data has a NULL score and a reason in `reasons`: never zero; the overall score is NULL when fewer criteria than the rule asks have data (and then the rating is NULL too);
--   * the proposer does not notify and does not adopt (CHECKs); the contractor is told once;
--   * an adoption may fill a criterion that has no data with a score and a reason (`overrides`), never replace a score the data gave (the command judges it);
--   * one live proposal for a contract, a kind of evaluation and a period; a withdrawn one stays as it was; no row is ever deleted by the application role.

CREATE TABLE machvon.contract_rating_proposal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  evaluation_kind text NOT NULL,
  period_label text NOT NULL,
  as_of_date date NOT NULL,
  rule_version integer NOT NULL,
  rule_source text NOT NULL,
  score_quality smallint,
  score_schedule smallint,
  score_safety_env smallint,
  score_cooperation smallint,
  score_financial smallint,
  reasons jsonb NOT NULL,
  readings jsonb NOT NULL,
  covered smallint NOT NULL,
  overall_score numeric(5, 2),
  rating text,
  inputs_sha256 char(64) NOT NULL,
  state text NOT NULL DEFAULT 'PROPOSED',
  proposed_by uuid NOT NULL,
  proposed_note text,
  notified_by uuid,
  notified_at timestamptz,
  notify_note text,
  letter_document_version_id uuid,
  response_due_at timestamptz,
  responded_by uuid,
  responded_at timestamptz,
  response_kind text,
  response_text text,
  response_received_on date,
  response_evidence_document_version_id uuid,
  adopted_by uuid,
  adopted_at timestamptz,
  adopt_note text,
  overrides jsonb,
  evaluation_id uuid,
  withdrawn_by uuid,
  withdrawn_at timestamptz,
  withdraw_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES machvon.contractor_performance (tenant_id, id),
  CONSTRAINT contract_rating_kind_chk CHECK (evaluation_kind IN ('PERIODIC', 'COMPLETION', 'TERMINATION')),
  CONSTRAINT contract_rating_period_chk CHECK (period_label = btrim(period_label) AND period_label <> '' AND char_length(period_label) <= 40),
  CONSTRAINT contract_rating_rule_chk CHECK (rule_version >= 0 AND rule_source IN ('RULE', 'DEFAULT')),
  CONSTRAINT contract_rating_scores_chk CHECK (
    (score_quality IS NULL OR score_quality BETWEEN 0 AND 100) AND (score_schedule IS NULL OR score_schedule BETWEEN 0 AND 100) AND (score_safety_env IS NULL OR score_safety_env BETWEEN 0 AND 100)
    AND (score_cooperation IS NULL OR score_cooperation BETWEEN 0 AND 100) AND (score_financial IS NULL OR score_financial BETWEEN 0 AND 100)
  ),
  CONSTRAINT contract_rating_covered_chk CHECK (covered BETWEEN 0 AND 5),
  CONSTRAINT contract_rating_overall_chk CHECK ((overall_score IS NULL) = (rating IS NULL) AND (overall_score IS NULL OR overall_score BETWEEN 0 AND 100) AND (rating IS NULL OR rating IN ('EXCELLENT', 'GOOD', 'FAIR', 'POOR'))),
  CONSTRAINT contract_rating_json_chk CHECK (jsonb_typeof(reasons) = 'object' AND jsonb_typeof(readings) = 'object' AND (overrides IS NULL OR jsonb_typeof(overrides) = 'object')),
  CONSTRAINT contract_rating_digest_chk CHECK (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contract_rating_state_chk CHECK (state IN ('PROPOSED', 'NOTIFIED', 'RESPONDED', 'ADOPTED', 'WITHDRAWN')),
  CONSTRAINT contract_rating_text_chk CHECK (
    (proposed_note IS NULL OR (proposed_note = btrim(proposed_note) AND char_length(proposed_note) BETWEEN 1 AND 2000)) AND (notify_note IS NULL OR (notify_note = btrim(notify_note) AND char_length(notify_note) BETWEEN 1 AND 2000))
    AND (adopt_note IS NULL OR (adopt_note = btrim(adopt_note) AND char_length(adopt_note) BETWEEN 1 AND 2000)) AND (response_text IS NULL OR (response_text = btrim(response_text) AND char_length(response_text) BETWEEN 1 AND 4000))
  ),
  CONSTRAINT contract_rating_notified_chk CHECK ((notified_by IS NULL) = (notified_at IS NULL) AND (notified_at IS NULL) = (response_due_at IS NULL) AND (response_due_at IS NULL OR response_due_at >= notified_at)),
  CONSTRAINT contract_rating_notified_state_chk CHECK ((state IN ('NOTIFIED', 'RESPONDED')) <= (notified_at IS NOT NULL) AND (state <> 'PROPOSED' OR notified_at IS NULL)),
  CONSTRAINT contract_rating_responded_chk CHECK (
    (responded_at IS NULL) = (response_kind IS NULL) AND (responded_at IS NULL) = (responded_by IS NULL) AND (responded_at IS NULL) = (response_received_on IS NULL)
    AND (response_kind IS NULL OR response_kind IN ('ACCEPT', 'DISPUTE', 'NO_COMMENT')) AND (state <> 'RESPONDED' OR responded_at IS NOT NULL)
    AND (response_kind IS DISTINCT FROM 'DISPUTE' OR (response_text IS NOT NULL AND char_length(response_text) >= 20))
  ),
  CONSTRAINT contract_rating_adopted_chk CHECK ((state = 'ADOPTED') = (adopted_by IS NOT NULL AND adopted_at IS NOT NULL AND evaluation_id IS NOT NULL) AND (state <> 'ADOPTED' OR notified_at IS NOT NULL)),
  CONSTRAINT contract_rating_withdrawn_chk CHECK ((state = 'WITHDRAWN') = (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND withdraw_reason IS NOT NULL) AND (withdraw_reason IS NULL OR char_length(btrim(withdraw_reason)) >= 10)),
  CONSTRAINT contract_rating_maker_checker_chk CHECK ((notified_by IS NULL OR notified_by <> proposed_by) AND (adopted_by IS NULL OR adopted_by <> proposed_by)),
  CONSTRAINT contract_rating_version_chk CHECK (version >= 1)
);

CREATE UNIQUE INDEX contract_rating_live_uq ON machvon.contract_rating_proposal (tenant_id, contract_id, evaluation_kind, period_label) WHERE state <> 'WITHDRAWN';
CREATE INDEX contract_rating_contract_id_idx ON machvon.contract_rating_proposal (tenant_id, contract_id, created_at DESC, id DESC);
CREATE INDEX contract_rating_contractor_id_idx ON machvon.contract_rating_proposal (tenant_id, contractor_id, state);
CREATE INDEX contract_rating_state_idx ON machvon.contract_rating_proposal (tenant_id, state, response_due_at, id);
CREATE INDEX contract_rating_evaluation_id_idx ON machvon.contract_rating_proposal (tenant_id, evaluation_id) WHERE evaluation_id IS NOT NULL;
CREATE INDEX contract_rating_letter_id_idx ON machvon.contract_rating_proposal (tenant_id, letter_document_version_id) WHERE letter_document_version_id IS NOT NULL;
CREATE INDEX contract_rating_evidence_id_idx ON machvon.contract_rating_proposal (tenant_id, response_evidence_document_version_id) WHERE response_evidence_document_version_id IS NOT NULL;

-- What a proposal is never changes: the contract, the contractor, the kind, the period, the day and the figures (a new reading is a new proposal), the rule it was judged by and who proposed it. What moves is the life of it.
CREATE FUNCTION machvon.guard_contract_rating_proposal() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.contract_id, NEW.contractor_id, NEW.evaluation_kind, NEW.period_label, NEW.as_of_date, NEW.rule_version, NEW.rule_source, NEW.score_quality, NEW.score_schedule, NEW.score_safety_env, NEW.score_cooperation, NEW.score_financial,
      NEW.reasons, NEW.readings, NEW.covered, NEW.overall_score, NEW.rating, NEW.inputs_sha256, NEW.proposed_by, NEW.created_by)
     IS DISTINCT FROM
     (OLD.contract_id, OLD.contractor_id, OLD.evaluation_kind, OLD.period_label, OLD.as_of_date, OLD.rule_version, OLD.rule_source, OLD.score_quality, OLD.score_schedule, OLD.score_safety_env, OLD.score_cooperation, OLD.score_financial,
      OLD.reasons, OLD.readings, OLD.covered, OLD.overall_score, OLD.rating, OLD.inputs_sha256, OLD.proposed_by, OLD.created_by) THEN
    RAISE EXCEPTION 'a rating proposal keeps its contract, its figures and its rule: a new reading is a new proposal' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('ADOPTED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'an adopted or withdrawn rating proposal is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND (OLD.state, NEW.state) NOT IN (('PROPOSED', 'NOTIFIED'), ('PROPOSED', 'WITHDRAWN'), ('NOTIFIED', 'RESPONDED'), ('NOTIFIED', 'ADOPTED'), ('RESPONDED', 'ADOPTED')) THEN
    RAISE EXCEPTION 'a rating proposal does not move from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  IF OLD.notified_at IS NOT NULL AND (NEW.notified_at IS DISTINCT FROM OLD.notified_at OR NEW.notified_by IS DISTINCT FROM OLD.notified_by OR NEW.response_due_at IS DISTINCT FROM OLD.response_due_at) THEN
    RAISE EXCEPTION 'the contractor is told once: the day it was told and its response day never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.responded_at IS NOT NULL AND NEW.responded_at IS DISTINCT FROM OLD.responded_at THEN
    RAISE EXCEPTION 'the answer of the contractor is recorded once' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a change of a rating proposal raises its version by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_rating_proposal_guard BEFORE UPDATE ON machvon.contract_rating_proposal FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_rating_proposal();

ALTER TABLE machvon.contract_rating_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_rating_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_rating_proposal AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_rating_proposal AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_rating_proposal FROM machvon_app;

COMMENT ON TABLE machvon.contract_rating_proposal IS 'A proposed rating of a contractor on a contract (CA-3): scores from data by the rule CONTRACT_PERFORMANCE_RATING, told to the contractor, answered inside the window, adopted into the evaluation of CTR-23.';

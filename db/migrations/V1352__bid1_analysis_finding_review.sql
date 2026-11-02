-- Authored by hand (not generated): the review of the findings of an analysis by an expert (ST-BID-010, BID 3 F6, BR-BID-03/09). The table analysis_finding_review comes from the generated schema (V002) with its columns, its
-- foreign keys and its indexes; this adds what makes it the record of a human decision: the checks that tie a decision to what it says, the citations the expert checked, the guard that makes a decision nobody rewrites
-- or deletes and that is written only for a run that waits for the experts, and the end of the review columns of the finding itself (what the model said about a criterion is never changed, a decision is a row of its own).

ALTER TABLE machvon.analysis_finding_review
  ADD COLUMN decision text,
  ADD COLUMN checked_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE machvon.analysis_finding_review
  ADD CONSTRAINT analysis_finding_review_from_chk CHECK (from_status IN ('SUPPORTED', 'CONTRADICTED', 'MISSING', 'NEEDS_REVIEW')),
  ADD CONSTRAINT analysis_finding_review_decision_chk CHECK (decision IS NOT NULL AND decision IN ('ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED')),
  ADD CONSTRAINT analysis_finding_review_score_chk CHECK ((score_before IS NULL OR score_before >= 0) AND (score_after IS NULL OR score_after >= 0)),
  ADD CONSTRAINT analysis_finding_review_checked_chk CHECK (jsonb_typeof(checked_evidence_ids) = 'array' AND jsonb_array_length(checked_evidence_ids) <= 20),
  -- BR-BID-09: every decision of an expert about a finding is also the decision of a person about an answer of the AI.
  ADD CONSTRAINT analysis_finding_review_record_chk CHECK (ai_decision_record_id IS NOT NULL),
  ADD CONSTRAINT analysis_finding_review_reason_len_chk CHECK (char_length(reason) <= 4000);

-- The history of a finding, newest last, and the latest decision of each finding.
CREATE INDEX analysis_finding_review_history_idx ON machvon.analysis_finding_review (tenant_id, finding_id, decided_at, id);

-- A decision is written for a finding of a run that waits for the experts or has them all decided, once, and is kept for good. The owner of the schema (the migrations and the maintenance of the platform) is not held.
CREATE FUNCTION machvon.guard_analysis_finding_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the decision of an expert is kept as it was made' USING ERRCODE = '42501';
  END IF;
  SELECT r.status INTO run_status
    FROM machvon.analysis_finding f JOIN machvon.analysis_run r ON r.tenant_id = f.tenant_id AND r.id = f.run_id
   WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.finding_id;
  IF run_status IS NULL OR run_status NOT IN ('AWAITING_REVIEW', 'COMPLETED') THEN
    RAISE EXCEPTION 'a finding is decided when its run waits for the experts' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER analysis_finding_review_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.analysis_finding_review
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_analysis_finding_review();
CREATE TRIGGER analysis_finding_review_no_truncate BEFORE TRUNCATE ON machvon.analysis_finding_review
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_analysis_finding_review();

REVOKE DELETE, TRUNCATE ON TABLE machvon.analysis_finding_review FROM machvon_app;

-- What the model said about a criterion is not changed by anyone, and neither are the columns of the review that V1350 let an expert write on it: the decision of an expert is a row of analysis_finding_review.
CREATE OR REPLACE FUNCTION machvon.guard_analysis_finding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT r.status INTO run_status FROM machvon.analysis_run r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id;
    IF run_status IS DISTINCT FROM 'RUNNING' OR NEW.final_status IS NOT NULL OR NEW.reviewer_id IS NOT NULL OR NEW.override_reason IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a finding is written while its run runs, before any review' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a finding is kept as the model said it; an expert decides in a record of its own' USING ERRCODE = '42501';
END $$;

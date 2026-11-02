-- Authored by hand (not generated): the AI analysis of a proposal (ST-BID-009, BID 3 F5, BR-BID-05/07). The tables analysis_run, analysis_finding and analysis_evidence come from the generated schema (V002) with
-- the columns, the foreign keys and the indexes of the design; this adds what a run relies on to be immutable: the statuses, the checks that tie a status to what it needs, the unique input of a live run,
-- the guards that make a run, its findings and its evidence facts nobody rewrites, and the count of verified citations that a supported finding stands on (BR-BID-07). The expand step: V1351 makes the columns required.

-- ---- the run -------------------------------------------------------------------------------------------------------------------------------

-- A run refused before any hold was made has no reservation. The columns the design names as part of every run are made required by the contract step that follows (V1351).
ALTER TABLE machvon.analysis_run
  ALTER COLUMN budget_reservation_id DROP NOT NULL,
  ALTER COLUMN started_at SET DEFAULT now(),
  ADD COLUMN failure_code text,
  ADD COLUMN failed_step text,
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

ALTER TABLE machvon.analysis_run
  ADD CONSTRAINT analysis_run_status_chk CHECK (status IN ('QUEUED', 'RUNNING', 'AWAITING_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED_BY_POLICY')),
  ADD CONSTRAINT analysis_run_hash_chk CHECK (input_hash ~ '^[0-9a-f]{64}$' AND document_version_set_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT analysis_run_finished_chk CHECK ((status IN ('QUEUED', 'RUNNING')) = (finished_at IS NULL)),
  ADD CONSTRAINT analysis_run_failure_chk CHECK (
    (status IN ('FAILED', 'REJECTED_BY_POLICY')) = (failure_code IS NOT NULL) AND (failure_code IS NULL) = (failed_step IS NULL)
    AND (failed_step IS NULL OR failed_step IN ('EXTRACT', 'MATCH', 'VERIFY'))
  ),
  ADD CONSTRAINT analysis_run_cancel_chk CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL) AND (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 3 AND 1000)),
  ADD CONSTRAINT analysis_run_answered_chk CHECK (status NOT IN ('AWAITING_REVIEW', 'COMPLETED') OR ai_request_id IS NOT NULL),
  -- The international route is for public data whatever else is said: the run keeps the same rule as the request it made.
  ADD CONSTRAINT analysis_run_route_chk CHECK (route_class IS DISTINCT FROM 'INTERNATIONAL' OR data_classification = 'PUBLIC'),
  ADD CONSTRAINT analysis_run_supersedes_chk CHECK (supersedes_run_id IS DISTINCT FROM id);

-- The same input is the same run, unless that run was cancelled or ended without an answer: a run that failed or was refused leaves the input free to be asked again.
DROP INDEX machvon.analysis_run_input_uq;
CREATE UNIQUE INDEX analysis_run_input_uq ON machvon.analysis_run (tenant_id, proposal_id, criteria_version_id, input_hash) WHERE status NOT IN ('CANCELLED', 'FAILED', 'REJECTED_BY_POLICY');

-- ---- the findings and their evidence -------------------------------------------------------------------------------------------------------

ALTER TABLE machvon.analysis_finding
  ADD COLUMN missing_source boolean NOT NULL DEFAULT false;

ALTER TABLE machvon.analysis_finding
  ADD CONSTRAINT analysis_finding_status_chk CHECK (status IN ('SUPPORTED', 'CONTRADICTED', 'MISSING', 'NEEDS_REVIEW')),
  ADD CONSTRAINT analysis_finding_text_chk CHECK (char_length(finding) BETWEEN 1 AND 4000),
  ADD CONSTRAINT analysis_finding_refs_chk CHECK (jsonb_typeof(evidence_refs) = 'array'),
  ADD CONSTRAINT analysis_finding_count_chk CHECK (evidence_count >= 0),
  -- BR-BID-07: a finding that says it is supported or contradicted stands on at least one citation that is on its page.
  ADD CONSTRAINT analysis_finding_evidence_chk CHECK (status NOT IN ('SUPPORTED', 'CONTRADICTED') OR evidence_count >= 1),
  ADD CONSTRAINT analysis_finding_source_chk CHECK (NOT missing_source OR (status = 'NEEDS_REVIEW' AND evidence_count = 0)),
  ADD CONSTRAINT analysis_finding_reason_chk CHECK (final_status IS NULL OR (override_reason IS NOT NULL AND char_length(override_reason) >= 20)),
  ADD CONSTRAINT analysis_finding_reviewed_chk CHECK ((final_status IS NULL) = (reviewed_at IS NULL));
CREATE UNIQUE INDEX analysis_finding_criterion_uq ON machvon.analysis_finding (tenant_id, run_id, criterion_id);

ALTER TABLE machvon.analysis_evidence
  ADD CONSTRAINT analysis_evidence_page_chk CHECK (page_index IS NULL OR page_index >= 0),
  ADD CONSTRAINT analysis_evidence_hash_chk CHECK (quote_sha256 IS NULL OR quote_sha256 ~ '^[0-9a-f]{64}$');

-- ---- the guards ----------------------------------------------------------------------------------------------------------------------------

-- A run begins as it runs; what it was asked never changes; it moves forward once to the end the pipeline reached, and the experts take it to COMPLETED; a run that is over stays so; nothing deletes a run.
-- The owner of the schema (the migrations and the maintenance of the platform) is not held by these guards.
CREATE FUNCTION machvon.guard_analysis_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('QUEUED', 'RUNNING') OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'a run begins queued or running' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a run is kept for good' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.criteria_version_id IS DISTINCT FROM OLD.criteria_version_id OR NEW.profile_version_id IS DISTINCT FROM OLD.profile_version_id OR NEW.prompt_version_id IS DISTINCT FROM OLD.prompt_version_id
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash OR NEW.document_version_set_sha256 IS DISTINCT FROM OLD.document_version_set_sha256 OR NEW.data_classification IS DISTINCT FROM OLD.data_classification
     OR NEW.supersedes_run_id IS DISTINCT FROM OLD.supersedes_run_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what a run was asked does not change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED_BY_POLICY') THEN
    RAISE EXCEPTION 'a run that is over stays so' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a run moves one version at a time' USING ERRCODE = '23514';
  END IF;
  IF (OLD.ai_request_id IS NOT NULL AND NEW.ai_request_id IS DISTINCT FROM OLD.ai_request_id) OR (OLD.budget_reservation_id IS NOT NULL AND NEW.budget_reservation_id IS DISTINCT FROM OLD.budget_reservation_id) THEN
    RAISE EXCEPTION 'the request and the hold of a run are set once' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'CANCELLED', 'FAILED', 'REJECTED_BY_POLICY'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('AWAITING_REVIEW', 'FAILED', 'REJECTED_BY_POLICY', 'CANCELLED'))
    OR (OLD.status = 'AWAITING_REVIEW' AND NEW.status IN ('COMPLETED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'a run does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER analysis_run_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.analysis_run
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_analysis_run();
CREATE TRIGGER analysis_run_no_truncate BEFORE TRUNCATE ON machvon.analysis_run
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_analysis_run();

-- A finding is written while its run runs and says what the model said, once. The only thing that ever changes is the review of an expert (the reviewer, the final status, the reason, the moment), of a run that waits
-- for the experts or is completed. Nothing deletes a finding.
CREATE FUNCTION machvon.guard_analysis_finding() RETURNS trigger
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
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a finding is kept for good' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.criterion_id IS DISTINCT FROM OLD.criterion_id
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.finding IS DISTINCT FROM OLD.finding OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs OR NEW.confidence_type IS DISTINCT FROM OLD.confidence_type
     OR NEW.evidence_count IS DISTINCT FROM OLD.evidence_count OR NEW.missing_source IS DISTINCT FROM OLD.missing_source OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what the model said of a criterion does not change' USING ERRCODE = '42501';
  END IF;
  SELECT r.status INTO run_status FROM machvon.analysis_run r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id;
  IF run_status NOT IN ('AWAITING_REVIEW', 'COMPLETED') THEN
    RAISE EXCEPTION 'a finding is reviewed when its run waits for the experts' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER analysis_finding_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.analysis_finding
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_analysis_finding();
CREATE TRIGGER analysis_finding_no_truncate BEFORE TRUNCATE ON machvon.analysis_finding
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_analysis_finding();

-- The evidence of a finding is a fact of the run that made it: written while the run runs, never changed, never deleted.
CREATE FUNCTION machvon.guard_analysis_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the evidence of a finding is kept as it was found' USING ERRCODE = '42501';
  END IF;
  SELECT r.status INTO run_status
    FROM machvon.analysis_finding f JOIN machvon.analysis_run r ON r.tenant_id = f.tenant_id AND r.id = f.run_id
   WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.finding_id;
  IF run_status IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'evidence is written while the run of its finding runs' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER analysis_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.analysis_evidence
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_analysis_evidence();
CREATE TRIGGER analysis_evidence_no_truncate BEFORE TRUNCATE ON machvon.analysis_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_analysis_evidence();

-- BR-BID-07: the number of citations a finding stands on is the number of its citations that were found on their page, checked when the transaction that wrote the finding commits.
CREATE FUNCTION machvon.check_analysis_finding_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN RETURN NULL; END IF;
  IF NEW.evidence_count IS DISTINCT FROM (SELECT count(*) FROM machvon.analysis_evidence e WHERE e.tenant_id = NEW.tenant_id AND e.finding_id = NEW.id AND e.verified_present) THEN
    RAISE EXCEPTION 'the evidence count of a finding is the number of its verified citations' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER analysis_finding_evidence_count AFTER INSERT ON machvon.analysis_finding
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_analysis_finding_evidence();

REVOKE DELETE, TRUNCATE ON TABLE machvon.analysis_run FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.analysis_finding FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.analysis_evidence FROM machvon_app;

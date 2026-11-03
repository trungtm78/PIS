-- Authored by hand (not generated): the evaluation report of a package and its sign-off by the evaluation team (ST-BID-012, BID 3 F6, BR-BID-03/09). The table evaluation_report comes from the generated schema (V002, with the
-- foreign keys to the package, the criteria version and the document, and an index on each of them). This adds what makes it the record of minutes that experts signed and DOC issued: the moment DOC was asked and the
-- event that asked, where the frozen payload is kept, when DOC issued the minutes and when it recalled them; the shape of a report that asked DOC to issue, of one that DOC issued and of one that DOC superseded; one
-- document and one request for each report; and the guard that keeps what the report was made from as it was made, lets a signature in only while the report is a draft, and moves a report along the edges of BID 4 only.
-- Since the report freezes what the experts decided, the findings of its runs are not decided again once the minutes were asked for (the second trigger below).

ALTER TABLE machvon.evaluation_report
  ADD COLUMN payload_ref text,
  ADD COLUMN issue_event_id uuid,
  ADD COLUMN issue_requested_at timestamptz,
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN recalled_at timestamptz;

ALTER TABLE machvon.evaluation_report
  ADD CONSTRAINT evaluation_report_json_chk CHECK (
    jsonb_typeof(summary_json) = 'object' AND jsonb_typeof(run_ids) = 'array' AND jsonb_typeof(signed_off_by) = 'array' AND jsonb_typeof(dissenting_opinions) = 'array'
  ),
  ADD CONSTRAINT evaluation_report_hash_chk CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  -- A report that asked DOC for the minutes (and one that has them) says what it asked with: the payload that was frozen and its hash, the event that carries the request and the moment.
  ADD CONSTRAINT evaluation_report_requested_chk CHECK (
    status NOT IN ('ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED') OR (payload_sha256 IS NOT NULL AND payload_ref IS NOT NULL AND issue_event_id IS NOT NULL AND issue_requested_at IS NOT NULL)
  ),
  -- The minutes DOC issued are the document of a report that was issued and of one that was superseded; no other report has one. A report is signed before DOC is asked.
  ADD CONSTRAINT evaluation_report_document_chk CHECK (
    (status IN ('ISSUED', 'SUPERSEDED')) = (report_document_id IS NOT NULL) AND (status IN ('ISSUED', 'SUPERSEDED')) = (issued_at IS NOT NULL)
  ),
  ADD CONSTRAINT evaluation_report_signed_chk CHECK (status = 'DRAFT' OR jsonb_array_length(signed_off_by) >= 1),
  ADD CONSTRAINT evaluation_report_recalled_chk CHECK (recalled_at IS NULL OR report_document_id IS NOT NULL);

-- One request carries one event and one document is the minutes of one report.
CREATE UNIQUE INDEX evaluation_report_issue_event_uq ON machvon.evaluation_report (tenant_id, issue_event_id) WHERE issue_event_id IS NOT NULL;
CREATE UNIQUE INDEX evaluation_report_document_uq ON machvon.evaluation_report (tenant_id, report_document_id) WHERE report_document_id IS NOT NULL;

-- The reports of a package, newest first.
CREATE INDEX evaluation_report_package_created_idx ON machvon.evaluation_report (tenant_id, package_id, created_at DESC, id DESC);

-- What the report is made from never changes (the package, the criteria, the runs and the summary the experts' decisions were frozen into), the payload and the minutes keep what they were given, and the signatures are
-- changed only while the report is a draft or fully signed: a report that asked DOC for the minutes keeps its signatures and its dissent. A report is written as a draft with no signature and is never deleted. The edges
-- are the ones of BID 4; SIGNED_OFF goes back to DRAFT when a member a decision on a conflict of interest shut out takes a signature away. The owner of the schema (the migrations and the maintenance) is not held.
CREATE FUNCTION machvon.guard_evaluation_report() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'an evaluation report is kept for good' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.version <> 1 OR jsonb_array_length(NEW.signed_off_by) <> 0 OR jsonb_array_length(NEW.dissenting_opinions) <> 0 OR jsonb_array_length(NEW.run_ids) < 1 THEN
      RAISE EXCEPTION 'an evaluation report is written as a draft that nobody signed, made from at least one run' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.package_id, NEW.criteria_version_id, NEW.run_ids, NEW.summary_json, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.package_id, OLD.criteria_version_id, OLD.run_ids, OLD.summary_json, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an evaluation report is made from never changes' USING ERRCODE = '23514';
  END IF;
  IF (OLD.payload_sha256 IS NOT NULL AND (NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256 OR NEW.payload_ref IS DISTINCT FROM OLD.payload_ref))
     OR (OLD.report_document_id IS NOT NULL AND NEW.report_document_id IS DISTINCT FROM OLD.report_document_id)
     OR (OLD.issued_at IS NOT NULL AND NEW.issued_at IS DISTINCT FROM OLD.issued_at) THEN
    RAISE EXCEPTION 'an evaluation report keeps the payload it was frozen with and the minutes it was issued as' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED')
     AND (NEW.signed_off_by IS DISTINCT FROM OLD.signed_off_by OR NEW.dissenting_opinions IS DISTINCT FROM OLD.dissenting_opinions) THEN
    RAISE EXCEPTION 'the signatures of a report that asked DOC for the minutes are kept' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('DRAFT', 'SIGNED_OFF'), ('SIGNED_OFF', 'DRAFT'), ('SIGNED_OFF', 'ISSUE_REQUESTED'), ('ISSUE_REQUESTED', 'ISSUED'), ('ISSUE_REQUESTED', 'SIGNED_OFF'), ('ISSUED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'the state transition of the evaluation report is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER evaluation_report_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.evaluation_report
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_evaluation_report();
CREATE TRIGGER evaluation_report_no_truncate BEFORE TRUNCATE ON machvon.evaluation_report
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_evaluation_report();

REVOKE DELETE, TRUNCATE ON TABLE machvon.evaluation_report FROM machvon_app;

-- BID 4: the final status of a finding is immutable after its report is ISSUED. It is frozen from the moment the report asked DOC for the minutes (and stays so when a later report supersedes it): the minutes say what
-- the experts decided, so a decision about a finding of one of its runs is not taken again.
CREATE FUNCTION machvon.guard_analysis_finding_review_frozen() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM machvon.analysis_finding f
      JOIN machvon.analysis_run r ON r.tenant_id = f.tenant_id AND r.id = f.run_id
      JOIN machvon.evaluation_report e ON e.tenant_id = r.tenant_id AND e.package_id = r.package_id
     WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.finding_id
       AND e.status IN ('ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED') AND e.run_ids ? r.id::text
  ) THEN
    RAISE EXCEPTION 'REPORT_FROZEN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER analysis_finding_review_frozen BEFORE INSERT ON machvon.analysis_finding_review
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_analysis_finding_review_frozen();

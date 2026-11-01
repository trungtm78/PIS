-- Authored by hand (not generated): requests to certify a metric, publish a dashboard version or activate an access policy, and the certified metric they end in (ST-BI-006, BI.md F5).
-- V002 gave the tables, the one pending request per object and the rule that who decides is not who asked; what the rest of the flow stands on is put into the database here, whatever the application checked first:
--   * a request is made once and only moves: PENDING to DECIDED (the decision, who decided and when written together, and once) or to WITHDRAWN; what it asks, who asked and the checks it was made with never change;
--   * a request that is rejected carries the reason of the decision;
--   * a metric a tenant drafted becomes CERTIFIED only with the person who certified it (not its author, V002), and a metric that left DRAFT keeps its definition: its code, revision, formula, dataset and dimensions are
--     fixed (409 VERSION_IMMUTABLE at the application, 42501 here), only its state and the days it applies move, and nothing is deleted.

ALTER TABLE machvon.bi_publication_request
  ADD CONSTRAINT bi_publication_request_state_chk CHECK (
    (status = 'PENDING' AND decision IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR (status = 'DECIDED' AND decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'WITHDRAWN' AND decision IS NULL)) NOT VALID,
  ADD CONSTRAINT bi_publication_request_reason_chk CHECK (decision IS DISTINCT FROM 'REJECTED' OR nullif(btrim(coalesce(comment, '')), '') IS NOT NULL) NOT VALID,
  ADD CONSTRAINT bi_publication_request_checks_chk CHECK (jsonb_typeof(checks_json) = 'object') NOT VALID;

CREATE INDEX bi_publication_request_status_idx ON machvon.bi_publication_request (tenant_id, status, created_at DESC, id);

CREATE FUNCTION machvon.guard_bi_publication_request() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'publication requests are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.object_kind, NEW.object_id, NEW.requested_by, NEW.checks_json, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.object_kind, OLD.object_id, OLD.requested_by, OLD.checks_json, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a publication request asks, who asked and the checks it was made with never change' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'PENDING' AND NEW.status IN ('DECIDED', 'WITHDRAWN'))) THEN
    RAISE EXCEPTION 'a publication request cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'PENDING' AND (NEW.decision, NEW.decided_by, NEW.decided_at, NEW.comment) IS DISTINCT FROM (OLD.decision, OLD.decided_by, OLD.decided_at, OLD.comment) THEN
    RAISE EXCEPTION 'the decision on a publication request is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER bi_publication_request_guard BEFORE UPDATE OR DELETE ON machvon.bi_publication_request
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_bi_publication_request();
CREATE TRIGGER bi_publication_request_no_truncate BEFORE TRUNCATE ON machvon.bi_publication_request
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_bi_publication_request();

ALTER TABLE machvon.metric_definition
  ADD CONSTRAINT metric_definition_status_chk CHECK (status IN ('DRAFT', 'IN_REVIEW', 'CERTIFIED', 'SUPERSEDED', 'RETIRED')) NOT VALID,
  ADD CONSTRAINT metric_definition_certified_chk CHECK (status <> 'CERTIFIED' OR origin <> 'TENANT_UI' OR certified_by IS NOT NULL) NOT VALID;

CREATE FUNCTION machvon.guard_metric_definition() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'metric definitions are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.code, NEW.revision, NEW.origin, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.code, OLD.revision, OLD.origin, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'the code, revision and origin of a metric are fixed when it is made' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.grain, NEW.aggregation_type, NEW.expression_ast, NEW.numerator_ast, NEW.denominator_ast, NEW.unit, NEW.null_policy, NEW.dimension_codes, NEW.dataset_id, NEW.effective_from)
     IS DISTINCT FROM (OLD.grain, OLD.aggregation_type, OLD.expression_ast, OLD.numerator_ast, OLD.denominator_ast, OLD.unit, OLD.null_policy, OLD.dimension_codes, OLD.dataset_id, OLD.effective_from) THEN
    RAISE EXCEPTION 'a metric that left DRAFT keeps its definition (UPDATE on %.% by %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501', DETAIL = 'VERSION_IMMUTABLE';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR (OLD.status = 'DRAFT' AND NEW.status IN ('IN_REVIEW', 'CERTIFIED'))
          OR (OLD.status = 'IN_REVIEW' AND NEW.status IN ('DRAFT', 'CERTIFIED'))
          OR (OLD.status = 'CERTIFIED' AND NEW.status IN ('SUPERSEDED', 'RETIRED'))
          OR (OLD.status = 'SUPERSEDED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'a metric cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.certified_by IS NOT NULL AND NEW.certified_by IS DISTINCT FROM OLD.certified_by THEN
    RAISE EXCEPTION 'who certified a metric is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER metric_definition_guard BEFORE UPDATE OR DELETE ON machvon.metric_definition
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_metric_definition();
CREATE TRIGGER metric_definition_no_truncate BEFORE TRUNCATE ON machvon.metric_definition
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_metric_definition();

REVOKE DELETE, TRUNCATE ON TABLE machvon.bi_publication_request FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.metric_definition FROM machvon_app;

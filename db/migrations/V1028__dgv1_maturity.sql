-- Authored by hand (not generated): the maturity of data governance (ST-DGV-008, DGV.md F8, BR-DGV-08).
-- V002 gave the tables; what the score stands on is put into the database here, whatever the application checked first:
--   * a rubric version never changes what it says (its pillars, the weights, the mapping to the frameworks, the coverage it asks for, how long evidence lasts); it is DRAFT, then PUBLISHED by somebody other than who
--     drafted it, then SUPERSEDED by the next revision of the same rubric; one revision of a rubric is published at a time;
--   * an assessment names its rubric version, its scope, its assessor and its reviewer (never the same person); it moves DRAFT -> IN_REVIEW -> PUBLISHED | REJECTED (IN_REVIEW -> DRAFT when it is returned), and a published
--     assessment is published by somebody other than the assessor and is never changed again, nor are the evidence rows under it; a score exists only when the assessment is published;
--   * a criterion is ASSESSED only with a level, evidence and a day the evidence lasts to; it is accepted by a reviewer other than who assessed it; a criterion that is not assessed has no level (so a missing evidence is
--     never a level, never a 0 or a 1);
--   * a milestone is ACHIEVED only by a published assessment, and ACHIEVED and MISSED are final.
-- Nothing here is deleted. The rows that earlier fixtures lean on (without a rubric version, a scope or an assessor) are not judged by the checks that are NOT VALID.

ALTER TABLE machvon.maturity_rubric_version
  ADD CONSTRAINT maturity_rubric_code_chk CHECK (char_length(btrim(rubric_code)) BETWEEN 2 AND 60) NOT VALID,
  ADD CONSTRAINT maturity_rubric_shape_chk CHECK (jsonb_typeof(pillars_json) = 'object' AND jsonb_typeof(pillars_json -> 'pillars') = 'array' AND jsonb_typeof(framework_refs) = 'object') NOT VALID,
  ADD CONSTRAINT maturity_rubric_ttl_chk CHECK (evidence_ttl_days BETWEEN 1 AND 3650) NOT VALID,
  ADD CONSTRAINT maturity_rubric_published_chk CHECK (status = 'DRAFT' OR approved_by IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX maturity_rubric_published_uq ON machvon.maturity_rubric_version (tenant_id, rubric_code) WHERE status = 'PUBLISHED';

ALTER TABLE machvon.maturity_assessment
  ADD CONSTRAINT maturity_assessment_status_chk CHECK (status IN ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'REJECTED')) NOT VALID,
  ADD CONSTRAINT maturity_assessment_new_chk CHECK (rubric_version_id IS NOT NULL AND scope_kind IS NOT NULL AND assessor_user_id IS NOT NULL AND reviewer_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT maturity_assessment_scope_chk CHECK (scope_kind IS NULL OR (scope_kind = 'TENANT') = (scope_ref IS NULL)) NOT VALID,
  ADD CONSTRAINT maturity_assessment_period_chk CHECK (char_length(btrim(period_code)) BETWEEN 4 AND 20) NOT VALID,
  ADD CONSTRAINT maturity_assessment_coverage_chk CHECK (coverage_percent BETWEEN 0 AND 100) NOT VALID,
  ADD CONSTRAINT maturity_assessment_published_chk CHECK (status <> 'PUBLISHED' OR (published_by IS NOT NULL AND published_at IS NOT NULL AND overall_state IS NOT NULL AND published_by IS DISTINCT FROM assessor_user_id)) NOT VALID,
  ADD CONSTRAINT maturity_assessment_people_chk CHECK (assessor_user_id IS DISTINCT FROM reviewer_id) NOT VALID;

CREATE UNIQUE INDEX maturity_assessment_period_uq ON machvon.maturity_assessment (tenant_id, rubric_version_id, scope_kind, coalesce(scope_ref, ''), period_code) WHERE rubric_version_id IS NOT NULL AND status <> 'REJECTED';
CREATE INDEX maturity_assessment_status_idx ON machvon.maturity_assessment (tenant_id, status, period_code DESC);

ALTER TABLE machvon.maturity_evidence
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  ADD CONSTRAINT maturity_evidence_review_chk CHECK (review_status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED')) NOT VALID,
  ADD CONSTRAINT maturity_evidence_accepted_chk CHECK (review_status <> 'ACCEPTED' OR (assessment_state IN ('ASSESSED', 'NOT_APPLICABLE') AND reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT maturity_evidence_assessed_chk CHECK (assessment_state <> 'ASSESSED' OR (jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) > 0 AND assessed_by IS NOT NULL AND evidence_expires_on IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT maturity_evidence_sample_chk CHECK (sample_size IS NULL OR sample_size > 0) NOT VALID;

CREATE INDEX maturity_evidence_assessment_idx ON machvon.maturity_evidence (tenant_id, assessment_id);
CREATE INDEX maturity_evidence_expiry_idx ON machvon.maturity_evidence (tenant_id, evidence_expires_on) WHERE assessment_state = 'ASSESSED';

ALTER TABLE machvon.maturity_milestone
  ADD CONSTRAINT maturity_milestone_text_chk CHECK (char_length(btrim(exit_criteria)) BETWEEN 10 AND 2000 AND char_length(btrim(pillar_code)) BETWEEN 2 AND 40) NOT VALID,
  ADD CONSTRAINT maturity_milestone_evidence_chk CHECK (jsonb_typeof(evidence_required) = 'array') NOT VALID;

CREATE INDEX maturity_milestone_due_idx ON machvon.maturity_milestone (tenant_id, status, due_on);

CREATE FUNCTION machvon.guard_maturity_rubric_version() RETURNS trigger
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
    RAISE EXCEPTION 'a version of a maturity rubric is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.rubric_code, NEW.revision, NEW.framework_refs, NEW.pillars_json, NEW.min_coverage_pct, NEW.evidence_ttl_days, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.rubric_code, OLD.revision, OLD.framework_refs, OLD.pillars_json, OLD.min_coverage_pct, OLD.evidence_ttl_days, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a version of a maturity rubric says never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED') OR (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a version of a maturity rubric cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'who published a version of a maturity rubric never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.approved_by IS NOT NULL AND NEW.approved_by = NEW.created_by THEN
    RAISE EXCEPTION 'a version of a maturity rubric is published by somebody other than who drafted it' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER maturity_rubric_version_guard BEFORE UPDATE OR DELETE ON machvon.maturity_rubric_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_maturity_rubric_version();
CREATE TRIGGER maturity_rubric_version_no_truncate BEFORE TRUNCATE ON machvon.maturity_rubric_version
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_maturity_rubric_version();

CREATE FUNCTION machvon.guard_maturity_assessment() RETURNS trigger
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
    RAISE EXCEPTION 'an assessment of maturity is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'a published assessment of maturity is never changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.rubric_version_id IS NOT NULL
     AND (NEW.period_code, NEW.rubric_version, NEW.rubric_version_id, NEW.scope_kind, NEW.scope_ref, NEW.assessor_user_id, NEW.reviewer_id, NEW.created_at)
         IS DISTINCT FROM (OLD.period_code, OLD.rubric_version, OLD.rubric_version_id, OLD.scope_kind, OLD.scope_ref, OLD.assessor_user_id, OLD.reviewer_id, OLD.created_at) THEN
    RAISE EXCEPTION 'what an assessment of maturity is about, and who assesses and reviews it, never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR (OLD.status = 'DRAFT' AND NEW.status = 'IN_REVIEW')
          OR (OLD.status = 'IN_REVIEW' AND NEW.status IN ('DRAFT', 'PUBLISHED', 'REJECTED'))) THEN
    RAISE EXCEPTION 'an assessment of maturity cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> 'PUBLISHED' AND (NEW.overall_level, NEW.overall_state, NEW.published_by, NEW.published_at) IS DISTINCT FROM (OLD.overall_level, OLD.overall_state, OLD.published_by, OLD.published_at) THEN
    RAISE EXCEPTION 'a score exists only when the assessment is published' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER maturity_assessment_guard BEFORE UPDATE OR DELETE ON machvon.maturity_assessment
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_maturity_assessment();
CREATE TRIGGER maturity_assessment_no_truncate BEFORE TRUNCATE ON machvon.maturity_assessment
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_maturity_assessment();

CREATE FUNCTION machvon.guard_maturity_evidence() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  state text;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'the evidence of a maturity assessment is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.assessment_id, NEW.pillar_code, NEW.criterion_code, NEW.created_at) IS DISTINCT FROM (OLD.assessment_id, OLD.pillar_code, OLD.criterion_code, OLD.created_at) THEN
    RAISE EXCEPTION 'which criterion of which assessment a row of evidence is for never changes' USING ERRCODE = '42501';
  END IF;
  SELECT a.status INTO state FROM machvon.maturity_assessment a WHERE a.tenant_id = OLD.tenant_id AND a.id = OLD.assessment_id;
  IF state = 'PUBLISHED' THEN
    RAISE EXCEPTION 'the evidence under a published assessment of maturity is never changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER maturity_evidence_guard BEFORE UPDATE OR DELETE ON machvon.maturity_evidence
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_maturity_evidence();
CREATE TRIGGER maturity_evidence_no_truncate BEFORE TRUNCATE ON machvon.maturity_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_maturity_evidence();

CREATE FUNCTION machvon.guard_maturity_milestone() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  state text;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a milestone of maturity is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.rubric_version_id, NEW.pillar_code, NEW.target_level, NEW.due_on, NEW.owner_user_id, NEW.exit_criteria, NEW.evidence_required, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.rubric_version_id, OLD.pillar_code, OLD.target_level, OLD.due_on, OLD.owner_user_id, OLD.exit_criteria, OLD.evidence_required, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a milestone of maturity asks for never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'PLANNED' AND NEW.status IN ('IN_PROGRESS', 'ACHIEVED', 'MISSED')) OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('ACHIEVED', 'MISSED'))) THEN
    RAISE EXCEPTION 'a milestone of maturity cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.achieved_assessment_id IS NOT NULL AND NEW.achieved_assessment_id IS DISTINCT FROM OLD.achieved_assessment_id THEN
    RAISE EXCEPTION 'the assessment that proved a milestone never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'ACHIEVED' AND OLD.status <> 'ACHIEVED' THEN
    SELECT a.status INTO state FROM machvon.maturity_assessment a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.achieved_assessment_id;
    IF state IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'a milestone is achieved by a published assessment' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER maturity_milestone_guard BEFORE UPDATE OR DELETE ON machvon.maturity_milestone
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_maturity_milestone();
CREATE TRIGGER maturity_milestone_no_truncate BEFORE TRUNCATE ON machvon.maturity_milestone
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_maturity_milestone();

REVOKE DELETE, TRUNCATE ON TABLE machvon.maturity_rubric_version FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.maturity_assessment FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.maturity_evidence FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.maturity_milestone FROM machvon_app;

-- The two things the sweep tells people (the assessor whose evidence ran out, the owner of a milestone that was missed) are events of the notification service: unregistered, they would never be delivered.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'dgv.evidence.expired.v1',
  'DGV',
  1,
  '{"type":"object","required":["tenant_id","assessment_id","period_code","criteria"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"assessment_id":{"type":"string","format":"uuid"},"period_code":{"type":"string"},"criteria":{"type":"array","items":{"type":"string"}},"occurred_at":{"type":"string"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;

INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'dgv.maturity.milestone_missed.v1',
  'DGV',
  1,
  '{"type":"object","required":["tenant_id","milestone_id","pillar_code","target_level","due_on"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"milestone_id":{"type":"string","format":"uuid"},"pillar_code":{"type":"string"},"target_level":{"type":"integer"},"due_on":{"type":"string"},"occurred_at":{"type":"string"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;

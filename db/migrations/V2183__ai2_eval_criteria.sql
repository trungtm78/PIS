-- Authored by hand (not generated): the criteria a contract's performance is evaluated against by the assistant (lane AI-2, AI.04, screen LLM-26).
-- A set of criteria is configuration of the tenant: a code with revisions, each a list of criteria with a weight in basis points (the weights of a set add up to 10000: the server checks it when the set is
-- published) and a scale. A criterion that requires evidence is scored by the assistant only when it can cite a record the asker may read; otherwise its score is withheld. The weights are not rules of the law:
-- they are the tenant's own policy and carry the date and the person who published them.
--   * a revision is DRAFT until another person than its author publishes it; a published revision is frozen (its criteria too) and retired when a newer one is published; one revision of a code is published at a time.

CREATE TABLE machvon.ai_eval_criteria_set (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  scale_max integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'DRAFT',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  published_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_eval_set_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_.-]{1,59}$'),
  CONSTRAINT ai_eval_set_revision_chk CHECK (revision >= 1),
  CONSTRAINT ai_eval_set_title_chk CHECK (title = btrim(title) AND char_length(title) BETWEEN 2 AND 300),
  CONSTRAINT ai_eval_set_scale_chk CHECK (scale_max BETWEEN 1 AND 1000),
  CONSTRAINT ai_eval_set_status_chk CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  CONSTRAINT ai_eval_set_publish_chk CHECK ((status = 'DRAFT') = (published_by IS NULL) AND (published_by IS NULL) = (published_at IS NULL)),
  CONSTRAINT ai_eval_set_maker_checker_chk CHECK (published_by IS NULL OR published_by <> created_by),
  CONSTRAINT ai_eval_set_revision_uq UNIQUE (tenant_id, code, revision)
);
CREATE UNIQUE INDEX ai_eval_set_published_uq ON machvon.ai_eval_criteria_set (tenant_id, code) WHERE status = 'PUBLISHED';

CREATE TABLE machvon.ai_eval_criterion (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  criteria_set_id uuid NOT NULL,
  criterion_code text NOT NULL,
  position integer NOT NULL,
  label text NOT NULL,
  guidance text NOT NULL DEFAULT '',
  weight_bp integer NOT NULL,
  evidence_required boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, criteria_set_id) REFERENCES machvon.ai_eval_criteria_set (tenant_id, id),
  CONSTRAINT ai_eval_criterion_code_chk CHECK (criterion_code ~ '^[A-Z][A-Z0-9_.-]{0,39}$'),
  CONSTRAINT ai_eval_criterion_position_chk CHECK (position >= 1),
  CONSTRAINT ai_eval_criterion_label_chk CHECK (label = btrim(label) AND char_length(label) BETWEEN 2 AND 300),
  CONSTRAINT ai_eval_criterion_guidance_chk CHECK (char_length(guidance) <= 2000),
  CONSTRAINT ai_eval_criterion_weight_chk CHECK (weight_bp BETWEEN 1 AND 10000),
  CONSTRAINT ai_eval_criterion_code_uq UNIQUE (tenant_id, criteria_set_id, criterion_code),
  CONSTRAINT ai_eval_criterion_position_uq UNIQUE (tenant_id, criteria_set_id, position)
);

CREATE FUNCTION machvon.guard_ai_eval_criteria_set() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a published set of criteria is not deleted' USING ERRCODE = '23514', CONSTRAINT = 'ai_eval_criteria_frozen';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.code <> OLD.code OR NEW.revision <> OLD.revision OR NEW.title <> OLD.title OR NEW.scale_max <> OLD.scale_max OR NEW.created_by <> OLD.created_by OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.published_at IS DISTINCT FROM OLD.published_at OR (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED') OR (OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED', 'RETIRED'))) THEN
    RAISE EXCEPTION 'a published set of criteria does not change; it is retired by a newer revision' USING ERRCODE = '23514', CONSTRAINT = 'ai_eval_criteria_frozen';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ai_eval_criteria_set_guard BEFORE UPDATE OR DELETE ON machvon.ai_eval_criteria_set FOR EACH ROW EXECUTE FUNCTION machvon.guard_ai_eval_criteria_set();

CREATE FUNCTION machvon.guard_ai_eval_criterion() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
  parent_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.criteria_set_id ELSE NEW.criteria_set_id END;
BEGIN
  SELECT status INTO parent_status FROM machvon.ai_eval_criteria_set WHERE tenant_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END AND id = parent_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the criteria of a published set do not change' USING ERRCODE = '23514', CONSTRAINT = 'ai_eval_criteria_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

CREATE TRIGGER ai_eval_criterion_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.ai_eval_criterion FOR EACH ROW EXECUTE FUNCTION machvon.guard_ai_eval_criterion();

ALTER TABLE machvon.ai_eval_criteria_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_eval_criteria_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_eval_criteria_set AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_eval_criteria_set AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.ai_eval_criterion ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_eval_criterion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_eval_criterion AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_eval_criterion AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE TRUNCATE ON TABLE machvon.ai_eval_criteria_set FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.ai_eval_criterion FROM machvon_app;

ALTER TABLE machvon.ai_assist_run ADD CONSTRAINT ai_assist_run_criteria_fk FOREIGN KEY (tenant_id, criteria_set_id) REFERENCES machvon.ai_eval_criteria_set (tenant_id, id);

COMMENT ON TABLE machvon.ai_eval_criteria_set IS 'AI-2: a revision of the criteria a contract performance is evaluated against; weights in basis points; published by another person, then frozen.';
COMMENT ON TABLE machvon.ai_eval_criterion IS 'AI-2: a criterion of a set: label, guidance, weight in basis points, whether it needs a cited record.';

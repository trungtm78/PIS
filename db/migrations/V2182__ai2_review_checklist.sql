-- Authored by hand (not generated): the checklists a file is reviewed against before it is sent up (lane AI-2, AI.02, screen LLM-26).
-- A checklist is configuration of the tenant: a code with revisions, each a list of items. An item is checked by a rule written in code (`REQUIRED_TERMS`, `MIN_WORDS`, `PATTERN`: the server computes a pass or a fail from the text of the
-- file) or put to the assistant as a question (`AI_QUESTION`: the answer counts only with a citation the server verified). The weight of an item is its severity: a BLOCKER that fails or cannot be shown makes the file not ready.
--   * a revision is DRAFT until another person than its author publishes it; a published revision never changes (its items are frozen with it) and is retired when a newer one is published;
--   * one revision of a code is published at a time; a code and revision exist once.

CREATE TABLE machvon.ai_review_checklist (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  applies_to text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  published_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_review_checklist_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_.-]{1,59}$'),
  CONSTRAINT ai_review_checklist_revision_chk CHECK (revision >= 1),
  CONSTRAINT ai_review_checklist_title_chk CHECK (title = btrim(title) AND char_length(title) BETWEEN 2 AND 300),
  CONSTRAINT ai_review_checklist_applies_chk CHECK (applies_to ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT ai_review_checklist_status_chk CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  CONSTRAINT ai_review_checklist_publish_chk CHECK ((status = 'DRAFT') = (published_by IS NULL) AND (published_by IS NULL) = (published_at IS NULL)),
  CONSTRAINT ai_review_checklist_maker_checker_chk CHECK (published_by IS NULL OR published_by <> created_by),
  CONSTRAINT ai_review_checklist_revision_uq UNIQUE (tenant_id, code, revision)
);
CREATE UNIQUE INDEX ai_review_checklist_published_uq ON machvon.ai_review_checklist (tenant_id, code) WHERE status = 'PUBLISHED';
CREATE INDEX ai_review_checklist_applies_idx ON machvon.ai_review_checklist (tenant_id, applies_to, status);

CREATE TABLE machvon.ai_review_checklist_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  checklist_id uuid NOT NULL,
  item_code text NOT NULL,
  position integer NOT NULL,
  label text NOT NULL,
  check_kind text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, checklist_id) REFERENCES machvon.ai_review_checklist (tenant_id, id),
  CONSTRAINT ai_review_item_code_chk CHECK (item_code ~ '^[A-Z][A-Z0-9_.-]{0,39}$'),
  CONSTRAINT ai_review_item_position_chk CHECK (position >= 1),
  CONSTRAINT ai_review_item_label_chk CHECK (label = btrim(label) AND char_length(label) BETWEEN 2 AND 500),
  CONSTRAINT ai_review_item_kind_chk CHECK (check_kind IN ('REQUIRED_TERMS', 'MIN_WORDS', 'PATTERN', 'AI_QUESTION')),
  CONSTRAINT ai_review_item_params_chk CHECK (jsonb_typeof(params) = 'object'),
  CONSTRAINT ai_review_item_severity_chk CHECK (severity IN ('BLOCKER', 'WARNING', 'INFO')),
  CONSTRAINT ai_review_item_code_uq UNIQUE (tenant_id, checklist_id, item_code),
  CONSTRAINT ai_review_item_position_uq UNIQUE (tenant_id, checklist_id, position)
);

-- A revision is edited while it is a draft only; once published it goes to RETIRED or stays, and nothing else about it changes.
CREATE FUNCTION machvon.guard_ai_review_checklist() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a published checklist is not deleted' USING ERRCODE = '23514', CONSTRAINT = 'ai_review_checklist_frozen';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.code <> OLD.code OR NEW.revision <> OLD.revision OR NEW.title <> OLD.title OR NEW.applies_to <> OLD.applies_to OR NEW.created_by <> OLD.created_by OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.published_at IS DISTINCT FROM OLD.published_at OR (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED') OR (OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED', 'RETIRED'))) THEN
    RAISE EXCEPTION 'a published checklist does not change; it is retired by a newer revision' USING ERRCODE = '23514', CONSTRAINT = 'ai_review_checklist_frozen';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ai_review_checklist_guard BEFORE UPDATE OR DELETE ON machvon.ai_review_checklist FOR EACH ROW EXECUTE FUNCTION machvon.guard_ai_review_checklist();

CREATE FUNCTION machvon.guard_ai_review_checklist_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
  parent_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.checklist_id ELSE NEW.checklist_id END;
BEGIN
  SELECT status INTO parent_status FROM machvon.ai_review_checklist WHERE tenant_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END AND id = parent_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the items of a published checklist do not change' USING ERRCODE = '23514', CONSTRAINT = 'ai_review_checklist_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

CREATE TRIGGER ai_review_checklist_item_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.ai_review_checklist_item FOR EACH ROW EXECUTE FUNCTION machvon.guard_ai_review_checklist_item();

ALTER TABLE machvon.ai_review_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_review_checklist FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_review_checklist AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_review_checklist AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.ai_review_checklist_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_review_checklist_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_review_checklist_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_review_checklist_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE TRUNCATE ON TABLE machvon.ai_review_checklist FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.ai_review_checklist_item FROM machvon_app;

ALTER TABLE machvon.ai_assist_run ADD CONSTRAINT ai_assist_run_checklist_fk FOREIGN KEY (tenant_id, checklist_id) REFERENCES machvon.ai_review_checklist (tenant_id, id);

COMMENT ON TABLE machvon.ai_review_checklist IS 'AI-2: a revision of a checklist a file is reviewed against before it is sent up; published by another person, then frozen.';
COMMENT ON TABLE machvon.ai_review_checklist_item IS 'AI-2: an item of a checklist: a rule computed in code or a question put to the assistant, with a severity.';

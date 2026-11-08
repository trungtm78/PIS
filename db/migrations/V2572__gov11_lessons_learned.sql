-- Authored by hand (not generated): the lessons learned of a project and the waiver of them (GOV-11a, G1-19, PRJ closing gate, roadmap K13).
-- A lesson is what the project would do differently, with its category, what happened and what to do next time. It is proposed by a person and approved or rejected by another (the maker is not the checker). The
-- closing gate of a project asks for the number of approved lessons the governance rule `LESSONS_LEARNED_POLICY` says, or for an approved waiver (a reason why there is nothing to record, approved by a person
-- other than who asked). The gate itself is judged by the kernel and by the stage store of PRJ when the project is closed.
--   * a lesson is decided once; the person who decides is not the one who proposed it;
--   * one waiver for a project and a gate while it is waiting or approved; it is decided once by a person other than who asked;
--   * the rows are kept: the runtime role cannot delete or truncate them.

CREATE TABLE machvon.lesson_learned (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  owner_unit_id uuid NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  situation text NOT NULL,
  recommendation text NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED',
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT lesson_learned_category_chk CHECK (category ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT lesson_learned_text_chk CHECK (char_length(btrim(title)) BETWEEN 5 AND 200 AND char_length(btrim(situation)) BETWEEN 5 AND 4000 AND char_length(btrim(recommendation)) BETWEEN 5 AND 4000),
  CONSTRAINT lesson_learned_status_chk CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED') AND ((status = 'PROPOSED') = (decided_by IS NULL AND decided_at IS NULL)) AND (decided_by IS NULL OR decided_by <> proposed_by)),
  CONSTRAINT lesson_learned_version_chk CHECK (version >= 1)
);
CREATE INDEX lesson_learned_project_idx ON machvon.lesson_learned (tenant_id, project_id, status, proposed_at DESC);
CREATE INDEX lesson_learned_unit_idx ON machvon.lesson_learned (tenant_id, owner_unit_id, proposed_at DESC);

CREATE TABLE machvon.lesson_waiver (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  owner_unit_id uuid NOT NULL,
  gate text NOT NULL,
  reason text NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'REQUESTED',
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT lesson_waiver_gate_chk CHECK (gate IN ('CLOSE')),
  CONSTRAINT lesson_waiver_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 20 AND 2000),
  CONSTRAINT lesson_waiver_status_chk CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED') AND ((status = 'REQUESTED') = (decided_by IS NULL AND decided_at IS NULL)) AND (decided_by IS NULL OR decided_by <> requested_by)),
  CONSTRAINT lesson_waiver_version_chk CHECK (version >= 1)
);
CREATE UNIQUE INDEX lesson_waiver_active_uq ON machvon.lesson_waiver (tenant_id, project_id, gate) WHERE status IN ('REQUESTED', 'APPROVED');
CREATE INDEX lesson_waiver_unit_idx ON machvon.lesson_waiver (tenant_id, owner_unit_id, requested_at DESC);

CREATE FUNCTION machvon.guard_lesson() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a lesson or a waiver is kept' USING ERRCODE = '23514', CONSTRAINT = 'lesson_guard';
  END IF;
  IF TG_TABLE_NAME = 'lesson_learned' THEN
    IF NEW.project_id <> OLD.project_id OR NEW.proposed_by <> OLD.proposed_by OR NEW.proposed_at <> OLD.proposed_at OR NEW.category <> OLD.category OR NEW.title <> OLD.title
       OR NEW.situation <> OLD.situation OR NEW.recommendation <> OLD.recommendation THEN
      RAISE EXCEPTION 'what a lesson says does not change' USING ERRCODE = '23514', CONSTRAINT = 'lesson_learned_identity_guard';
    END IF;
  ELSE
    IF NEW.project_id <> OLD.project_id OR NEW.gate <> OLD.gate OR NEW.reason <> OLD.reason OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at THEN
      RAISE EXCEPTION 'what a waiver says does not change' USING ERRCODE = '23514', CONSTRAINT = 'lesson_waiver_identity_guard';
    END IF;
  END IF;
  IF OLD.status <> (CASE WHEN TG_TABLE_NAME = 'lesson_learned' THEN 'PROPOSED' ELSE 'REQUESTED' END) AND (NEW.status <> OLD.status OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'a decision on a lesson or a waiver is final' USING ERRCODE = '23514', CONSTRAINT = 'lesson_decision_guard';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER lesson_learned_guard BEFORE UPDATE OR DELETE ON machvon.lesson_learned FOR EACH ROW EXECUTE FUNCTION machvon.guard_lesson();
CREATE TRIGGER lesson_waiver_guard BEFORE UPDATE OR DELETE ON machvon.lesson_waiver FOR EACH ROW EXECUTE FUNCTION machvon.guard_lesson();

DO $rls$
DECLARE
  one text;
BEGIN
  FOREACH one IN ARRAY ARRAY['lesson_learned', 'lesson_waiver'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', one);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', one);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, one);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, one);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE machvon.%I FROM machvon_app', one);
  END LOOP;
END
$rls$;

COMMENT ON TABLE machvon.lesson_learned IS 'GOV-11a G1-19: a lesson learned of a project; proposed by one person and decided once by another.';
COMMENT ON TABLE machvon.lesson_waiver IS 'GOV-11a G1-19: the reason why a project has no lesson to record at a gate, decided once by a person other than who asked.';

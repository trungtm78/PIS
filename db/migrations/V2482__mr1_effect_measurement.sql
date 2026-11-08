-- Authored by hand (not generated): the post-investment effectiveness of a project, actuals part (MR-1, MR.03 merged with G4-7; docs/prj-effectiveness.md).
--   * `effect_measurement`: the actual value of an indicator on a day, after the commissioning. Append-only: a wrong measurement is not edited, a later row corrects it (`corrects_id`) with a reason.
--   * `effect_calendar_entry`: the evaluations the law asks for (Articles 76 and 77 of the Law on Public Investment, as a rule that is flagged not verified), each with the day it falls due, the anchor day it was
--     counted from and the version of the rule that gave the months. Generated once for a project; an approved assessment of its kind closes it.
--   * `effect_assessment`: the evaluation record: the variances of every indicator frozen on the day it was submitted, a conclusion, and a decision by someone other than the one who submitted it.

CREATE TABLE machvon.effect_measurement (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  target_set_id uuid NOT NULL,
  indicator_code text NOT NULL,
  measured_on date NOT NULL,
  value numeric(24, 6) NOT NULL,
  method_note text NOT NULL,
  evidence_document_id uuid,
  corrects_id uuid,
  correction_reason text,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, target_set_id) REFERENCES machvon.effect_target_set (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, evidence_document_id) REFERENCES machvon.document (tenant_id, id),
  FOREIGN KEY (tenant_id, corrects_id) REFERENCES machvon.effect_measurement (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT effect_measurement_code_chk CHECK (indicator_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT effect_measurement_note_chk CHECK (method_note = btrim(method_note) AND char_length(method_note) BETWEEN 3 AND 1000),
  CONSTRAINT effect_measurement_correction_chk CHECK ((corrects_id IS NULL) = (correction_reason IS NULL) AND (correction_reason IS NULL OR (correction_reason = btrim(correction_reason) AND char_length(correction_reason) BETWEEN 10 AND 2000)))
);
CREATE UNIQUE INDEX effect_measurement_day_uq ON machvon.effect_measurement (tenant_id, project_id, indicator_code, measured_on) WHERE corrects_id IS NULL;
CREATE UNIQUE INDEX effect_measurement_corrects_uq ON machvon.effect_measurement (tenant_id, corrects_id) WHERE corrects_id IS NOT NULL;
CREATE INDEX effect_measurement_project_idx ON machvon.effect_measurement (tenant_id, project_id, indicator_code, measured_on DESC, recorded_at DESC);
CREATE INDEX effect_measurement_set_idx ON machvon.effect_measurement (tenant_id, target_set_id);
CREATE INDEX effect_measurement_document_idx ON machvon.effect_measurement (tenant_id, evidence_document_id) WHERE evidence_document_id IS NOT NULL;
CREATE INDEX effect_measurement_recorder_idx ON machvon.effect_measurement (tenant_id, recorded_by);

CREATE FUNCTION machvon.mr1_effect_forbid_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER effect_measurement_immutable BEFORE UPDATE OR DELETE ON machvon.effect_measurement FOR EACH ROW EXECUTE FUNCTION machvon.mr1_effect_forbid_change();
CREATE TRIGGER effect_measurement_no_truncate BEFORE TRUNCATE ON machvon.effect_measurement FOR EACH STATEMENT EXECUTE FUNCTION machvon.mr1_effect_forbid_change();

CREATE TABLE machvon.effect_assessment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  kind text NOT NULL,
  target_set_id uuid NOT NULL,
  as_of date NOT NULL,
  status text NOT NULL DEFAULT 'SUBMITTED',
  conclusion text NOT NULL,
  summary text NOT NULL,
  -- The variance of every indicator on the day of the submission, frozen: the code, the unit, the baseline, the target, the actual with its day, the variance, the achievement and the band.
  lines jsonb NOT NULL,
  policy_version text NOT NULL,
  policy_unverified boolean NOT NULL DEFAULT true,
  calendar_entry_id uuid,
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, target_set_id) REFERENCES machvon.effect_target_set (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT effect_assessment_kind_chk CHECK (kind IN ('INITIAL', 'MIDTERM', 'FINAL', 'IMPACT', 'AD_HOC')),
  CONSTRAINT effect_assessment_status_chk CHECK (status IN ('SUBMITTED', 'APPROVED', 'RETURNED')),
  CONSTRAINT effect_assessment_conclusion_chk CHECK (conclusion IN ('SATISFACTORY', 'PARTIALLY_SATISFACTORY', 'UNSATISFACTORY')),
  CONSTRAINT effect_assessment_summary_chk CHECK (summary = btrim(summary) AND char_length(summary) BETWEEN 10 AND 4000),
  CONSTRAINT effect_assessment_lines_chk CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) >= 1),
  CONSTRAINT effect_assessment_decision_chk CHECK (
    (status = 'SUBMITTED' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status = 'APPROVED' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_by <> submitted_by AND (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 1 AND 2000)))
    OR (status = 'RETURNED' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_by <> submitted_by AND decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 10 AND 2000)
  ),
  CONSTRAINT effect_assessment_version_chk CHECK (row_version >= 1)
);
CREATE UNIQUE INDEX effect_assessment_open_uq ON machvon.effect_assessment (tenant_id, project_id, kind) WHERE status = 'SUBMITTED';
CREATE UNIQUE INDEX effect_assessment_approved_uq ON machvon.effect_assessment (tenant_id, project_id, kind) WHERE status = 'APPROVED' AND kind <> 'AD_HOC';
CREATE INDEX effect_assessment_project_idx ON machvon.effect_assessment (tenant_id, project_id, submitted_at DESC, id DESC);
CREATE INDEX effect_assessment_set_idx ON machvon.effect_assessment (tenant_id, target_set_id);
CREATE INDEX effect_assessment_calendar_idx ON machvon.effect_assessment (tenant_id, calendar_entry_id) WHERE calendar_entry_id IS NOT NULL;
CREATE INDEX effect_assessment_submitter_idx ON machvon.effect_assessment (tenant_id, submitted_by);
CREATE INDEX effect_assessment_decider_idx ON machvon.effect_assessment (tenant_id, decided_by) WHERE decided_by IS NOT NULL;

-- What an assessment says never changes; it is decided once.
CREATE FUNCTION machvon.guard_effect_assessment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'an assessment that was decided is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.target_set_id IS DISTINCT FROM OLD.target_set_id OR NEW.as_of IS DISTINCT FROM OLD.as_of
     OR NEW.conclusion IS DISTINCT FROM OLD.conclusion OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.lines IS DISTINCT FROM OLD.lines OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
    RAISE EXCEPTION 'what an assessment says never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER effect_assessment_guard BEFORE UPDATE ON machvon.effect_assessment FOR EACH ROW EXECUTE FUNCTION machvon.guard_effect_assessment();
CREATE TRIGGER effect_assessment_no_delete BEFORE DELETE ON machvon.effect_assessment FOR EACH ROW EXECUTE FUNCTION machvon.mr1_effect_forbid_change();
CREATE TRIGGER effect_assessment_no_truncate BEFORE TRUNCATE ON machvon.effect_assessment FOR EACH STATEMENT EXECUTE FUNCTION machvon.mr1_effect_forbid_change();

CREATE TABLE machvon.effect_calendar_entry (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  kind text NOT NULL,
  anchor text NOT NULL,
  anchor_on date NOT NULL,
  anchor_source text NOT NULL,
  months integer NOT NULL,
  due_on date NOT NULL,
  required boolean NOT NULL DEFAULT true,
  -- The rule that gave the months: its code (the project group), its version and whether its numbers are not yet confirmed against the law.
  rule_code text NOT NULL,
  rule_version text NOT NULL,
  rule_unverified boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'PLANNED',
  assessment_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES machvon.effect_assessment (tenant_id, id),
  CONSTRAINT effect_calendar_entry_kind_chk CHECK (kind IN ('INITIAL', 'MIDTERM', 'FINAL', 'IMPACT')),
  CONSTRAINT effect_calendar_entry_anchor_chk CHECK (anchor IN ('IMPLEMENTATION_START', 'COMPLETION', 'HANDOVER')),
  CONSTRAINT effect_calendar_entry_source_chk CHECK (anchor_source IN ('STAGE_HISTORY', 'HANDOVER_ACCEPTANCE')),
  CONSTRAINT effect_calendar_entry_months_chk CHECK (months BETWEEN 0 AND 240),
  CONSTRAINT effect_calendar_entry_status_chk CHECK (status IN ('PLANNED', 'DONE')),
  CONSTRAINT effect_calendar_entry_done_chk CHECK ((status = 'DONE') = (assessment_id IS NOT NULL AND closed_at IS NOT NULL)),
  CONSTRAINT effect_calendar_entry_uq UNIQUE (tenant_id, project_id, kind)
);
CREATE INDEX effect_calendar_entry_due_idx ON machvon.effect_calendar_entry (tenant_id, status, due_on);
CREATE INDEX effect_calendar_entry_assessment_idx ON machvon.effect_calendar_entry (tenant_id, assessment_id) WHERE assessment_id IS NOT NULL;
CREATE INDEX effect_calendar_entry_creator_idx ON machvon.effect_calendar_entry (tenant_id, created_by);

ALTER TABLE machvon.effect_assessment ADD CONSTRAINT effect_assessment_calendar_fk FOREIGN KEY (tenant_id, calendar_entry_id) REFERENCES machvon.effect_calendar_entry (tenant_id, id);

-- An entry is closed once, by the assessment of its kind, and never moves its day or its rule afterwards.
CREATE FUNCTION machvon.guard_effect_calendar_entry() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.due_on IS DISTINCT FROM OLD.due_on OR NEW.anchor_on IS DISTINCT FROM OLD.anchor_on
     OR NEW.rule_version IS DISTINCT FROM OLD.rule_version OR NEW.months IS DISTINCT FROM OLD.months THEN
    RAISE EXCEPTION 'the day and the rule of a calendar entry never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DONE' THEN
    RAISE EXCEPTION 'a calendar entry that was closed is never changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER effect_calendar_entry_guard BEFORE UPDATE ON machvon.effect_calendar_entry FOR EACH ROW EXECUTE FUNCTION machvon.guard_effect_calendar_entry();
CREATE TRIGGER effect_calendar_entry_no_delete BEFORE DELETE ON machvon.effect_calendar_entry FOR EACH ROW EXECUTE FUNCTION machvon.mr1_effect_forbid_change();
CREATE TRIGGER effect_calendar_entry_no_truncate BEFORE TRUNCATE ON machvon.effect_calendar_entry FOR EACH STATEMENT EXECUTE FUNCTION machvon.mr1_effect_forbid_change();

ALTER TABLE machvon.effect_measurement ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.effect_measurement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.effect_measurement AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.effect_measurement AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.effect_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.effect_assessment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.effect_assessment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.effect_assessment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.effect_calendar_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.effect_calendar_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.effect_calendar_entry AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.effect_calendar_entry AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.effect_measurement FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.effect_assessment FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.effect_calendar_entry FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.effect_target_set FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.effect_indicator FROM machvon_app;

COMMENT ON TABLE machvon.effect_measurement IS 'MR-1 (MR.03): the actual value of an indicator on a day after the commissioning, append-only; a correction is a later row.';
COMMENT ON TABLE machvon.effect_assessment IS 'MR-1 (MR.03): the evaluation record with the variances frozen, decided by someone other than the one who submitted it.';
COMMENT ON TABLE machvon.effect_calendar_entry IS 'MR-1 (MR.03, G4-7): an evaluation due by the calendar of Articles 76 and 77 (a rule not yet verified), closed by the approved assessment of its kind.';

-- Authored by hand (not generated): ENT-4a (docs/plans/ent4a.md, docs/report-engine.md, section "Cross-report comparison"). The comparison of the reports of one period before release (HSKT CN.04).
--   * `report_figure_set`: the figures a draft was FILLED with (the strip and the project rows), recorded once when the draft is generated. Comparing the recorded fill data compares exactly what the files were made
--     from; it is never a second reading of the cells. Insert-only; a draft made before this lane has none.
--   * `report_crosscheck_explanation`: why a finding that blocks a release may nevertheless pass. One row per fingerprint of a finding (rule, figure, period and the values of its terms), so changed figures need a
--     new explanation. The explainer is never the preparer of any report the finding is about (a trigger checks the drafts and issued copies named in `involves`). Insert-only.
--   * `report_crosscheck_release`: the evidence kept with an issued copy: what was compared when it was released, the hash of the result, how many findings blocked, were explained, or were warnings. Insert-only,
--     one per issued copy.

CREATE TABLE machvon.report_figure_set (
  tenant_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  figures jsonb NOT NULL,
  rows jsonb NOT NULL,
  sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, draft_id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES machvon.report_draft (tenant_id, id),
  CONSTRAINT report_figure_set_shape_chk CHECK (jsonb_typeof(figures) = 'array' AND jsonb_typeof(rows) = 'array'),
  CONSTRAINT report_figure_set_hash_chk CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE machvon.report_crosscheck_explanation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fingerprint char(64) NOT NULL,
  rule_id text NOT NULL,
  figure_code text NOT NULL,
  period_code text NOT NULL,
  severity text NOT NULL,
  involves uuid[] NOT NULL,
  reason text NOT NULL,
  explained_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT report_crosscheck_explanation_fingerprint_uq UNIQUE (tenant_id, fingerprint),
  CONSTRAINT report_crosscheck_explanation_fingerprint_chk CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_crosscheck_explanation_rule_chk CHECK (rule_id ~ '^XR-[0-9]{2}$'),
  CONSTRAINT report_crosscheck_explanation_code_chk CHECK (figure_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT report_crosscheck_explanation_period_chk CHECK (period_code = btrim(period_code) AND period_code <> '' AND char_length(period_code) <= 20),
  CONSTRAINT report_crosscheck_explanation_severity_chk CHECK (severity IN ('BLOCKING', 'WARNING')),
  CONSTRAINT report_crosscheck_explanation_involves_chk CHECK (cardinality(involves) BETWEEN 1 AND 40),
  CONSTRAINT report_crosscheck_explanation_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 20 AND 2000)
);
CREATE INDEX report_crosscheck_explanation_period_idx ON machvon.report_crosscheck_explanation (tenant_id, period_code, created_at DESC, id);
CREATE INDEX report_crosscheck_explanation_by_idx ON machvon.report_crosscheck_explanation (tenant_id, explained_by);

CREATE TABLE machvon.report_crosscheck_release (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  period_code text NOT NULL,
  outcome text NOT NULL,
  result_sha256 char(64) NOT NULL,
  comparisons integer NOT NULL,
  skipped integer NOT NULL,
  blocking_explained integer NOT NULL,
  warnings integer NOT NULL,
  explained_fingerprints text[] NOT NULL DEFAULT '{}',
  released_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES machvon.report_issue (tenant_id, id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES machvon.report_draft (tenant_id, id),
  CONSTRAINT report_crosscheck_release_issue_uq UNIQUE (tenant_id, issue_id),
  CONSTRAINT report_crosscheck_release_outcome_chk CHECK (outcome IN ('PASSED', 'EXPLAINED')),
  CONSTRAINT report_crosscheck_release_hash_chk CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_crosscheck_release_counts_chk CHECK (comparisons >= 0 AND skipped >= 0 AND blocking_explained >= 0 AND warnings >= 0),
  CONSTRAINT report_crosscheck_release_outcome_counts_chk CHECK ((outcome = 'EXPLAINED') = (blocking_explained > 0) AND cardinality(explained_fingerprints) = blocking_explained)
);
CREATE INDEX report_crosscheck_release_period_idx ON machvon.report_crosscheck_release (tenant_id, period_code, created_at DESC, id);

CREATE FUNCTION machvon.guard_report_crosscheck_insert_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is insert-only (% by %)', TG_TABLE_NAME, TG_OP, current_user USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER report_figure_set_guard BEFORE UPDATE OR DELETE ON machvon.report_figure_set
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_report_crosscheck_insert_only();
CREATE TRIGGER report_figure_set_no_truncate BEFORE TRUNCATE ON machvon.report_figure_set
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_report_crosscheck_insert_only();
CREATE TRIGGER report_crosscheck_explanation_guard BEFORE UPDATE OR DELETE ON machvon.report_crosscheck_explanation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_report_crosscheck_insert_only();
CREATE TRIGGER report_crosscheck_explanation_no_truncate BEFORE TRUNCATE ON machvon.report_crosscheck_explanation
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_report_crosscheck_insert_only();
CREATE TRIGGER report_crosscheck_release_guard BEFORE UPDATE OR DELETE ON machvon.report_crosscheck_release
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_report_crosscheck_insert_only();
CREATE TRIGGER report_crosscheck_release_no_truncate BEFORE TRUNCATE ON machvon.report_crosscheck_release
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_report_crosscheck_insert_only();

-- Maker is not checker: whoever explains a finding prepared none of the drafts or issued copies it is about.
CREATE FUNCTION machvon.report_crosscheck_explanation_people() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM machvon.report_draft d WHERE d.tenant_id = NEW.tenant_id AND d.id = ANY (NEW.involves) AND d.prepared_by = NEW.explained_by)
     OR EXISTS (SELECT 1 FROM machvon.report_issue i WHERE i.tenant_id = NEW.tenant_id AND i.id = ANY (NEW.involves) AND i.prepared_by = NEW.explained_by) THEN
    RAISE EXCEPTION 'a finding is not explained by the person who prepared a report it is about' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER report_crosscheck_explanation_people BEFORE INSERT ON machvon.report_crosscheck_explanation
  FOR EACH ROW EXECUTE FUNCTION machvon.report_crosscheck_explanation_people();

ALTER TABLE machvon.report_figure_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_figure_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_figure_set AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_figure_set AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.report_crosscheck_explanation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_crosscheck_explanation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_crosscheck_explanation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_crosscheck_explanation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.report_crosscheck_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_crosscheck_release FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_crosscheck_release AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_crosscheck_release AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_figure_set FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_crosscheck_explanation FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_crosscheck_release FROM machvon_app;

COMMENT ON TABLE machvon.report_figure_set IS 'ENT-4a: the figures and project rows a report draft was filled with, recorded when the draft is generated (insert-only).';
COMMENT ON TABLE machvon.report_crosscheck_explanation IS 'ENT-4a: why a blocking finding of the cross-report comparison may pass; one per fingerprint; the explainer prepared none of the reports involved.';
COMMENT ON TABLE machvon.report_crosscheck_release IS 'ENT-4a: the evidence of the comparison kept with an issued copy: result hash and counts of findings that blocked, were explained, or warned.';

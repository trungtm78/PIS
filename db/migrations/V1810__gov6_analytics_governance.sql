-- Authored by hand (not generated): the three tables of the analytics governance of HOME and BI (G0-4 KPI register, G3-1 certified figures and datasets, G3-2 explainable red-amber-green; docs/governance-roadmap-10of10.md).
-- The definitions themselves (`KPI_DEFINITION`) and the thresholds (`RAG_THRESHOLDS`) are rules of `machvon.governance_rule` (V1850), never columns here. These tables keep only what people and the weekly job did:
--   analytics_certification  the life of the certification of a figure's definition or of a dataset (Nháp, Đã xác nhận, Đã chứng nhận, Lỗi thời): one line per move, never changed or removed;
--   early_warning_score      the score of a unit for a week with its breakdown (each factor, its value, its line, the points it added) and the versions of the rules that decided, written once for the week;
--   rag_override             a person's word against the colour the rules gave a unit: the reason in words and the last day, one line per decision, never changed or removed.
-- Row-level security, the maker who is not the checker, and append-only for the application are as in V1660.

CREATE TABLE machvon.analytics_certification (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- KPI: a `KPI_DEFINITION` code (subject_key) and the version of its rule (0 is the built-in default); DATASET: a `bi_dataset` id and its version.
  subject text NOT NULL CHECK (subject IN ('KPI', 'DATASET')),
  subject_key text NOT NULL CHECK (subject_key = btrim(subject_key) AND char_length(subject_key) BETWEEN 1 AND 64),
  version bigint NOT NULL CHECK (version >= 0),
  -- The order of the lines of one version; two writers racing for the same number lose to the unique index and retry.
  seq integer NOT NULL CHECK (seq >= 1),
  status text NOT NULL CHECK (status IN ('DRAFT', 'CONFIRMED', 'CERTIFIED', 'OBSOLETE')),
  actor_membership_id uuid NOT NULL,
  -- Who confirmed the version; the certifier is somebody else.
  confirmed_by_membership_id uuid,
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 500)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_by_membership_id) REFERENCES machvon.membership (tenant_id, id),
  -- Sending a version back to Nháp or making it Lỗi thời is said in words; a certificate is a second pair of eyes.
  CONSTRAINT analytics_certification_note_chk CHECK (status NOT IN ('DRAFT', 'OBSOLETE') OR (note IS NOT NULL AND char_length(note) >= 5)),
  CONSTRAINT analytics_certification_confirmed_chk CHECK (status <> 'CONFIRMED' OR confirmed_by_membership_id = actor_membership_id),
  CONSTRAINT analytics_certification_sod_chk CHECK (status <> 'CERTIFIED' OR (confirmed_by_membership_id IS NOT NULL AND confirmed_by_membership_id <> actor_membership_id))
);

CREATE UNIQUE INDEX analytics_certification_seq_uq ON machvon.analytics_certification (tenant_id, subject, subject_key, version, seq);
CREATE INDEX analytics_certification_subject_idx ON machvon.analytics_certification (tenant_id, subject, subject_key, created_at DESC, id);

CREATE TABLE machvon.early_warning_score (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- The Monday of the week of the snapshot's day: one row for a unit and a week.
  week_start date NOT NULL,
  unit_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  as_of_date date NOT NULL,
  -- 0 (nothing wrong) to 100; null when too little of the data was there for a score to mean anything (the band then is NO_DATA, never green and never zero).
  score numeric(5, 2) CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  band text NOT NULL CHECK (band IN ('GREEN', 'AMBER', 'RED', 'NO_DATA')),
  coverage_pct numeric(5, 2) NOT NULL CHECK (coverage_pct >= 0 AND coverage_pct <= 100),
  critical_warnings integer CHECK (critical_warnings IS NULL OR critical_warnings >= 0),
  overdue_explanations integer CHECK (overdue_explanations IS NULL OR overdue_explanations >= 0),
  -- Each factor with its value, its line, its weight and the points it added, the reasons, and the figures the factors were read from.
  breakdown jsonb NOT NULL CHECK (jsonb_typeof(breakdown) = 'object'),
  -- The version of each rule that decided (0 is a built-in default), so the colour of a week can be explained after the rules change.
  rule_versions jsonb NOT NULL CHECK (jsonb_typeof(rule_versions) = 'object'),
  unverified boolean NOT NULL DEFAULT true,
  computed_by uuid NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  CONSTRAINT early_warning_score_band_chk CHECK ((band = 'NO_DATA') = (score IS NULL))
);

CREATE UNIQUE INDEX early_warning_score_week_uq ON machvon.early_warning_score (tenant_id, week_start, unit_id);
CREATE INDEX early_warning_score_unit_idx ON machvon.early_warning_score (tenant_id, unit_id, week_start DESC);

CREATE TABLE machvon.rag_override (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,
  -- SET puts a colour over the rules' own for a while; REVOKE takes it back before its last day.
  action text NOT NULL CHECK (action IN ('SET', 'REVOKE')),
  band text CHECK (band IS NULL OR band IN ('GREEN', 'AMBER', 'RED')),
  -- The colour the rules gave when the word was said, kept so the two are never confused.
  rule_band text CHECK (rule_band IS NULL OR rule_band IN ('GREEN', 'AMBER', 'RED', 'NO_DATA')),
  until date,
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 500),
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT rag_override_shape_chk CHECK (
    (action = 'SET' AND band IS NOT NULL AND until IS NOT NULL AND rule_band IS NOT NULL)
    OR (action = 'REVOKE' AND band IS NULL AND until IS NULL)
  )
);

CREATE INDEX rag_override_unit_idx ON machvon.rag_override (tenant_id, unit_id, created_at DESC, id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['analytics_certification', 'early_warning_score', 'rag_override'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    -- Append-only for the application: a line is added, never edited or taken back (a later line replaces it in what a reader is shown).
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.%I FROM machvon_app', t);
  END LOOP;
END $$;

COMMENT ON TABLE machvon.analytics_certification IS 'The life of the certification of a KPI definition or a dataset (Nháp, Đã xác nhận, Đã chứng nhận, Lỗi thời); append-only, the latest line of a version decides.';
COMMENT ON TABLE machvon.early_warning_score IS 'The early-warning score of a unit for a week with the breakdown of each factor and the rule versions that decided; written once for a week, never changed.';
COMMENT ON TABLE machvon.rag_override IS 'A person''s override of the colour the rules gave a unit, with the reason and the last day; append-only, the latest line of a unit decides.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX analytics_certification_actor_membership_idx ON machvon.analytics_certification (tenant_id, actor_membership_id);
CREATE INDEX analytics_certification_confirmed_by_membership_idx ON machvon.analytics_certification (tenant_id, confirmed_by_membership_id) WHERE confirmed_by_membership_id IS NOT NULL;
CREATE INDEX early_warning_score_snapshot_idx ON machvon.early_warning_score (tenant_id, snapshot_id);
CREATE INDEX rag_override_actor_membership_idx ON machvon.rag_override (tenant_id, actor_membership_id);

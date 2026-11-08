-- Authored by hand (not generated): the decision log of the leader (G3-6 of docs/governance-roadmap-10of10.md, GOV-11b).
--   analytics_decision          a decision about a figure of the command center (HOME-03), an urgent alert or a free subject, with the reason in words and the FIGURES AS THEY WERE at the moment of the decision
--                               (taken by the server from what the leader sees, kept with their digest), one line per decision, never changed or removed;
--   analytics_decision_outcome  what became of a decision, one line per move (RESOLVED, STILL_OPEN, SUPERSEDED), never changed or removed.
-- The kinds of decision, the length of the reason and how far a follow-up may be are the rule `DECISION_POLICY` of `machvon.governance_rule`, never columns here. Row-level security and append-only for the application are as in V1810.

CREATE TABLE machvon.analytics_decision (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK (subject_kind IN ('KPI_TILE', 'URGENT_ALERT', 'FREE')),
  -- KPI_TILE: the code of the figure and the unit it was read for (null: the whole scope of the reader); URGENT_ALERT: the work source and the id of the item; FREE: the words of the subject.
  metric_code text CHECK (metric_code IS NULL OR metric_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  unit_id uuid,
  work_source text CHECK (work_source IS NULL OR work_source ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  work_source_id text CHECK (work_source_id IS NULL OR (work_source_id = btrim(work_source_id) AND char_length(work_source_id) BETWEEN 1 AND 128)),
  subject_title text CHECK (subject_title IS NULL OR (subject_title = btrim(subject_title) AND char_length(subject_title) BETWEEN 3 AND 200)),
  decision_kind text NOT NULL CHECK (decision_kind ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 4000),
  -- The figures at the moment of the decision, as the leader saw them, and their digest (sha-256 of the canonical JSON), the snapshot they were read from and the versions of the rules that decided.
  figures jsonb NOT NULL CHECK (jsonb_typeof(figures) = 'object'),
  figures_sha256 text NOT NULL CHECK (figures_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_id uuid,
  as_of_date date,
  rule_versions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rule_versions) = 'object'),
  unverified boolean NOT NULL DEFAULT true,
  follow_up_owner_id uuid,
  follow_up_due date,
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  FOREIGN KEY (tenant_id, follow_up_owner_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT analytics_decision_subject_chk CHECK (
    (subject_kind = 'KPI_TILE' AND metric_code IS NOT NULL AND work_source IS NULL AND work_source_id IS NULL AND subject_title IS NULL)
    OR (subject_kind = 'URGENT_ALERT' AND work_source IS NOT NULL AND work_source_id IS NOT NULL AND metric_code IS NULL AND unit_id IS NULL AND subject_title IS NULL)
    OR (subject_kind = 'FREE' AND subject_title IS NOT NULL AND metric_code IS NULL AND work_source IS NULL AND work_source_id IS NULL)
  ),
  CONSTRAINT analytics_decision_follow_up_chk CHECK (follow_up_owner_id IS NULL OR follow_up_due IS NOT NULL)
);

CREATE INDEX analytics_decision_time_idx ON machvon.analytics_decision (tenant_id, decided_at DESC, id);
CREATE INDEX analytics_decision_metric_idx ON machvon.analytics_decision (tenant_id, subject_kind, metric_code, decided_at DESC) WHERE metric_code IS NOT NULL;
CREATE INDEX analytics_decision_work_idx ON machvon.analytics_decision (tenant_id, work_source, work_source_id, decided_at DESC) WHERE work_source IS NOT NULL;
CREATE INDEX analytics_decision_follow_up_idx ON machvon.analytics_decision (tenant_id, follow_up_due) WHERE follow_up_due IS NOT NULL;
CREATE INDEX analytics_decision_unit_idx ON machvon.analytics_decision (tenant_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX analytics_decision_snapshot_idx ON machvon.analytics_decision (tenant_id, snapshot_id) WHERE snapshot_id IS NOT NULL;
CREATE INDEX analytics_decision_owner_idx ON machvon.analytics_decision (tenant_id, follow_up_owner_id) WHERE follow_up_owner_id IS NOT NULL;
CREATE INDEX analytics_decision_decided_by_idx ON machvon.analytics_decision (tenant_id, decided_by);

CREATE TABLE machvon.analytics_decision_outcome (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('RESOLVED', 'STILL_OPEN', 'SUPERSEDED')),
  note text NOT NULL CHECK (note = btrim(note) AND char_length(note) BETWEEN 1 AND 1000),
  -- SUPERSEDED names the decision that replaces this one.
  superseded_by uuid,
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES machvon.analytics_decision (tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by) REFERENCES machvon.analytics_decision (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT analytics_decision_outcome_replacement_chk CHECK ((outcome = 'SUPERSEDED') = (superseded_by IS NOT NULL) AND (superseded_by IS NULL OR superseded_by <> decision_id))
);

CREATE INDEX analytics_decision_outcome_decision_idx ON machvon.analytics_decision_outcome (tenant_id, decision_id, created_at DESC, id);
CREATE INDEX analytics_decision_outcome_replacement_idx ON machvon.analytics_decision_outcome (tenant_id, superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX analytics_decision_outcome_actor_idx ON machvon.analytics_decision_outcome (tenant_id, actor_membership_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['analytics_decision', 'analytics_decision_outcome'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    -- Append-only for the application: a decision and an outcome are added, never edited or taken back (a correction is a later outcome).
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.%I FROM machvon_app', t);
  END LOOP;
END $$;

COMMENT ON TABLE machvon.analytics_decision IS 'A decision of a leader about a figure, an urgent alert or a subject, with the reason and the figures frozen at that moment (with their digest); append-only.';
COMMENT ON TABLE machvon.analytics_decision_outcome IS 'What became of a decision: resolved, still open or superseded by another; append-only, the latest line of a decision decides what a reader is shown.';

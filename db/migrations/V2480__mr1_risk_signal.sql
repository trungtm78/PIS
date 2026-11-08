-- Authored by hand (not generated): the risk register scored from live signals (MR-1, MR.02, G1-14; docs/prj-risk-signals.md).
-- The register of PRJ-16 (`project_risk`) holds the risks that people write. This adds what the job `risk-rescore` writes from the facts of the system:
--   * `project_risk_signal`: one line for each project and each kind of signal (schedule delay, payment integrity, claims and early warnings, funding gap, procurement delay), re-scored by the job; the score is
--     likelihood x impact on the same 1 to 5 scales as the register, the evidence and the version of the rule that decided are kept on the line.
--   * `project_risk_score_history`: every score of a signal line and of a register risk, append-only (nothing is updated or deleted, for any role); a register risk gets its row from a trigger, so the history
--     of the whole register is in one place whichever command moved the score.
--   * `project_risk_alert`: raised when a score crosses a threshold of the rule `RISK_SIGNAL_POLICY` upwards (alert types RISK_SCORE_CRITICAL, RISK_SCORE_JUMP); acknowledged by a person with a note.
-- The thresholds are in the governance rule, never in this file.

CREATE TABLE machvon.project_risk_signal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  signal_kind text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  likelihood smallint NOT NULL,
  impact smallint NOT NULL,
  score smallint GENERATED ALWAYS AS (likelihood * impact) STORED,
  -- What the score was read from: the figures, each with its unit and whether it could be known (an unknown figure is null, never zero).
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The version of the rule RISK_SIGNAL_POLICY that decided ('built-in:1' for the starting value nobody approved) and whether its numbers are not yet confirmed.
  rule_version text NOT NULL,
  rule_unverified boolean NOT NULL DEFAULT true,
  first_scored_on date NOT NULL,
  last_scored_on date NOT NULL,
  cleared_on date,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT project_risk_signal_kind_chk CHECK (signal_kind IN ('SCHEDULE_DELAY', 'PAYMENT_INTEGRITY', 'CLAIM_EARLY_WARNING', 'FUNDING_GAP', 'PROCUREMENT_DELAY')),
  CONSTRAINT project_risk_signal_status_chk CHECK (status IN ('ACTIVE', 'CLEARED')),
  CONSTRAINT project_risk_signal_scale_chk CHECK (likelihood BETWEEN 1 AND 5 AND impact BETWEEN 1 AND 5),
  CONSTRAINT project_risk_signal_evidence_chk CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT project_risk_signal_cleared_chk CHECK ((status = 'CLEARED') = (cleared_on IS NOT NULL) AND (status <> 'CLEARED' OR likelihood = 1)),
  CONSTRAINT project_risk_signal_days_chk CHECK (last_scored_on >= first_scored_on AND (cleared_on IS NULL OR cleared_on >= first_scored_on)),
  CONSTRAINT project_risk_signal_version_chk CHECK (version >= 1),
  CONSTRAINT project_risk_signal_uq UNIQUE (tenant_id, project_id, signal_kind)
);
CREATE INDEX project_risk_signal_board_idx ON machvon.project_risk_signal (tenant_id, status, signal_kind, project_id);

CREATE TABLE machvon.project_risk_score_history (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  subject_kind text NOT NULL,
  signal_id uuid,
  risk_id uuid,
  signal_kind text,
  source text NOT NULL,
  scored_on date NOT NULL,
  likelihood smallint NOT NULL,
  impact smallint NOT NULL,
  score smallint GENERATED ALWAYS AS (likelihood * impact) STORED,
  prior_score smallint,
  status text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_version text,
  -- No foreign key on the author: the job writes as the worker, who is not a member of any tenant (like computed_by of the early-warning score).
  scored_by uuid NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, signal_id) REFERENCES machvon.project_risk_signal (tenant_id, id),
  FOREIGN KEY (tenant_id, risk_id) REFERENCES machvon.project_risk (tenant_id, id),
  CONSTRAINT project_risk_score_history_subject_chk CHECK (
    (subject_kind = 'SIGNAL' AND signal_id IS NOT NULL AND risk_id IS NULL AND signal_kind IS NOT NULL AND source = 'JOB')
    OR (subject_kind = 'REGISTER' AND risk_id IS NOT NULL AND signal_id IS NULL AND signal_kind IS NULL AND source = 'MANUAL')
  ),
  CONSTRAINT project_risk_score_history_scale_chk CHECK (likelihood BETWEEN 1 AND 5 AND impact BETWEEN 1 AND 5 AND (prior_score IS NULL OR prior_score BETWEEN 1 AND 25)),
  CONSTRAINT project_risk_score_history_evidence_chk CHECK (jsonb_typeof(evidence) = 'object')
);
CREATE INDEX project_risk_score_history_project_idx ON machvon.project_risk_score_history (tenant_id, project_id, scored_at DESC, id DESC);
CREATE INDEX project_risk_score_history_signal_idx ON machvon.project_risk_score_history (tenant_id, signal_id, scored_at DESC, id DESC) WHERE signal_id IS NOT NULL;
CREATE INDEX project_risk_score_history_risk_idx ON machvon.project_risk_score_history (tenant_id, risk_id, scored_at DESC, id DESC) WHERE risk_id IS NOT NULL;

CREATE FUNCTION machvon.mr1_forbid_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER project_risk_score_history_immutable BEFORE UPDATE OR DELETE ON machvon.project_risk_score_history FOR EACH ROW EXECUTE FUNCTION machvon.mr1_forbid_change();
CREATE TRIGGER project_risk_score_history_no_truncate BEFORE TRUNCATE ON machvon.project_risk_score_history FOR EACH STATEMENT EXECUTE FUNCTION machvon.mr1_forbid_change();

-- The score of a risk that a person writes is history too: a row when the risk is written and one each time its likelihood or its impact changes.
CREATE FUNCTION machvon.project_risk_score_history_row() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.likelihood = OLD.likelihood AND NEW.impact = OLD.impact THEN
    RETURN NEW;
  END IF;
  INSERT INTO machvon.project_risk_score_history (tenant_id, project_id, subject_kind, risk_id, source, scored_on, likelihood, impact, prior_score, status, scored_by)
  VALUES (NEW.tenant_id, NEW.project_id, 'REGISTER', NEW.id, 'MANUAL', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, NEW.likelihood, NEW.impact,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.score ELSE NULL END, NEW.status, NEW.updated_by);
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_risk_score_history_after AFTER INSERT OR UPDATE OF likelihood, impact ON machvon.project_risk FOR EACH ROW EXECUTE FUNCTION machvon.project_risk_score_history_row();

CREATE TABLE machvon.project_risk_alert (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  alert_type text NOT NULL,
  subject_kind text NOT NULL,
  signal_id uuid,
  risk_id uuid,
  subject_id uuid GENERATED ALWAYS AS (COALESCE(signal_id, risk_id)) STORED,
  signal_kind text,
  score smallint NOT NULL,
  prior_score smallint NOT NULL,
  -- The line of the rule that was crossed: the critical score, or the points of the jump.
  threshold integer NOT NULL,
  rule_version text NOT NULL,
  rule_unverified boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'OPEN',
  raised_on date NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  raised_by uuid NOT NULL,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  acknowledge_note text,
  resolved_on date,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, signal_id) REFERENCES machvon.project_risk_signal (tenant_id, id),
  FOREIGN KEY (tenant_id, risk_id) REFERENCES machvon.project_risk (tenant_id, id),
  FOREIGN KEY (tenant_id, acknowledged_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_risk_alert_type_chk CHECK (alert_type IN ('RISK_SCORE_CRITICAL', 'RISK_SCORE_JUMP')),
  CONSTRAINT project_risk_alert_subject_chk CHECK (
    (subject_kind = 'SIGNAL' AND signal_id IS NOT NULL AND risk_id IS NULL AND signal_kind IS NOT NULL)
    OR (subject_kind = 'REGISTER' AND risk_id IS NOT NULL AND signal_id IS NULL AND signal_kind IS NULL)
  ),
  CONSTRAINT project_risk_alert_status_chk CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  CONSTRAINT project_risk_alert_score_chk CHECK (score BETWEEN 1 AND 25 AND prior_score BETWEEN 0 AND 25 AND score > prior_score AND threshold >= 1),
  CONSTRAINT project_risk_alert_ack_chk CHECK (
    (status = 'OPEN' AND acknowledged_by IS NULL AND acknowledged_at IS NULL AND acknowledge_note IS NULL)
    OR (status = 'ACKNOWLEDGED' AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL AND acknowledge_note = btrim(acknowledge_note) AND char_length(acknowledge_note) BETWEEN 1 AND 2000)
    OR (status = 'RESOLVED' AND resolved_on IS NOT NULL)
  ),
  CONSTRAINT project_risk_alert_version_chk CHECK (version >= 1)
);
-- One alert for a subject, a type and a day, so a pass run twice raises it once; and one standing critical alert at a time for a subject (it ends when the score falls below the line).
CREATE UNIQUE INDEX project_risk_alert_day_uq ON machvon.project_risk_alert (tenant_id, alert_type, subject_id, raised_on);
CREATE UNIQUE INDEX project_risk_alert_standing_uq ON machvon.project_risk_alert (tenant_id, subject_id) WHERE alert_type = 'RISK_SCORE_CRITICAL' AND status <> 'RESOLVED';
CREATE INDEX project_risk_alert_project_idx ON machvon.project_risk_alert (tenant_id, project_id, status, raised_at DESC);
CREATE INDEX project_risk_alert_signal_idx ON machvon.project_risk_alert (tenant_id, signal_id) WHERE signal_id IS NOT NULL;
CREATE INDEX project_risk_alert_risk_idx ON machvon.project_risk_alert (tenant_id, risk_id) WHERE risk_id IS NOT NULL;
CREATE INDEX project_risk_alert_ack_idx ON machvon.project_risk_alert (tenant_id, acknowledged_by) WHERE acknowledged_by IS NOT NULL;

-- What an alert says (its score, its subject, when it was raised) never changes (the subject is compared by its two columns: a generated column is not yet computed in a BEFORE trigger); it moves OPEN -> ACKNOWLEDGED -> RESOLVED, or OPEN -> RESOLVED, and a resolved one is final.
CREATE FUNCTION machvon.guard_project_risk_alert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved risk alert is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.alert_type IS DISTINCT FROM OLD.alert_type OR NEW.signal_id IS DISTINCT FROM OLD.signal_id OR NEW.risk_id IS DISTINCT FROM OLD.risk_id OR NEW.score IS DISTINCT FROM OLD.score
     OR NEW.prior_score IS DISTINCT FROM OLD.prior_score OR NEW.threshold IS DISTINCT FROM OLD.threshold OR NEW.raised_on IS DISTINCT FROM OLD.raised_on OR NEW.raised_at IS DISTINCT FROM OLD.raised_at THEN
    RAISE EXCEPTION 'what a risk alert says never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'OPEN' THEN
    RAISE EXCEPTION 'an acknowledged risk alert is not opened again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_risk_alert_guard BEFORE UPDATE ON machvon.project_risk_alert FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_risk_alert();
CREATE TRIGGER project_risk_alert_no_delete BEFORE DELETE ON machvon.project_risk_alert FOR EACH ROW EXECUTE FUNCTION machvon.mr1_forbid_change();
CREATE TRIGGER project_risk_alert_no_truncate BEFORE TRUNCATE ON machvon.project_risk_alert FOR EACH STATEMENT EXECUTE FUNCTION machvon.mr1_forbid_change();

ALTER TABLE machvon.project_risk_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_risk_signal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_risk_signal AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_risk_signal AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.project_risk_score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_risk_score_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_risk_score_history AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_risk_score_history AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.project_risk_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_risk_alert FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_risk_alert AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_risk_alert AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_risk_signal FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.project_risk_score_history FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_risk_alert FROM machvon_app;

COMMENT ON TABLE machvon.project_risk_signal IS 'MR-1: the risk lines the job risk-rescore scores from live signals, one for each project and kind of signal.';
COMMENT ON TABLE machvon.project_risk_score_history IS 'MR-1: every score of a signal line and of a register risk, append-only.';
COMMENT ON TABLE machvon.project_risk_alert IS 'MR-1: a risk score that crossed a line of the rule RISK_SIGNAL_POLICY; alert types RISK_SCORE_CRITICAL and RISK_SCORE_JUMP.';

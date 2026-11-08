-- Authored by hand (not generated): the baseline of a project, the count of the moves of its dates, the alert to the auditors and the request to appraise again (governance deepening, lane B1, G1-3).
-- Version 0 of the baseline is taken once from the approved work breakdown and the baseline days of the milestones and never changes; every approved revision of the investment total or the schedule adds the next
-- version. The deviation is always measured against version 0, so a plan that was corrected again and again cannot hide how late or how dear it became. Every later move of a date is a row of an append-only
-- table, and the count of those rows is what raises an alert to the auditors (the threshold is a governance rule, BASELINE_DEVIATION, whose version is kept with the alert). When the deviation passes the
-- thresholds one request to appraise again is open for the project, and it is decided (START or WAIVE) by someone other than the person whose change made it necessary.

CREATE TABLE machvon.project_baseline (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  kind text NOT NULL CHECK (kind IN ('V0', 'REVISION')),
  -- Which days the finish of a line was read from: the baseline days of the milestones for version 0, the planned days for a later version.
  basis text NOT NULL CHECK (basis IN ('BASELINE', 'PLANNED')),
  total_investment_vnd numeric(24,0) NOT NULL CHECK (total_investment_vnd >= 0),
  bac_vnd numeric(24,0) NOT NULL CHECK (bac_vnd >= 0),
  planned_start date NOT NULL,
  planned_finish date NOT NULL,
  source_revision_id uuid,
  taken_by uuid NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_baseline_version_uq UNIQUE (tenant_id, project_id, version),
  CONSTRAINT project_baseline_scope_uq UNIQUE (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, source_revision_id) REFERENCES machvon.project_revision (tenant_id, id),
  FOREIGN KEY (tenant_id, taken_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_baseline_days_chk CHECK (planned_finish >= planned_start),
  CONSTRAINT project_baseline_kind_chk CHECK ((kind = 'V0') = (version = 0) AND (kind = 'V0') = (source_revision_id IS NULL) AND (kind = 'V0') = (basis = 'BASELINE'))
);

CREATE TABLE machvon.project_baseline_line (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  baseline_id uuid NOT NULL,
  project_id uuid NOT NULL,
  component_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  bac_vnd numeric(24,0) NOT NULL CHECK (bac_vnd >= 0),
  planned_start date NOT NULL,
  planned_finish date NOT NULL,
  -- The curve the value is spread on between the two days. Only the straight one exists today; the column leaves room for another without a migration.
  curve text NOT NULL DEFAULT 'LINEAR' CHECK (curve IN ('LINEAR')),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_baseline_line_component_uq UNIQUE (tenant_id, baseline_id, component_id),
  FOREIGN KEY (tenant_id, project_id, baseline_id) REFERENCES machvon.project_baseline (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, component_id) REFERENCES machvon.project_component (tenant_id, project_id, id),
  CONSTRAINT project_baseline_line_days_chk CHECK (planned_finish >= planned_start)
);

CREATE INDEX project_baseline_line_baseline_idx ON machvon.project_baseline_line (tenant_id, baseline_id);

-- A version is numbered after the one before it: version 0 first, then 1, 2, ... without a gap, whoever writes it.
CREATE FUNCTION machvon.guard_project_baseline_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.version > 0 AND NOT EXISTS (SELECT 1 FROM machvon.project_baseline b WHERE b.tenant_id = NEW.tenant_id AND b.project_id = NEW.project_id AND b.version = NEW.version - 1) THEN
    RAISE EXCEPTION 'a baseline version follows the one before it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_baseline_insert_guard BEFORE INSERT ON machvon.project_baseline
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_baseline_insert();

-- A baseline is never edited or removed, by the application or by anyone with a statement: version 0 above all.
CREATE FUNCTION machvon.forbid_gov3_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER project_baseline_immutable BEFORE UPDATE OR DELETE ON machvon.project_baseline FOR EACH ROW EXECUTE FUNCTION machvon.forbid_gov3_change();
CREATE TRIGGER project_baseline_no_truncate BEFORE TRUNCATE ON machvon.project_baseline FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_gov3_change();
CREATE TRIGGER project_baseline_line_immutable BEFORE UPDATE OR DELETE ON machvon.project_baseline_line FOR EACH ROW EXECUTE FUNCTION machvon.forbid_gov3_change();
CREATE TRIGGER project_baseline_line_no_truncate BEFORE TRUNCATE ON machvon.project_baseline_line FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_gov3_change();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.project_baseline FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.project_baseline_line FROM machvon_app;

-- Every move of a date to a later day, one row each, with the day it was and the day it became. A milestone that is delayed again is one more row; an approved revision that pushes the end year back is one row too.
CREATE TABLE machvon.project_reschedule_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('MILESTONE', 'REVISION')),
  milestone_id uuid,
  revision_id uuid,
  from_date date NOT NULL,
  to_date date NOT NULL,
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, milestone_id) REFERENCES machvon.project_milestone (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, revision_id) REFERENCES machvon.project_revision (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_reschedule_event_later_chk CHECK (to_date > from_date),
  CONSTRAINT project_reschedule_event_source_chk CHECK ((source = 'MILESTONE') = (milestone_id IS NOT NULL) AND (source = 'REVISION') = (revision_id IS NOT NULL))
);

CREATE INDEX project_reschedule_event_project_idx ON machvon.project_reschedule_event (tenant_id, project_id, recorded_at);
CREATE UNIQUE INDEX project_reschedule_event_revision_uq ON machvon.project_reschedule_event (tenant_id, revision_id) WHERE revision_id IS NOT NULL;

CREATE TRIGGER project_reschedule_event_immutable BEFORE UPDATE OR DELETE ON machvon.project_reschedule_event FOR EACH ROW EXECUTE FUNCTION machvon.forbid_gov3_change();
CREATE TRIGGER project_reschedule_event_no_truncate BEFORE TRUNCATE ON machvon.project_reschedule_event FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_gov3_change();
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.project_reschedule_event FROM machvon_app;

-- An alert to the auditors: a date was moved as many times as the rule says. One is open at a time for the same subject; the auditor acknowledges it, and not the person whose delay raised it.
CREATE TABLE machvon.project_governance_alert (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  alert_type text NOT NULL CHECK (alert_type IN ('RESCHEDULE_COUNT')),
  audience text NOT NULL CHECK (audience IN ('AUD')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('MILESTONE', 'PROJECT')),
  subject_id uuid,
  move_count integer NOT NULL CHECK (move_count >= 1),
  threshold integer NOT NULL CHECK (threshold >= 1),
  -- The version of the rule BASELINE_DEVIATION that decided ('built-in:1' for the starting value nobody approved).
  rule_version text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED')),
  raised_by uuid NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  acknowledge_note text CHECK (acknowledge_note IS NULL OR (acknowledge_note = btrim(acknowledge_note) AND char_length(acknowledge_note) BETWEEN 1 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, subject_id) REFERENCES machvon.project_milestone (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, raised_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, acknowledged_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_governance_alert_subject_chk CHECK ((subject_kind = 'MILESTONE') = (subject_id IS NOT NULL)),
  CONSTRAINT project_governance_alert_ack_chk CHECK (
    (status = 'OPEN' AND acknowledged_by IS NULL AND acknowledged_at IS NULL AND acknowledge_note IS NULL)
    OR (status = 'ACKNOWLEDGED' AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL AND acknowledge_note IS NOT NULL AND acknowledged_by <> raised_by)
  )
);

CREATE UNIQUE INDEX project_governance_alert_open_uq ON machvon.project_governance_alert (tenant_id, project_id, alert_type, subject_kind, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'OPEN';
CREATE INDEX project_governance_alert_audience_idx ON machvon.project_governance_alert (tenant_id, audience, status, raised_at);

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_governance_alert FROM machvon_app;
CREATE TRIGGER project_governance_alert_no_delete BEFORE DELETE ON machvon.project_governance_alert FOR EACH ROW EXECUTE FUNCTION machvon.forbid_gov3_change();
CREATE TRIGGER project_governance_alert_no_truncate BEFORE TRUNCATE ON machvon.project_governance_alert FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_gov3_change();

-- The request to appraise again: the deviation from version 0 passed a threshold of the rule. One is open for a project at a time. It is decided START (the investor takes the project back to appraisal) or WAIVE
-- (the deviation is accepted, with the reason), by someone other than the person whose change brought the deviation over the line.
CREATE TABLE machvon.project_reappraisal_request (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  baseline_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'STARTED', 'WAIVED')),
  reasons text[] NOT NULL CHECK (cardinality(reasons) >= 1 AND reasons <@ ARRAY['COST', 'SLIP']::text[]),
  cost_pct numeric(14,4),
  finish_slip_days integer,
  threshold_cost_pct numeric(14,4) NOT NULL,
  threshold_slip_days integer NOT NULL,
  rule_version text NOT NULL,
  triggered_by text NOT NULL CHECK (triggered_by IN ('REVISION', 'MILESTONE')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 1 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, baseline_id) REFERENCES machvon.project_baseline (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_reappraisal_decision_chk CHECK (
    (status = 'OPEN' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status IN ('STARTED', 'WAIVED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND decided_by <> requested_by)
  )
);

CREATE UNIQUE INDEX project_reappraisal_open_uq ON machvon.project_reappraisal_request (tenant_id, project_id) WHERE status = 'OPEN';
CREATE INDEX project_reappraisal_project_idx ON machvon.project_reappraisal_request (tenant_id, project_id, requested_at);

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_reappraisal_request FROM machvon_app;
CREATE TRIGGER project_reappraisal_no_delete BEFORE DELETE ON machvon.project_reappraisal_request FOR EACH ROW EXECUTE FUNCTION machvon.forbid_gov3_change();
CREATE TRIGGER project_reappraisal_no_truncate BEFORE TRUNCATE ON machvon.project_reappraisal_request FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_gov3_change();

-- What a request or an alert decided and who asked never change afterwards.
CREATE FUNCTION machvon.guard_gov3_decided() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION '% that was decided is never changed', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_reappraisal_decided_guard BEFORE UPDATE ON machvon.project_reappraisal_request FOR EACH ROW EXECUTE FUNCTION machvon.guard_gov3_decided();
CREATE TRIGGER project_governance_alert_decided_guard BEFORE UPDATE ON machvon.project_governance_alert FOR EACH ROW EXECUTE FUNCTION machvon.guard_gov3_decided();

DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_baseline', 'project_baseline_line', 'project_reschedule_event', 'project_governance_alert', 'project_reappraisal_request'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END
$rls$;

COMMENT ON TABLE machvon.project_baseline IS 'A version of the baseline of a project: 0 is taken once and never changes, each approved revision of the total or the schedule adds the next. Append-only.';
COMMENT ON TABLE machvon.project_baseline_line IS 'The budget, start and finish of one first-level work package in one version of the baseline. Append-only.';
COMMENT ON TABLE machvon.project_reschedule_event IS 'Each move of a date to a later day (a milestone delayed, an end year pushed back by an approved revision): the count of these is what the auditors are told about. Append-only.';
COMMENT ON TABLE machvon.project_governance_alert IS 'An alert to an audience (AUD) raised by a rule of governance, one open at a time for the same subject; acknowledged by someone other than whoever raised it.';
COMMENT ON TABLE machvon.project_reappraisal_request IS 'The request to appraise a project again when its deviation from baseline version 0 passes the thresholds of the rule; decided START or WAIVE by someone other than the maker of the change.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX project_baseline_source_revision_idx ON machvon.project_baseline (tenant_id, source_revision_id) WHERE source_revision_id IS NOT NULL;
CREATE INDEX project_baseline_line_component_idx ON machvon.project_baseline_line (tenant_id, component_id);
CREATE INDEX project_baseline_line_project_idx ON machvon.project_baseline_line (tenant_id, project_id);
CREATE INDEX project_governance_alert_subject_idx ON machvon.project_governance_alert (tenant_id, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX project_reappraisal_request_baseline_idx ON machvon.project_reappraisal_request (tenant_id, baseline_id);
CREATE INDEX project_reschedule_event_milestone_idx ON machvon.project_reschedule_event (tenant_id, milestone_id) WHERE milestone_id IS NOT NULL;

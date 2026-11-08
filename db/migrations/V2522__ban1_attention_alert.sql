-- Authored by hand (not generated): what the committee decided about the projects that need the head, and the alerts of the committee (BAN-1, docs/committee-workspace.md).
-- `committee_attention_decision` is an append-only log: a project that appears on the list of attention is ACKNOWLEDGED (seen, with a note), DEFERRED (not looked at again until a day, with the reason), DIRECTED
-- (a directive of the steering meetings was given, named here) or REOPENED (put back on the list). The state of a project is its latest row. Nothing here changes the project, the money or the directive: it is the
-- record that the head saw it and what the head did, which the meeting pack and the audit read.
-- `committee_alert` holds the four alerts of the committee (province behind the curve, sector far behind, unit not reporting, directive overdue): one OPEN row per key while the condition holds, resolved by the
-- evaluation when it stops holding, acknowledged by a person with a note. The rows carry the version of the rule COMMITTEE_POLICY that decided and the figures it was judged on; they are state, not ledger.

CREATE TABLE machvon.committee_attention_decision (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ACKNOWLEDGED', 'DEFERRED', 'DIRECTED', 'REOPENED')),
  reasons text[] NOT NULL DEFAULT '{}'::text[],
  score numeric(6,2) CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  as_of date NOT NULL,
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 2000)),
  defer_until date,
  directive_id uuid,
  policy_version integer CHECK (policy_version IS NULL OR policy_version >= 0),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, directive_id) REFERENCES machvon.directive (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT committee_attention_shape_chk CHECK (
    (decision = 'ACKNOWLEDGED' AND note IS NOT NULL AND defer_until IS NULL AND directive_id IS NULL)
    OR (decision = 'DEFERRED' AND note IS NOT NULL AND defer_until IS NOT NULL AND defer_until > as_of AND directive_id IS NULL)
    OR (decision = 'DIRECTED' AND directive_id IS NOT NULL AND defer_until IS NULL)
    OR (decision = 'REOPENED' AND note IS NOT NULL AND defer_until IS NULL AND directive_id IS NULL)
  )
);

CREATE INDEX committee_attention_project_idx ON machvon.committee_attention_decision (tenant_id, project_id, decided_at DESC, id DESC);
CREATE INDEX committee_attention_recent_idx ON machvon.committee_attention_decision (tenant_id, decided_at DESC, id DESC);
CREATE INDEX committee_attention_directive_idx ON machvon.committee_attention_decision (tenant_id, directive_id) WHERE directive_id IS NOT NULL;
CREATE INDEX committee_attention_decided_by_idx ON machvon.committee_attention_decision (tenant_id, decided_by);

CREATE FUNCTION machvon.committee_attention_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the log of decisions on the attention list is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER committee_attention_guard BEFORE UPDATE OR DELETE ON machvon.committee_attention_decision FOR EACH ROW EXECUTE FUNCTION machvon.committee_attention_guard();

CREATE TABLE machvon.committee_alert (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  alert_type text NOT NULL CHECK (alert_type IN ('COMMITTEE_PROVINCE_BEHIND', 'COMMITTEE_SECTOR_BEHIND', 'COMMITTEE_UNIT_NOT_REPORTING', 'COMMITTEE_DIRECTIVE_OVERDUE')),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 200),
  subject_kind text NOT NULL CHECK (subject_kind IN ('PROVINCE', 'SECTOR', 'UNIT')),
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 100),
  subject_label text CHECK (subject_label IS NULL OR char_length(subject_label) <= 300),
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  value text,
  threshold text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  fiscal_year smallint NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2200),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  opened_on date NOT NULL,
  last_seen_on date NOT NULL,
  resolved_on date,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  acknowledged_note text CHECK (acknowledged_note IS NULL OR (acknowledged_note = btrim(acknowledged_note) AND char_length(acknowledged_note) BETWEEN 1 AND 2000)),
  policy_version integer CHECK (policy_version IS NULL OR policy_version >= 0),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, acknowledged_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT committee_alert_days_chk CHECK (last_seen_on >= opened_on AND (resolved_on IS NULL OR resolved_on >= opened_on)),
  CONSTRAINT committee_alert_state_chk CHECK (
    (status = 'OPEN' AND resolved_on IS NULL AND acknowledged_by IS NULL)
    OR (status = 'ACKNOWLEDGED' AND resolved_on IS NULL AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL AND acknowledged_note IS NOT NULL)
    OR (status = 'RESOLVED' AND resolved_on IS NOT NULL)
  )
);

CREATE UNIQUE INDEX committee_alert_open_uq ON machvon.committee_alert (tenant_id, dedupe_key) WHERE status <> 'RESOLVED';
CREATE INDEX committee_alert_status_idx ON machvon.committee_alert (tenant_id, status, severity, opened_on DESC);
CREATE INDEX committee_alert_type_idx ON machvon.committee_alert (tenant_id, alert_type, status);
CREATE INDEX committee_alert_ack_by_idx ON machvon.committee_alert (tenant_id, acknowledged_by) WHERE acknowledged_by IS NOT NULL;

CREATE FUNCTION machvon.committee_alert_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an alert of the committee is never removed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved alert of the committee is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.alert_type IS DISTINCT FROM OLD.alert_type OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key OR NEW.opened_on IS DISTINCT FROM OLD.opened_on OR NEW.subject_key IS DISTINCT FROM OLD.subject_key THEN
    RAISE EXCEPTION 'an alert of the committee keeps its type, key and day of opening' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER committee_alert_guard BEFORE UPDATE OR DELETE ON machvon.committee_alert FOR EACH ROW EXECUTE FUNCTION machvon.committee_alert_guard();

ALTER TABLE machvon.committee_attention_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.committee_attention_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.committee_attention_decision AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.committee_attention_decision AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.committee_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.committee_alert FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.committee_alert AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.committee_alert AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.committee_attention_decision FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.committee_alert FROM machvon_app;

COMMENT ON TABLE machvon.committee_attention_decision IS 'BAN-1: what the committee decided about a project on the attention list (acknowledged, deferred, directed, reopened); append-only.';
COMMENT ON TABLE machvon.committee_alert IS 'BAN-1: the alerts of the committee, one open row per key; resolved by the evaluation, acknowledged by a person with a note.';

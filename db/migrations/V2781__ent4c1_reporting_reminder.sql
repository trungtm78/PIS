-- Authored by hand (not generated): ENT-4c (QT.02). Every reminder that the job `calendar-reminder` makes about a step of the reporting schedule is a row here, appended and never changed, with the event of the outbox that carries it
-- written in the same transaction. A reminder that is sent and not recorded cannot be counted, capped or explained. `series_key` names the one reminder of a series (item, unit, step, kind, ordinal): a pass that runs twice, or two
-- processes that run it at once, record it once. `item_key` is the id of the reporting period or of the steering meeting, or `PLAN_ADJUSTMENT:<period code>` for the in-year plan adjustment. `unit_id` is the input point (null for a step
-- of the period as a whole). `rule_version` is the version of the governance rule `REPORTING_SCHEDULE` that fixed the deadline (0 for the built-in default).

CREATE TABLE machvon.reporting_reminder (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_kind text NOT NULL CHECK (item_kind IN ('REPORT_PERIOD', 'PLAN_ADJUSTMENT', 'MEETING')),
  item_key text NOT NULL CHECK (item_key = btrim(item_key) AND char_length(item_key) BETWEEN 1 AND 80),
  schedule_code text NOT NULL CHECK (schedule_code IN ('MONTH', 'QUARTER', 'YEAR', 'MEETING', 'PLAN_ADJUSTMENT')),
  unit_id uuid,
  step text NOT NULL CHECK (step IN ('ENTRY', 'UNIT_APPROVAL', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH')),
  kind text NOT NULL CHECK (kind IN ('BEFORE_DUE', 'OVERDUE', 'ESCALATED')),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  series_key text NOT NULL CHECK (series_key = btrim(series_key) AND char_length(series_key) BETWEEN 1 AND 240),
  alert_type text NOT NULL CHECK (alert_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  due_at timestamptz NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  CONSTRAINT reporting_reminder_series_uq UNIQUE (tenant_id, series_key)
);

CREATE INDEX reporting_reminder_item_idx ON machvon.reporting_reminder (tenant_id, item_key, step, created_at DESC, id);
CREATE INDEX reporting_reminder_unit_idx ON machvon.reporting_reminder (tenant_id, unit_id, created_at DESC) WHERE unit_id IS NOT NULL;

ALTER TABLE machvon.reporting_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.reporting_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.reporting_reminder AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.reporting_reminder AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.reporting_reminder FROM machvon_app;

COMMENT ON TABLE machvon.reporting_reminder IS 'Every reminder about a step of the reporting schedule (QT.02); append-only, one row per reminder of a series.';

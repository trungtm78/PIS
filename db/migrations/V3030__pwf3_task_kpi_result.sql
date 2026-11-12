-- Authored by hand (not generated): the result of one KPI of one task (PWF-3, docs PWF 6, BR-PWF-30 to 33, R34, R37).
-- A result is the value an operation of the closed catalogue gave on the facts of a task, the score the scale of the KPI set turned it into, the weight, and the hash of the facts the operation read, so that
-- a recomputation is proved to have had the same input. It is never edited or removed: a correction after the fact (the amount of a done task was corrected, a calendar was published) is a NEW row that names
-- the one it replaces (`supersedes_id`), and the period that was already locked keeps pointing at the row it was computed from. A task has one head per KPI: the row nobody supersedes.

CREATE TABLE machvon.task_kpi_result (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  -- A KPI_DEFINITION code (the set only references the register, R37) and the operation of the catalogue that computed it.
  kpi_code text NOT NULL CHECK (kpi_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  operation text NOT NULL CHECK (operation IN ('DAYS_DEVIATION', 'ON_TIME_RATE', 'AMOUNT_VARIANCE_PCT', 'RETURN_COUNT', 'EVIDENCE_COMPLETENESS', 'RESCHEDULE_COUNT')),
  -- The set that decided it: its code, the rule version (0 for the built-in default) and the rule row when the set was approved by the tenant.
  kpi_set_code text NOT NULL CHECK (kpi_set_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  kpi_set_rule_id uuid,
  kpi_set_version integer NOT NULL CHECK (kpi_set_version >= 0),
  state text NOT NULL CHECK (state IN ('OK', 'NOT_APPLICABLE', 'EXCLUDED', 'MISSING_FACT')),
  value numeric(24,4),
  score numeric(5,2) CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  weight numeric(8,2) NOT NULL CHECK (weight >= 0),
  -- The day the figure was read on: the day the task was closed for a done or cancelled one.
  as_of date NOT NULL,
  inputs_hash text NOT NULL CHECK (inputs_hash ~ '^[0-9a-f]{64}$'),
  -- What the operation read (facts, parameters, versions of the calendars): the source of the "i" button of a figure.
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  computed_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.project_task (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.task_kpi_result (tenant_id, id),
  -- A value and a score exist only for a figure that could be computed.
  CONSTRAINT task_kpi_result_value_chk CHECK ((state = 'OK') = (value IS NOT NULL)),
  CONSTRAINT task_kpi_result_score_chk CHECK (score IS NULL OR state = 'OK')
);

-- One row replaces another once (a straight line of corrections), and a task has one first row per KPI.
CREATE UNIQUE INDEX task_kpi_result_successor_uq ON machvon.task_kpi_result (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX task_kpi_result_root_uq ON machvon.task_kpi_result (tenant_id, task_id, kpi_code) WHERE supersedes_id IS NULL;
CREATE INDEX task_kpi_result_task_idx ON machvon.task_kpi_result (tenant_id, task_id, kpi_code, computed_at);
CREATE INDEX task_kpi_result_workflow_idx ON machvon.task_kpi_result (tenant_id, workflow_id, computed_at);
CREATE INDEX task_kpi_result_set_rule_idx ON machvon.task_kpi_result (tenant_id, kpi_set_rule_id) WHERE kpi_set_rule_id IS NOT NULL;

ALTER TABLE machvon.task_kpi_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.task_kpi_result FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.task_kpi_result AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.task_kpi_result AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.task_kpi_result FROM machvon_app;

CREATE TRIGGER task_kpi_result_immutable BEFORE UPDATE OR DELETE ON machvon.task_kpi_result
  FOR EACH ROW EXECUTE FUNCTION machvon.pwf_forbid_change();

COMMENT ON TABLE machvon.task_kpi_result IS 'The result of one KPI of one task (PWF-3, BR-PWF-30 to 33): value, score, weight and the hash of the facts read; append-only, a correction is a new row that supersedes the old.';

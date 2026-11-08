-- Authored by hand (not generated): the community monitoring file of a project (governance deepening, lane GOV-12, roadmap G4-8, Law 58/2024 articles 78-79, numbers UNVERIFIED).
-- One file for a project. It records what began the duty to notify the community (the investment decision, the start of the works, or a day fixed by hand with a reason), the days the rule gave AT THAT TIME (notice_days and the
-- version of the rule: a later change of the rule never moves a deadline that was already running), the notice when it was sent, and the pack of documents the notice is made of (V2601). Never deleted.

CREATE TABLE machvon.monitoring_file (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  trigger_kind text CHECK (trigger_kind IS NULL OR trigger_kind IN ('INVESTMENT_DECISION', 'WORKS_START', 'MANUAL')),
  trigger_on date,
  trigger_reason text CHECK (trigger_reason IS NULL OR (trigger_reason = btrim(trigger_reason) AND char_length(trigger_reason) BETWEEN 5 AND 1000)),
  notice_days integer CHECK (notice_days IS NULL OR notice_days BETWEEN 1 AND 365),
  notice_rule_version integer CHECK (notice_rule_version IS NULL OR notice_rule_version >= 0),
  notice_sent_on date,
  notice_sent_by uuid,
  notice_note text CHECK (notice_note IS NULL OR (notice_note = btrim(notice_note) AND char_length(notice_note) BETWEEN 1 AND 1000)),
  closed_at timestamptz,
  closed_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, notice_sent_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT monitoring_file_project_uq UNIQUE (tenant_id, project_id),
  CONSTRAINT monitoring_file_trigger_chk CHECK ((trigger_kind IS NULL) = (trigger_on IS NULL) AND (trigger_on IS NULL) = (notice_days IS NULL) AND (trigger_on IS NULL) = (notice_rule_version IS NULL)),
  CONSTRAINT monitoring_file_manual_chk CHECK (trigger_kind IS DISTINCT FROM 'MANUAL' OR trigger_reason IS NOT NULL),
  CONSTRAINT monitoring_file_sent_chk CHECK ((notice_sent_on IS NULL) = (notice_sent_by IS NULL) AND (notice_sent_on IS NULL OR (trigger_on IS NOT NULL AND notice_sent_on >= trigger_on))),
  CONSTRAINT monitoring_file_closed_chk CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (closed_by IS NULL))
);
CREATE INDEX monitoring_file_status_idx ON machvon.monitoring_file (tenant_id, status, trigger_on, id);
CREATE INDEX monitoring_file_sent_by_idx ON machvon.monitoring_file (tenant_id, notice_sent_by) WHERE notice_sent_by IS NOT NULL;
CREATE INDEX monitoring_file_closed_by_idx ON machvon.monitoring_file (tenant_id, closed_by) WHERE closed_by IS NOT NULL;
CREATE INDEX monitoring_file_created_by_idx ON machvon.monitoring_file (tenant_id, created_by);

ALTER TABLE machvon.monitoring_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.monitoring_file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.monitoring_file AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.monitoring_file AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.monitoring_file FROM machvon_app;

-- Once a trigger day is set it is not changed in place, and a sent notice is never changed.
CREATE FUNCTION machvon.monitoring_file_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.trigger_on IS NOT NULL AND (NEW.trigger_on IS DISTINCT FROM OLD.trigger_on OR NEW.notice_days IS DISTINCT FROM OLD.notice_days OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind) THEN
    RAISE EXCEPTION 'the day that began the duty of a monitoring file is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.notice_sent_on IS NOT NULL AND (NEW.notice_sent_on IS DISTINCT FROM OLD.notice_sent_on OR NEW.notice_sent_by IS DISTINCT FROM OLD.notice_sent_by) THEN
    RAISE EXCEPTION 'a sent notice is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'a monitoring file belongs to its project for good' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER monitoring_file_guard BEFORE UPDATE ON machvon.monitoring_file FOR EACH ROW EXECUTE FUNCTION machvon.monitoring_file_guard();

COMMENT ON TABLE machvon.monitoring_file IS 'Community monitoring file of a project: the day the duty to notify began, the days the rule gave at that time, the notice; deadlines never move with a later rule.';

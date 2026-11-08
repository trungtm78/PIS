-- Authored by hand (not generated): the feedback of the community on a project and the answer to it (GOV-12, G4-8). The days to answer are the days of the rule AT THE TIME the feedback was received (response_days and the
-- version of the rule), so the clock of one feedback never moves. The status moves along RECEIVED, IN_REVIEW, RESPONDED, CLOSED (the closer is not the responder), or to OUT_OF_SCOPE with a reason; every move is a row of
-- monitoring_feedback_event, appended and never changed. A feedback is a record of what the community said: it holds the summary written by the officer who received it and no identity of the sender beyond a free-text
-- label the officer chooses (a hamlet, a household group): the name and the contact of the sender are not columns.

CREATE TABLE machvon.monitoring_feedback (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL,
  reference text NOT NULL CHECK (reference = btrim(reference) AND char_length(reference) BETWEEN 1 AND 60),
  received_on date NOT NULL,
  channel text NOT NULL CHECK (channel IN ('LETTER', 'MEETING', 'HOTLINE', 'EMAIL', 'PORTAL')),
  topic text NOT NULL CHECK (topic IN ('QUALITY', 'SCHEDULE', 'COST', 'LAND', 'ENVIRONMENT', 'SAFETY', 'OTHER')),
  from_label text CHECK (from_label IS NULL OR (from_label = btrim(from_label) AND char_length(from_label) BETWEEN 1 AND 120)),
  summary text NOT NULL CHECK (summary = btrim(summary) AND char_length(summary) BETWEEN 10 AND 4000),
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'IN_REVIEW', 'RESPONDED', 'CLOSED', 'OUT_OF_SCOPE')),
  response_days integer NOT NULL CHECK (response_days BETWEEN 1 AND 365),
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  owner_membership_id uuid,
  response_text text CHECK (response_text IS NULL OR (response_text = btrim(response_text) AND char_length(response_text) BETWEEN 10 AND 4000)),
  responded_on date,
  responded_by uuid,
  closed_by uuid,
  closed_at timestamptz,
  declined_reason text CHECK (declined_reason IS NULL OR (declined_reason = btrim(declined_reason) AND char_length(declined_reason) BETWEEN 5 AND 1000)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES machvon.monitoring_file (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, responded_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT monitoring_feedback_reference_uq UNIQUE (tenant_id, file_id, reference),
  CONSTRAINT monitoring_feedback_responded_chk CHECK ((responded_on IS NULL) = (responded_by IS NULL) AND (responded_on IS NULL) = (response_text IS NULL) AND (responded_on IS NULL OR responded_on >= received_on)),
  CONSTRAINT monitoring_feedback_closed_chk CHECK ((closed_by IS NULL) = (closed_at IS NULL) AND (closed_by IS NULL OR (responded_by IS NOT NULL AND closed_by <> responded_by))),
  CONSTRAINT monitoring_feedback_declined_chk CHECK ((status = 'OUT_OF_SCOPE') = (declined_reason IS NOT NULL))
);
CREATE INDEX monitoring_feedback_file_idx ON machvon.monitoring_feedback (tenant_id, file_id, received_on DESC, id);
CREATE INDEX monitoring_feedback_open_idx ON machvon.monitoring_feedback (tenant_id, status, received_on, id) WHERE status IN ('RECEIVED', 'IN_REVIEW');
CREATE INDEX monitoring_feedback_owner_idx ON machvon.monitoring_feedback (tenant_id, owner_membership_id) WHERE owner_membership_id IS NOT NULL;
CREATE INDEX monitoring_feedback_responded_by_idx ON machvon.monitoring_feedback (tenant_id, responded_by) WHERE responded_by IS NOT NULL;
CREATE INDEX monitoring_feedback_closed_by_idx ON machvon.monitoring_feedback (tenant_id, closed_by) WHERE closed_by IS NOT NULL;
CREATE INDEX monitoring_feedback_created_by_idx ON machvon.monitoring_feedback (tenant_id, created_by);

ALTER TABLE machvon.monitoring_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.monitoring_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.monitoring_feedback AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.monitoring_feedback AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.monitoring_feedback FROM machvon_app;

CREATE FUNCTION machvon.monitoring_feedback_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.received_on <> OLD.received_on OR NEW.response_days <> OLD.response_days OR NEW.rule_version <> OLD.rule_version OR NEW.file_id <> OLD.file_id OR NEW.summary <> OLD.summary OR NEW.channel <> OLD.channel OR NEW.topic <> OLD.topic OR NEW.reference <> OLD.reference THEN
    RAISE EXCEPTION 'what the community said and the days the rule gave are not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER monitoring_feedback_guard BEFORE UPDATE ON machvon.monitoring_feedback FOR EACH ROW EXECUTE FUNCTION machvon.monitoring_feedback_guard();

CREATE TABLE machvon.monitoring_feedback_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('RECEIVED', 'TAKE', 'RESPOND', 'CLOSE', 'REOPEN', 'DECLINE')),
  from_status text CHECK (from_status IS NULL OR from_status IN ('RECEIVED', 'IN_REVIEW', 'RESPONDED', 'CLOSED', 'OUT_OF_SCOPE')),
  to_status text NOT NULL CHECK (to_status IN ('RECEIVED', 'IN_REVIEW', 'RESPONDED', 'CLOSED', 'OUT_OF_SCOPE')),
  actor_membership_id uuid NOT NULL,
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 4000)),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, feedback_id) REFERENCES machvon.monitoring_feedback (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX monitoring_feedback_event_feedback_idx ON machvon.monitoring_feedback_event (tenant_id, feedback_id, at, id);
CREATE INDEX monitoring_feedback_event_actor_idx ON machvon.monitoring_feedback_event (tenant_id, actor_membership_id);

ALTER TABLE machvon.monitoring_feedback_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.monitoring_feedback_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.monitoring_feedback_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.monitoring_feedback_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.monitoring_feedback_event FROM machvon_app;

COMMENT ON TABLE machvon.monitoring_feedback IS 'Feedback of the community on a project and the answer; the clock is fixed by the rule of the day it was received; the closer is not the responder.';
COMMENT ON TABLE machvon.monitoring_feedback_event IS 'Every move of a community feedback, appended and never changed.';

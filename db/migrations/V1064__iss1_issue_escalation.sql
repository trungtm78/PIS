-- Authored by hand (not generated): the escalation of an issue to the unit and to the task force (ST-ISS-004, ISS 3.2, BR-ISS-03, BR-ISS-04).
-- The table issue_escalation comes from the generated schema (V002: the target check, the level 3 check, the unique index of one open escalation
-- per level). This adds what the job and the commands rely on, so that the database holds what the application checked first:
--   * an escalation is a record: what it says never changes, its status moves only forward, and nobody deletes it;
--   * level 3 is the task force and only level 3 (a unit escalation names a unit);
--   * an escalation is made for an issue that is not closed, and a task force it names is active on the day it is made;
--   * the level of an issue only rises, until the issue is reopened and its escalation begins again;
--   * the notification that tells the receiving unit or task force is registered with the notification core.

ALTER TABLE machvon.issue_escalation
  ADD CONSTRAINT issue_escalation_force_chk CHECK ((level = 3) = (task_force_id IS NOT NULL)),
  ADD CONSTRAINT issue_escalation_reason_chk CHECK (reason = btrim(reason) AND reason <> ''),
  -- Who accepted and when come together, and an escalation that is still open has neither.
  ADD CONSTRAINT issue_escalation_accept_chk CHECK ((accepted_by IS NULL) = (accepted_at IS NULL) AND (status <> 'ACCEPTED' OR accepted_by IS NOT NULL) AND (status <> 'OPEN' OR accepted_by IS NULL));

-- An escalation is kept for good: a report on who raised what to whom and who accepted it is read years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.issue_escalation FROM machvon_app;

CREATE FUNCTION machvon.guard_issue_escalation_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  made_on date := (NEW.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  IF EXISTS (SELECT 1 FROM machvon.issue i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.issue_id AND i.status = 'CLOSED') THEN
    RAISE EXCEPTION 'a closed issue is not escalated' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'an escalation begins open' USING ERRCODE = '23514';
  END IF;
  IF NEW.task_force_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM machvon.task_force tf
     WHERE tf.tenant_id = NEW.tenant_id AND tf.id = NEW.task_force_id AND tf.status = 'ACTIVE'
       AND tf.valid_from <= made_on AND (tf.valid_until IS NULL OR tf.valid_until >= made_on)
  ) THEN
    RAISE EXCEPTION 'the task force is not active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER issue_escalation_insert_guard BEFORE INSERT ON machvon.issue_escalation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_issue_escalation_insert();

CREATE FUNCTION machvon.guard_issue_escalation_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.issue_id, NEW.level, NEW."trigger", NEW.target_unit_id, NEW.task_force_id, NEW.reason, NEW.due_at, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.issue_id, OLD.level, OLD."trigger", OLD.target_unit_id, OLD.task_force_id, OLD.reason, OLD.due_at, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an escalation says never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.accepted_by IS NOT NULL AND (NEW.accepted_by, NEW.accepted_at) IS DISTINCT FROM (OLD.accepted_by, OLD.accepted_at) THEN
    RAISE EXCEPTION 'the acceptance of an escalation is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('OPEN', 'ACCEPTED'), ('OPEN', 'RESOLVED'), ('OPEN', 'CANCELLED'), ('ACCEPTED', 'RESOLVED')
  ) THEN
    RAISE EXCEPTION 'an escalation does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER issue_escalation_guard BEFORE UPDATE ON machvon.issue_escalation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_issue_escalation_update();

-- The guard of V1063 with one more rule, repeated as a whole: the level of an issue falls only when it is reopened.
CREATE OR REPLACE FUNCTION machvon.guard_issue_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  requested jsonb;
  evidence_required boolean;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.category_version_id IS DISTINCT FROM OLD.category_version_id
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.source_module IS DISTINCT FROM OLD.source_module
     OR NEW.source_ref_id IS DISTINCT FROM OLD.source_ref_id
     OR NEW.sla_policy_id IS DISTINCT FROM OLD.sla_policy_id
     OR NEW.reported_by IS DISTINCT FROM OLD.reported_by
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.response_due_at IS DISTINCT FROM OLD.response_due_at
     OR NEW.geo_lat IS DISTINCT FROM OLD.geo_lat
     OR NEW.geo_lng IS DISTINCT FROM OLD.geo_lng
     OR NEW.geo_accuracy_m IS DISTINCT FROM OLD.geo_accuracy_m
     OR NEW.geo_consent IS DISTINCT FROM OLD.geo_consent
     OR NEW.client_operation_id IS DISTINCT FROM OLD.client_operation_id
     OR NEW.client_request_hash IS DISTINCT FROM OLD.client_request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'the origin of an issue and the deadline the SLA fixed for it never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.overdue_since IS NOT NULL AND NEW.overdue_since IS DISTINCT FROM OLD.overdue_since THEN
    RAISE EXCEPTION 'the day an issue became overdue is kept (BR-ISS-04)' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('OPEN', 'ASSIGNED'),
    ('ASSIGNED', 'IN_PROGRESS'),
    ('ASSIGNED', 'ESCALATED'),
    ('IN_PROGRESS', 'ASSIGNED'),
    ('IN_PROGRESS', 'ESCALATED'),
    ('IN_PROGRESS', 'PENDING_VERIFICATION'),
    ('ESCALATED', 'IN_PROGRESS'),
    ('PENDING_VERIFICATION', 'CLOSED'),
    ('PENDING_VERIFICATION', 'ASSIGNED'),
    ('CLOSED', 'REOPENED'),
    ('REOPENED', 'ASSIGNED')
  ) THEN
    RAISE EXCEPTION 'an issue does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    IF NEW.due_at <= OLD.due_at OR NEW.extension_count <> OLD.extension_count + 1 THEN
      RAISE EXCEPTION 'the deadline of an issue moves only later, by a counted extension' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.extension_count IS DISTINCT FROM OLD.extension_count THEN
    RAISE EXCEPTION 'an extension is counted only with the deadline it moves' USING ERRCODE = '23514';
  END IF;

  IF NEW.reopen_count IS DISTINCT FROM OLD.reopen_count
     AND NOT (OLD.status = 'CLOSED' AND NEW.status = 'REOPENED' AND NEW.reopen_count = OLD.reopen_count + 1) THEN
    RAISE EXCEPTION 'a reopening is counted only by the move from CLOSED to REOPENED' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'CLOSED' AND NEW.status = 'REOPENED' AND NEW.reopen_count <> OLD.reopen_count + 1 THEN
    RAISE EXCEPTION 'a reopening is counted' USING ERRCODE = '23514';
  END IF;

  -- The level of an issue only rises; a reopened issue begins its escalation again.
  IF NEW.escalation_level < OLD.escalation_level AND NOT (OLD.status = 'CLOSED' AND NEW.status = 'REOPENED') THEN
    RAISE EXCEPTION 'the escalation level of an issue falls only when it is reopened' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CLOSED' AND OLD.status IS DISTINCT FROM 'CLOSED' AND NEW.closed_by IS NOT NULL AND NEW.verifier_id IS NOT NULL THEN
    SELECT e.payload INTO requested
      FROM machvon.issue_event e
     WHERE e.tenant_id = NEW.tenant_id AND e.issue_id = NEW.id AND e.event_kind = 'VERIFICATION_REQUESTED'
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an issue is closed only after a request for verification' USING ERRCODE = '23514';
    END IF;
    SELECT p.require_evidence INTO evidence_required
      FROM machvon.issue_sla_policy p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.sla_policy_id;
    IF coalesce(evidence_required, true)
       AND (jsonb_typeof(requested -> 'evidence_document_version_ids') IS DISTINCT FROM 'array'
            OR jsonb_array_length(requested -> 'evidence_document_version_ids') = 0) THEN
      RAISE EXCEPTION 'the policy of this issue asks for evidence before it is closed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- The event that tells the receiving unit or task force of an escalation (docs/notification-event-types.md). The payload holds ids, the level and the
-- dates, never the title or the description of the issue.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'iss.issue.escalated.v1',
  'ISS',
  1,
  '{"type":"object","required":["tenant_id","issue_id","escalation_id","level","trigger"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"issue_id":{"type":"string","format":"uuid"},"escalation_id":{"type":"string","format":"uuid"},"level":{"type":"integer","enum":[1,2,3]},"trigger":{"type":"string","enum":["SLA_AUTO","MANUAL"]},"severity":{"type":"string","enum":["LOW","MEDIUM","HIGH","CRITICAL"]},"accept_due_at":{"type":"string"}}}'::jsonb,
  ARRAY['OPERATIONAL', 'REMINDER'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;

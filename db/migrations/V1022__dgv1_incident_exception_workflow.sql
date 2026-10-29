-- ST-DGV-003 (DGV.md F4, BR-DGV-05, BR-DGV-06): quality incidents with an assignee, an SLA and an independent verification; exceptions that are resolved or waived for a while, and a waiver that ends by itself.
-- The chain of an incident is OPEN -> ASSIGNED -> ACKNOWLEDGED -> IN_PROGRESS -> RESOLVED_PENDING_VERIFICATION -> CLOSED, back to REOPENED by the verifier or by a waiver that ended; the database says the same as the
-- application, and the history of an incident (its events) is never changed or erased. The new checks are NOT VALID: they bind every row written from now on and leave the rows of an older database as they are (before this
-- story nothing resolved or closed an incident, so there are none to mend; a row that is mended later is checked then).

ALTER TABLE machvon.quality_incident ADD COLUMN resolved_at timestamptz;
ALTER TABLE machvon.quality_incident ADD COLUMN closed_at timestamptz;
ALTER TABLE machvon.quality_incident ADD COLUMN sla_breached_at timestamptz;
ALTER TABLE machvon.quality_incident
  ADD CONSTRAINT quality_incident_status_chk CHECK (status IN ('OPEN', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION', 'CLOSED', 'REOPENED')) NOT VALID,
  ADD CONSTRAINT quality_incident_severity_chk CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')) NOT VALID,
  ADD CONSTRAINT quality_incident_assigned_chk CHECK (status IN ('OPEN', 'REOPENED') OR assignee_user_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT quality_incident_resolved_chk CHECK (status NOT IN ('RESOLVED_PENDING_VERIFICATION', 'CLOSED') OR (length(btrim(coalesce(root_cause, ''))) >= 10 AND length(btrim(coalesce(remediation, ''))) >= 10 AND resolved_at IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT quality_incident_closed_chk CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)) NOT VALID;

ALTER TABLE machvon.quality_incident_event DROP CONSTRAINT quality_incident_event_event_kind_check;
ALTER TABLE machvon.quality_incident_event
  ADD CONSTRAINT quality_incident_event_kind_chk CHECK (event_kind IN ('CREATED', 'ASSIGNED', 'STATUS_CHANGED', 'COMMENTED', 'REOPENED', 'VERIFIED', 'SLA_BREACHED'));
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.quality_incident_event FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.quality_incident FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.quality_exception FROM machvon_app;

CREATE FUNCTION machvon.guard_quality_incident() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.rule_id, NEW.run_id, NEW.dataset_version_id, NEW.owner_id, NEW.severity, NEW.created_at) IS DISTINCT FROM (OLD.rule_id, OLD.run_id, OLD.dataset_version_id, OLD.owner_id, OLD.severity, OLD.created_at) THEN
    RAISE EXCEPTION 'what a quality incident is about is not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('OPEN', 'ASSIGNED'), ('REOPENED', 'ASSIGNED'), ('ASSIGNED', 'ASSIGNED'), ('ACKNOWLEDGED', 'ASSIGNED'), ('IN_PROGRESS', 'ASSIGNED'),
                   ('ASSIGNED', 'ACKNOWLEDGED'), ('REOPENED', 'ACKNOWLEDGED'), ('ACKNOWLEDGED', 'IN_PROGRESS'), ('IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION'),
                   ('RESOLVED_PENDING_VERIFICATION', 'CLOSED'), ('RESOLVED_PENDING_VERIFICATION', 'REOPENED'), ('CLOSED', 'REOPENED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'a quality incident does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', DETAIL = 'INCIDENT_STATE_INVALID';
  END IF;
  -- A closed incident is read as it was closed, unless it is reopened.
  IF OLD.status = 'CLOSED' AND NEW.status = 'CLOSED' AND (NEW.root_cause, NEW.remediation, NEW.assignee_user_id, NEW.verified_by, NEW.verified_at, NEW.closed_at) IS DISTINCT FROM (OLD.root_cause, OLD.remediation, OLD.assignee_user_id, OLD.verified_by, OLD.verified_at, OLD.closed_at) THEN
    RAISE EXCEPTION 'a closed quality incident is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'REOPENED' AND OLD.status <> 'REOPENED' AND NEW.reopened_count <= OLD.reopened_count THEN
    RAISE EXCEPTION 'a reopened quality incident is counted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER quality_incident_guard BEFORE UPDATE ON machvon.quality_incident
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_quality_incident();

-- Exceptions: OPEN until a person resolves or waives it; the decision is written once. A waiver that ended is followed by a new OPEN exception that points at it (reopened_from_id); the waived one stays as it was.
ALTER TABLE machvon.quality_exception
  ADD CONSTRAINT quality_exception_status_chk CHECK (status IN ('OPEN', 'RESOLVED', 'WAIVED')) NOT VALID,
  ADD CONSTRAINT quality_exception_decision_chk CHECK ((status = 'OPEN' AND decision IS NULL AND decided_by IS NULL AND decided_at IS NULL) OR (status <> 'OPEN' AND decision = status AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND length(btrim(coalesce(waiver_reason, ''))) >= 10)) NOT VALID,
  ADD CONSTRAINT quality_exception_resolved_chk CHECK (status <> 'RESOLVED' OR waiver_expires_at IS NULL) NOT VALID,
  ADD CONSTRAINT quality_exception_waiver_max_chk CHECK (waiver_expires_at IS NULL OR decided_at IS NULL OR waiver_expires_at <= decided_at + interval '180 days') NOT VALID;
CREATE UNIQUE INDEX quality_exception_reopened_uq ON machvon.quality_exception (tenant_id, reopened_from_id) WHERE reopened_from_id IS NOT NULL;

CREATE FUNCTION machvon.guard_quality_exception() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.run_id, NEW.record_reference, NEW.owner_id, NEW.rule_version_id, NEW.incident_id, NEW.reopened_from_id, NEW.created_at) IS DISTINCT FROM (OLD.run_id, OLD.record_reference, OLD.owner_id, OLD.rule_version_id, OLD.incident_id, OLD.reopened_from_id, OLD.created_at) THEN
    RAISE EXCEPTION 'what a quality exception is about is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'OPEN' AND (NEW.status, NEW.decision, NEW.decided_by, NEW.decided_at, NEW.waiver_expires_at, NEW.waiver_reason) IS DISTINCT FROM (OLD.status, OLD.decision, OLD.decided_by, OLD.decided_at, OLD.waiver_expires_at, OLD.waiver_reason) THEN
    RAISE EXCEPTION 'the decision on a quality exception is written once' USING ERRCODE = '23514', DETAIL = 'EXCEPTION_STATE_INVALID';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER quality_exception_guard BEFORE UPDATE ON machvon.quality_exception
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_quality_exception();

-- The reminders the notification service knows: an incident past its SLA (to the owner of the dataset) and a waiver that ended (to the handler of the incident). Payloads name ids, never the records.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES
  (gen_random_uuid(), 'dgv.incident.sla_breached.v1', 'DGV', 1,
   '{"type":"object","required":["tenant_id","incident_id","severity","due_at"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"incident_id":{"type":"string","format":"uuid"},"dataset_id":{"type":["string","null"],"format":"uuid"},"severity":{"type":"string"},"due_at":{"type":"string"},"status":{"type":"string"},"notification":{"type":"object"}}}'::jsonb,
   ARRAY['REMINDER', 'OPERATIONAL'], 'INTERNAL', 'Active'),
  (gen_random_uuid(), 'dgv.exception.reopened.v1', 'DGV', 1,
   '{"type":"object","required":["tenant_id","exception_id","reopened_from_id"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"exception_id":{"type":"string","format":"uuid"},"reopened_from_id":{"type":"string","format":"uuid"},"incident_id":{"type":["string","null"],"format":"uuid"},"notification":{"type":"object"}}}'::jsonb,
   ARRAY['REMINDER', 'OPERATIONAL'], 'INTERNAL', 'Active')
ON CONFLICT (event_type, schema_version) DO NOTHING;

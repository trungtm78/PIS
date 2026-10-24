-- Authored by hand (not generated): the lifecycle of an issue (ST-ISS-002, ISS 3.1 and 4, BR-ISS-02, BR-ISS-04, BR-ISS-06, BR-ISS-07).
-- The tables issue and issue_event come from the generated schema (V002, with the extension columns of ISS); this adds what the lifecycle
-- relies on: the offline create that cannot make two issues, one open issue per source, the location that exists only with consent, the
-- state machine and the unchanging parts of an issue held by the database whatever the application did, and the kept-for-good grants.

-- An offline phone sends the same create until the network answers. The operation id it generates belongs to the person who reported, and
-- the hash of what was asked tells a retry (the same request) from a different request under the same id.
ALTER TABLE machvon.issue
  ADD COLUMN client_operation_id uuid,
  ADD COLUMN client_request_hash char(64);

ALTER TABLE machvon.issue
  ADD CONSTRAINT issue_client_operation_chk CHECK ((client_operation_id IS NULL) = (client_request_hash IS NULL));
CREATE UNIQUE INDEX issue_client_operation_uq ON machvon.issue (tenant_id, reported_by, client_operation_id) WHERE client_operation_id IS NOT NULL;

-- BR-ISS-07: at most one issue that is not closed for each (source_module, source_ref_id). A manual issue has no source object.
ALTER TABLE machvon.issue
  ADD CONSTRAINT issue_source_chk CHECK ((source_module = 'MANUAL') = (source_ref_id IS NULL));
CREATE UNIQUE INDEX issue_open_source_uq ON machvon.issue (tenant_id, source_module, source_ref_id) WHERE source_ref_id IS NOT NULL AND status <> 'CLOSED';

-- Every issue is an issue of somebody, about something, with a deadline: the parts that the SLA and the scope of a reader stand on.
ALTER TABLE machvon.issue
  ADD CONSTRAINT issue_core_chk CHECK (
    code IS NOT NULL AND title IS NOT NULL AND description IS NOT NULL AND owner_unit_id IS NOT NULL AND sla_policy_id IS NOT NULL
    AND opened_at IS NOT NULL AND response_due_at IS NOT NULL AND reported_by IS NOT NULL
  ),
  ADD CONSTRAINT issue_code_chk CHECK (code ~ '^VM-[0-9]{4}-[0-9]{6}$'),
  ADD CONSTRAINT issue_due_chk CHECK (response_due_at <= due_at AND due_at >= opened_at);

-- BR-ISS-06: the position is a pair, it is a position on the earth, its accuracy has no meaning without it, and it exists only with consent
-- (issue_geo_consent_chk of the generated schema). The accuracy is a distance.
ALTER TABLE machvon.issue
  ADD CONSTRAINT issue_geo_chk CHECK (
    (geo_lat IS NULL) = (geo_lng IS NULL)
    AND (geo_accuracy_m IS NULL OR geo_lat IS NOT NULL)
    AND (geo_lat IS NULL OR (geo_lat BETWEEN -90 AND 90 AND geo_lng BETWEEN -180 AND 180))
    AND (geo_accuracy_m IS NULL OR geo_accuracy_m >= 0)
  );

-- The kind of event that a unit transfer writes (UAT-AC350: the transfer is an issue_event row). The design list had no kind for it.
ALTER TABLE machvon.issue_event DROP CONSTRAINT issue_event_event_kind_check;
ALTER TABLE machvon.issue_event
  ADD CONSTRAINT issue_event_event_kind_check CHECK (event_kind IN (
    'CREATED', 'ASSIGNED', 'REASSIGNED', 'TRANSFERRED', 'STARTED', 'COMMENTED', 'EVIDENCE_ADDED', 'EXTENSION_REQUESTED', 'EXTENDED', 'ESCALATED',
    'ESCALATION_ACCEPTED', 'VERIFICATION_REQUESTED', 'CLOSED', 'REOPENED', 'SLA_BREACHED', 'SOURCE_UPDATED'
  ));

-- An issue is kept for good: the history of who was responsible and when it fell due is read years later, in a report and in an inspection.
REVOKE DELETE, TRUNCATE ON TABLE machvon.issue FROM machvon_app;

-- The timeline is a record, not a document: nothing in it is rewritten or removed, by the runtime role (revoked in V002) or by anything else.
CREATE FUNCTION machvon.guard_issue_event() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the timeline of an issue is append-only: record a correction as a new event' USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER issue_event_guard BEFORE UPDATE OR DELETE ON machvon.issue_event
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_issue_event();

-- The state machine of ISS 4 and what an issue never changes. Every write of the status goes through a command, and a statement that
-- bypassed the commands cannot take an issue anywhere the machine does not go, cannot move the deadline that the SLA fixed at creation,
-- cannot rewrite where the issue came from or where it was reported, and cannot take back the day it became overdue (BR-ISS-04).
-- The deadline (due_at) moves only by an extension and the owner unit only by a transfer: both are commands with their own event.
CREATE FUNCTION machvon.guard_issue_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
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
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER issue_guard BEFORE UPDATE ON machvon.issue
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_issue_update();

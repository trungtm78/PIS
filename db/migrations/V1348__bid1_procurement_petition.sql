-- Authored by hand (not generated): the petitions of contractors about the selection of a contractor (ST-BID-007, BID 3 F7, BR-BID-14).
-- The table procurement_petition comes from the generated schema (V002, with the foreign keys to the package, the contractor and the two documents). This adds what the commands rely on:
-- the days the deadline was counted with and the version of the rule data they came from (a petition keeps the rule it was counted by), when it was answered, when the reminder of an
-- overdue petition was sent, the shape of an answered petition, one petition for each document that lodges it, the edges of the status, and the notification event of the reminder.

ALTER TABLE machvon.procurement_petition
  ADD COLUMN days_applied integer,
  ADD COLUMN rule_version_id uuid,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN overdue_notified_at timestamptz;

-- A petition is counted by a rule, and the last day to answer is never before the day it was received.
ALTER TABLE machvon.procurement_petition
  ADD CONSTRAINT procurement_petition_basis_chk CHECK (days_applied IS NOT NULL AND days_applied BETWEEN 1 AND 366 AND rule_version_id IS NOT NULL),
  ADD CONSTRAINT procurement_petition_due_chk CHECK (due_on >= received_on);

-- A petition that was answered, or passed on to the level above, says who answered it, when and on which document; a petition that waits has none of the three.
ALTER TABLE machvon.procurement_petition
  ADD CONSTRAINT procurement_petition_answered_chk CHECK (
    CASE WHEN status IN ('RESOLVED', 'ESCALATED') THEN resolution_document_id IS NOT NULL AND handled_by IS NOT NULL AND resolved_at IS NOT NULL
         WHEN status IN ('RECEIVED', 'PROCESSING') THEN resolution_document_id IS NULL AND resolved_at IS NULL
         ELSE true END
  );

-- A petition is lodged by one document: logging the same paper twice is one petition.
CREATE UNIQUE INDEX procurement_petition_document_uq ON machvon.procurement_petition (tenant_id, petition_document_id) WHERE status <> 'WITHDRAWN';

-- Every identifier column is indexed with the tenant (the catalogue of the schema says so); the rule a petition was counted by is one.
CREATE INDEX procurement_petition_rule_version_id_idx ON machvon.procurement_petition (tenant_id, rule_version_id);

-- The job that raises the reminder looks at the petitions that wait, by the day their time is up.
CREATE INDEX procurement_petition_open_due_idx ON machvon.procurement_petition (tenant_id, due_on) WHERE status IN ('RECEIVED', 'PROCESSING');

-- What a petition says never changes: the package, the contractor, the kind, the days, the deadline and the paper that lodges it stay as they were written. Only its status moves:
-- a petition that waits is answered (RESOLVED, or ESCALATED to the level above), a petition passed on is then answered by that level, and an answered or withdrawn petition is kept as it is.
CREATE FUNCTION machvon.guard_procurement_petition() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.package_id, NEW.contractor_id, NEW.petition_kind, NEW.received_on, NEW.due_on, NEW.petition_document_id, NEW.days_applied, NEW.rule_version_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.package_id, OLD.contractor_id, OLD.petition_kind, OLD.received_on, OLD.due_on, OLD.petition_document_id, OLD.days_applied, OLD.rule_version_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a petition says never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('RESOLVED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'an answered petition is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('RECEIVED', 'PROCESSING'), ('RECEIVED', 'RESOLVED'), ('RECEIVED', 'ESCALATED'), ('RECEIVED', 'WITHDRAWN'),
        ('PROCESSING', 'RESOLVED'), ('PROCESSING', 'ESCALATED'), ('PROCESSING', 'WITHDRAWN'),
        ('ESCALATED', 'RESOLVED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'PETITION_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER procurement_petition_guard BEFORE UPDATE ON machvon.procurement_petition
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_procurement_petition();

-- The petitions of a package are part of its dossier: no command deletes one, and the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.procurement_petition FROM machvon_app;

-- The reminder that goes to the people who handle the petitions of a package when the last day of the deadline has passed without an answer. The payload names the petition and
-- the package, never the contractor or the words of the petition.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'bid.petition.overdue.v1',
  'BID',
  1,
  '{"type":"object","required":["tenant_id","petition_id","package_id","petition_kind","due_on","days_overdue"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"petition_id":{"type":"string","format":"uuid"},"package_id":{"type":"string","format":"uuid"},"petition_kind":{"type":"string","enum":["PROCESS","RESULT"]},"due_on":{"type":"string","format":"date"},"days_overdue":{"type":"integer","minimum":1}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;
